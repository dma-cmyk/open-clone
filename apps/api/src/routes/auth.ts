// アカウント認証（登録/ログイン/ログアウト/セッション/TOTP/リカバリー/step-up）。
// 認証情報の保存形式・TOTP は services/account/* に集約し、ルートは入力検証とレスポンス整形のみ行う。

import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import {
  ApiError,
  ErrorCode,
  ok,
  RATE_LIMITS,
  registerRequestSchema,
  loginRequestSchema,
  totpEnableRequestSchema,
  totpDisableRequestSchema,
  recoveryRequestSchema,
  stepUpRequestSchema,
  githubLoginCallbackSchema,
  passwordResetRequestSchema,
  operatorPasswordResetRequestSchema,
  PASSWORD_RESET_FAILURE_WINDOW_SECONDS,
  PASSWORD_RESET_MAX_FAILURES,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  ulid,
  type SiteSettings,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { writeAudit } from "../lib/audit";
import { normalizeEmail } from "../lib/email";
import { requireAuth } from "../lib/middleware/auth";
import { requireTurnstile } from "../lib/middleware/turnstile";
import { requestOrigin } from "../lib/middleware/origin";
import { hashPassword, verifyPassword } from "../services/account/password";
import { createSession, revokeAllSessions, revokeSession } from "../services/account/session";
import { getTotpRow, verifyTotpCode, verifyTotpForAccount, beginTotpSetup, enableTotp, disableTotp, getTotpStatus, resetTotp } from "../services/account/totp";
import {
  consumeRecoveryCode,
  countRemainingRecoveryCodes,
  generateRecoveryCodes,
  hasUnusedRecoveryCode,
} from "../services/account/recovery";
import { findActiveSiteSuspension } from "../services/account/suspension";
import { getSiteSettings } from "../services/account/site-config";
import {
  accountAttemptKey,
  attemptKey,
  cleanupOldAttempts,
  countAttemptsSince,
  recordAttempt,
} from "../services/account/attempts";
import { grantStepUp, getStepUpExpiry } from "../services/account/step-up";
import {
  cleanupPasswordResetFailures,
  consumePasswordResetToken,
  countPasswordResetFailures,
  findPasswordResetToken,
  passwordResetAttemptKey,
  passwordResetTokenState,
  recordPasswordResetFailure,
} from "../services/account/password-reset";
import { completeGithubLogin, githubLoginAvailable, startGithubLogin } from "../services/account/github-login";
import { accountDto, buildAuthSession, getAccountRow, type AccountRow } from "../services/account/view";
import { transferDeviceOwnedPlugins } from "../services/plugins/device-transfer";

const app = new Hono<AppEnv>();

function sessionCookieOptions(env: AppEnv["Bindings"]) {
  return {
    httpOnly: true,
    secure: env.ENVIRONMENT === "production",
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86_400,
  };
}

function auditActor(role: AccountRow["role"]): "owner" | "special_admin" | "account" {
  if (role === "owner") return "owner";
  if (role === "special_admin") return "special_admin";
  return "account";
}

const LOGIN_ACCOUNT_WINDOW_SECONDS = 15 * 60;
const LOGIN_ACCOUNT_TURNSTILE_THRESHOLD = 10;

function turnstileNeeded(settings: SiteSettings, failures: number, accountFailures = 0): boolean {
  const mode = settings["security.require_turnstile"];
  if (mode === "always") return true;
  if (mode === "off") return false;
  return failures >= 3 || accountFailures >= LOGIN_ACCOUNT_TURNSTILE_THRESHOLD;
}

function requireTurnstileToken(c: {
  req: { header(name: string): string | undefined };
  get?(key: never): unknown;
}): void {
  if (c.get?.("turnstileVerified" as never) === true) return;
  if (!c.req.header("x-turnstile-token")) {
    throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile 認証が必要です");
  }
}

async function loadAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  // 大文字・小文字の違いで同じアカウントを引けるようにする（試行制限の鍵と同じ正規化）。
  // 既存データに大文字違いの重複があっても、入力と完全一致する行を優先する（既存のログインを壊さない）。
  return db
    .prepare(
      `SELECT id, name, email, password_hash, role, status, created_at FROM accounts
       WHERE lower(email) = ?
       ORDER BY (email = ?) DESC, created_at ASC
       LIMIT 1`,
    )
    .bind(normalizeEmail(email), email.trim())
    .first<AccountRow>();
}

// --- 登録 -----------------------------------------------------------------

app.post("/register", requireTurnstile({ required: false }), async (c) => {
  const body = registerRequestSchema.parse(await c.req.json());
  const ctx = getReqCtx(c);
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const settings = await getSiteSettings(db);

  if (!settings["registration.open"]) {
    throw ApiError.forbidden("現在、新規登録を停止しています");
  }

  const ipKey = await attemptKey(ctx.device.ipHash, "*");
  const emailKey = await attemptKey(ctx.device.ipHash, body.email);
  const [ipRegistrations, emailFailures] = await Promise.all([
    countAttemptsSince(db, ["register"], ipKey, now - 86_400),
    countAttemptsSince(db, ["login_failed", "register"], emailKey, now - 86_400),
  ]);

  if (settings["security.require_turnstile"] === "always" || (settings["security.require_turnstile"] === "auto" && emailFailures >= 3)) {
    requireTurnstileToken(c);
  }
  const registerMax = Number(c.env.RATE_LIMIT_REGISTER_MAX ?? RATE_LIMITS.register.max) || RATE_LIMITS.register.max;
  if (ipRegistrations >= registerMax) {
    throw ApiError.rateLimited("新規登録の上限に達しました。しばらく待ってから再試行してください");
  }

  // 照合の正規化（小文字化）に合わせ、大文字・小文字だけ違う二重登録を防ぐ
  // （二重に存在すると、どちらにログインするか不定になる）。
  const existing = await db
    .prepare("SELECT id FROM accounts WHERE lower(email) = ?")
    .bind(normalizeEmail(body.email))
    .first<{ id: string }>();
  if (existing) throw ApiError.conflict("このメールアドレスは既に登録されています");

  const accountId = ulid();
  const passwordHash = await hashPassword(body.password);
  await db.batch([
    db
      .prepare(
        "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, 'user', 'active', ?)",
      )
      .bind(accountId, body.name, body.email, passwordHash, now),
    db.prepare("INSERT INTO account_profiles (account_id, bio, updated_at) VALUES (?, '', ?)").bind(accountId, now),
  ]);
  await recordAttempt(db, "register", ipKey);
  await recordAttempt(db, "register", emailKey);

  const session = await createSession(db, accountId, c.req.header("user-agent") ?? null);
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c.env));
  // 同じ端末の所有プラグインをアカウントへ引き継ぐ（報告 40 設計）。
  // 同期で実行する: ログイン直後の「自分のプラグイン」一覧に反映されるようにするため。
  // 失敗しても登録自体は止めない（引き継ぎは次のログインで再試行できる）。
  try {
    await transferDeviceOwnedPlugins(db, ctx.device.deviceHash, accountId);
  } catch {
    // 引き継ぎ失敗は登録を落とさない
  }
  const row = await getAccountRow(db, accountId);
  if (!row) throw new Error("Failed to load created account");
  await writeAudit(db, {
    actorType: "account",
    actorId: accountId,
    action: "auth.register",
    target: accountId,
  });
  c.executionCtx.waitUntil(cleanupOldAttempts(db));

  return c.json(
    ok({
      account: accountDto(row),
      expiresAt: session.expiresAt,
      totpSetupRequired: false,
    }),
    201,
  );
});

// --- ログイン/ログアウト/セッション -------------------------------------

app.post("/login", requireTurnstile({ required: false }), async (c) => {
  const body = loginRequestSchema.parse(await c.req.json());
  const ctx = getReqCtx(c);
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const settings = await getSiteSettings(db);
  const keyHash = await attemptKey(ctx.device.ipHash, body.email);
  const accountKeyHash = await accountAttemptKey(c.env.ID_SALT, body.email);
  const [failures, accountFailures] = await Promise.all([
    countAttemptsSince(db, ["login_failed"], keyHash, now - RATE_LIMITS.login.windowSeconds),
    countAttemptsSince(db, ["login_failed"], accountKeyHash, now - LOGIN_ACCOUNT_WINDOW_SECONDS),
  ]);

  if (failures >= RATE_LIMITS.login.max) {
    throw ApiError.rateLimited("ログイン試行が多すぎます。しばらく待ってから再試行してください");
  }
  if (turnstileNeeded(settings, failures, accountFailures)) requireTurnstileToken(c);

  const account = await loadAccountByEmail(db, body.email);
  const passwordOk = await verifyPassword(body.password, account?.password_hash ?? null);

  if (!account || !passwordOk) {
    await Promise.all([
      recordAttempt(db, "login_failed", keyHash, account?.id ?? null),
      recordAttempt(db, "login_failed", accountKeyHash, account?.id ?? null),
    ]);
    c.executionCtx.waitUntil(cleanupOldAttempts(db));
    throw ApiError.unauthorized("メールアドレスまたはパスワードが正しくありません");
  }

  const suspension = await findActiveSiteSuspension(db, {
    accountId: account.id,
    email: account.email,
    deviceHash: ctx.device.deviceHash,
  });
  if (account.status !== "active" || suspension) {
    await Promise.all([
      recordAttempt(db, "login_failed", keyHash, account.id),
      recordAttempt(db, "login_failed", accountKeyHash, account.id),
    ]);
    throw new ApiError(403, ErrorCode.BANNED, "このアカウントは利用停止中です");
  }

  const totpRow = await getTotpRow(db, account.id);
  const totpEnabled = totpRow?.verified === 1;
  if (totpEnabled) {
    if (!body.totpCode) {
      throw new ApiError(401, ErrorCode.TOTP_REQUIRED, "TOTP コードを入力してください", { totpRequired: true });
    }
    const result = await verifyTotpCode(db, totpRow, c.env.ENC_KEY, body.totpCode);
    if (!result.ok) {
      if (result.reason === "locked") {
        await recordAttempt(db, "totp_failed", keyHash, account.id);
        throw new ApiError(429, ErrorCode.TOTP_LOCKED, "TOTP の失敗回数が上限に達しました。15分後に再試行してください", {
          lockedUntil: result.lockedUntil,
        });
      }
      await recordAttempt(db, "totp_failed", keyHash, account.id);
      throw new ApiError(401, ErrorCode.TOTP_INVALID, "TOTP コードが正しくありません", {
        remaining: result.remaining,
      });
    }
  }

  const session = await createSession(db, account.id, c.req.header("user-agent") ?? null);
  if (totpEnabled) await grantStepUp(db, session.tokenHash, account.id);
  await recordAttempt(db, "login_ok", keyHash, account.id);
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c.env));
  // 同じ端末の所有プラグインをアカウントへ引き継ぐ（報告 40 設計）。
  // 同期で実行する: ログイン直後の「自分のプラグイン」一覧に反映されるようにするため。
  // 失敗してもログイン自体は止めない（引き継ぎは次のログインで再試行できる）。
  try {
    await transferDeviceOwnedPlugins(db, ctx.device.deviceHash, account.id);
  } catch {
    // 引き継ぎ失敗はログインを落とさない
  }
  await writeAudit(db, {
    actorType: auditActor(account.role),
    actorId: account.id,
    action: "auth.login",
    target: account.id,
  });
  c.executionCtx.waitUntil(cleanupOldAttempts(db));

  return c.json(
    ok({
      account: accountDto(account),
      expiresAt: session.expiresAt,
      totpSetupRequired: totpRow?.required === 1 && !totpEnabled,
    }),
  );
});

app.post("/logout", async (c) => {
  const ctx = getReqCtx(c);
  if (ctx.session) await revokeSession(c.env.DB, ctx.session.tokenHash);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json(ok({ loggedOut: true }));
});

app.get("/session", async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) return c.json(ok({ authenticated: false as const }));
  const view = await buildAuthSession(c.env.DB, ctx.session);
  return c.json(ok({ authenticated: true as const, ...view }));
});

// --- TOTP -----------------------------------------------------------------

app.get("/totp/status", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  return c.json(ok(await getTotpStatus(c.env.DB, ctx.session.account.id)));
});

app.post("/totp/setup", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const result = await beginTotpSetup(c.env.DB, ctx.session.account.id, c.env.ENC_KEY, ctx.session.account.name);
  return c.json(ok(result));
});

app.post("/totp/enable", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const body = totpEnableRequestSchema.parse(await c.req.json());
  const result = await enableTotp(c.env.DB, ctx.session.account.id, c.env.ENC_KEY, body.code);
  await writeAudit(c.env.DB, {
    actorType: auditActor(ctx.session.account.role),
    actorId: ctx.session.account.id,
    action: "auth.totp_enabled",
    target: ctx.session.account.id,
  });
  return c.json(ok(result));
});

app.post("/totp/disable", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const body = totpDisableRequestSchema.parse(await c.req.json());
  await disableTotp(c.env.DB, ctx.session.account.id, c.env.ENC_KEY, body.code);
  await writeAudit(c.env.DB, {
    actorType: auditActor(ctx.session.account.role),
    actorId: ctx.session.account.id,
    action: "auth.totp_disabled",
    target: ctx.session.account.id,
  });
  return c.json(ok({ disabled: true }));
});

app.post("/recovery-codes/regenerate", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const db = c.env.DB;
  // TOTP を設定していない人も復旧コードを作れるようにする（設計 50 ①）。
  // 従来どおり step-up（TOTP 再認証）が有効ならそのまま、無ければ現在のパスワードの再入力を求める。
  // どちらも「ログイン済みセッションだけでは作れない」ための確認で、成功したら以下は同じ。
  const stepUpExpiry = await getStepUpExpiry(db, ctx.session.tokenHash);
  let verifiedBy: "step_up" | "password" = "step_up";
  if (stepUpExpiry === null) {
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length === 0) {
      throw new ApiError(
        403,
        ErrorCode.STEP_UP_REQUIRED,
        "この操作には再認証（TOTP コードまたは現在のパスワード）が必要です",
      );
    }
    const row = await getAccountRow(db, ctx.session.account.id);
    if (!(await verifyPassword(password, row?.password_hash ?? null))) {
      // 誤ったパスワードは STEP_UP_REQUIRED と区別する（UI が不要な TOTP ダイアログを出さない）。
      throw ApiError.validation("現在のパスワードが正しくありません");
    }
    verifiedBy = "password";
  }
  const recoveryCodes = await generateRecoveryCodes(db, ctx.session.account.id);
  await writeAudit(db, {
    actorType: auditActor(ctx.session.account.role),
    actorId: ctx.session.account.id,
    action: "auth.recovery_codes_regenerated",
    target: ctx.session.account.id,
    detail: { verifiedBy },
  });
  return c.json(ok({ recoveryCodes }));
});

// --- リカバリーコードによる復旧 -----------------------------------------

app.post("/recovery", requireTurnstile({ required: false }), async (c) => {
  const body = recoveryRequestSchema.parse(await c.req.json());
  const ctx = getReqCtx(c);
  const db = c.env.DB;
  const keyHash = await attemptKey(ctx.device.ipHash, body.email);
  const now = Math.floor(Date.now() / 1000);
  const failures = await countAttemptsSince(db, ["login_failed"], keyHash, now - RATE_LIMITS.login.windowSeconds);
  if (failures >= RATE_LIMITS.login.max) {
    throw ApiError.rateLimited("試行回数が多すぎます。しばらく待ってから再試行してください");
  }

  const account = await loadAccountByEmail(db, body.email);
  const passwordOk = await verifyPassword(body.password, account?.password_hash ?? null);
  if (!account || !passwordOk) {
    await recordAttempt(db, "login_failed", keyHash, account?.id ?? null);
    throw ApiError.unauthorized("メールアドレスまたはパスワードが正しくありません");
  }
  if (account.status !== "active") {
    throw new ApiError(403, ErrorCode.BANNED, "このアカウントは利用停止中です");
  }

  const consumed = await consumeRecoveryCode(db, account.id, body.code);
  if (!consumed) {
    await recordAttempt(db, "login_failed", keyHash, account.id);
    throw new ApiError(400, ErrorCode.TOTP_INVALID, "リカバリーコードが正しくありません");
  }

  await resetTotp(db, account.id, { keepRecoveryCodes: true });
  await revokeAllSessions(db, account.id);
  const session = await createSession(db, account.id, c.req.header("user-agent") ?? null);
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c.env));
  const remaining = await countRemainingRecoveryCodes(db, account.id);
  const totpRow = await getTotpRow(db, account.id);
  await writeAudit(db, {
    actorType: auditActor(account.role),
    actorId: account.id,
    action: "auth.recovery_used",
    target: account.id,
    detail: { remaining },
  });
  return c.json(
    ok({
      account: accountDto(account),
      expiresAt: session.expiresAt,
      totpSetupRequired: totpRow?.required === 1,
      recoveryRemaining: remaining,
    }),
  );
});

// --- パスワードを忘れたときの復旧（設計 50） ----------------------------
// ① 復旧コードでの再設定: メール + 復旧コード + 新しいパスワード。TOTP の有無を問わない。
//    ロボット確認は毎回必須（30 分省略の対象外）。失敗はログイン失敗と同じ枠で数える。
//    アカウントの有無・利用停止は、正しい復旧コードを示した後にだけ区別する（列挙対策）。
// ② 運営が発行した 1 回限りの URL: トークン + 新しいパスワード（有効期限・単回使用）。

app.post("/password-reset", requireTurnstile({ required: true }), async (c) => {
  const body = passwordResetRequestSchema.parse(await c.req.json());
  const ctx = getReqCtx(c);
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const emailKey = await attemptKey(ctx.device.ipHash, body.email);
  const loginFailures = await countAttemptsSince(db, ["login_failed"], emailKey, now - RATE_LIMITS.login.windowSeconds);
  if (loginFailures >= RATE_LIMITS.login.max) {
    throw ApiError.rateLimited("試行回数が多すぎます。しばらく待ってから再試行してください");
  }

  const account = await loadAccountByEmail(db, body.email);
  // 対象単位の試行制限は「正規化したメール」で数える（アカウント id とメールで鍵が分裂しない）。
  // 大文字・小文字を変えた連打も同じ枠に入り、同じアカウントへの総当たりで枠を迂回できない。
  const targetKey = await passwordResetAttemptKey(c.env.ID_SALT, body.email);
  const resetFailures = await countPasswordResetFailures(db, targetKey, now - PASSWORD_RESET_FAILURE_WINDOW_SECONDS);
  if (resetFailures >= PASSWORD_RESET_MAX_FAILURES) {
    throw ApiError.rateLimited("試行回数が多すぎます。しばらく待ってから再試行してください");
  }

  const reject = async (): Promise<never> => {
    // 存在しないメールと誤ったコードを同じエラー・同じ処理経路にする。
    await recordAttempt(db, "login_failed", emailKey, account?.id ?? null);
    await recordPasswordResetFailure(db, targetKey, ulid(), now);
    c.executionCtx.waitUntil(cleanupOldAttempts(db));
    c.executionCtx.waitUntil(cleanupPasswordResetFailures(db, now));
    throw new ApiError(
      400,
      ErrorCode.RESET_INVALID,
      "メールアドレスまたは復旧コードが正しくありません",
    );
  };

  if (!account) return reject();
  if (!(await hasUnusedRecoveryCode(db, account.id, body.code))) return reject();

  // ここから先は復旧コードの持ち主だけが通る。利用停止はこの順で判定する（誤コードで状態を探れない）。
  const suspension = await findActiveSiteSuspension(db, {
    accountId: account.id,
    email: account.email,
    deviceHash: ctx.device.deviceHash,
  });
  if (account.status !== "active" || suspension) {
    throw new ApiError(403, ErrorCode.BANNED, "このアカウントは利用停止中です");
  }

  if (!(await consumeRecoveryCode(db, account.id, body.code))) return reject();

  const passwordHash = await hashPassword(body.newPassword);
  await db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").bind(passwordHash, account.id).run();
  const revoked = await revokeAllSessions(db, account.id);
  const remaining = await countRemainingRecoveryCodes(db, account.id);
  // TOTP は残す（TOTP を設定している人は次のログインでコードが要る＝復旧コードだけでは乗っ取れない）。
  await writeAudit(db, {
    actorType: auditActor(account.role),
    actorId: account.id,
    action: "auth.password_reset_recovery",
    target: account.id,
    detail: { recoveryRemaining: remaining, revokedSessions: revoked },
  });
  c.executionCtx.waitUntil(cleanupOldAttempts(db));
  c.executionCtx.waitUntil(cleanupPasswordResetFailures(db, now));
  return c.json(ok({ reset: true as const, recoveryRemaining: remaining }));
});

app.post("/password-reset/operator", requireTurnstile({ required: true }), async (c) => {
  const body = operatorPasswordResetRequestSchema.parse(await c.req.json());
  const ctx = getReqCtx(c);
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  // トークンは 32 バイト乱数で推測は不可能だが、IP 単位の試行も抑える（失敗はすべて同じ案内）。
  const ipKey = await passwordResetAttemptKey(c.env.ID_SALT, `operator|${ctx.device.ipHash}`);
  const failures = await countPasswordResetFailures(db, ipKey, now - PASSWORD_RESET_FAILURE_WINDOW_SECONDS);
  if (failures >= PASSWORD_RESET_MAX_FAILURES) {
    throw ApiError.rateLimited("試行回数が多すぎます。しばらく待ってから再試行してください");
  }
  const reject = async (): Promise<never> => {
    await recordPasswordResetFailure(db, ipKey, ulid(), now);
    c.executionCtx.waitUntil(cleanupPasswordResetFailures(db, now));
    throw new ApiError(400, ErrorCode.RESET_INVALID, "この URL は無効か、有効期限が切れています");
  };

  const token = await findPasswordResetToken(db, body.token);
  if (!token) return reject();
  // 使用済み・失効・期限切れは同じ案内（URL の状態を区別しない）。
  if (passwordResetTokenState(token, now) !== "pending") return reject();

  const account = await getAccountRow(db, token.account_id);
  if (!account) return reject();
  // 発行後に管理者へ昇格したアカウントのパスワードを古い URL で書き換えられないようにする。
  if (account.role !== "user") {
    throw ApiError.forbidden("この URL はこのアカウントには使えません");
  }
  if (account.status !== "active") {
    throw new ApiError(403, ErrorCode.BANNED, "このアカウントは利用停止中です");
  }

  if (!(await consumePasswordResetToken(db, token.id, now))) return reject();

  const passwordHash = await hashPassword(body.newPassword);
  await db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").bind(passwordHash, account.id).run();
  const revoked = await revokeAllSessions(db, account.id);
  // TOTP は残す（次のログインでは TOTP が要る）。
  await writeAudit(db, {
    actorType: "account",
    actorId: account.id,
    action: "auth.password_reset_operator",
    target: account.id,
    detail: { tokenId: token.id, issuedBy: token.issued_by, revokedSessions: revoked },
  });
  c.executionCtx.waitUntil(cleanupPasswordResetFailures(db, now));
  // トークン保持者に個人情報を渡さない（画面が必要とする表示名だけ）。
  return c.json(ok({ reset: true as const, accountName: account.name }));
});

// --- GitHub OAuth ログイン（未認証） --------------------------------------
// 連携（WP4）とは別に、確認済みメールでアカウント作成/既存メール紐付けを行ってセッションを発行する。

app.get("/github/status", (c) => {
  return c.json(ok({ available: githubLoginAvailable(c.env) }));
});

app.get("/github/start", async (c) => {
  const origin = requestOrigin(c);
  if (!origin) throw ApiError.validation("Web オリジンを特定できません");
  return c.json(ok(await startGithubLogin(c.env, origin)));
});

app.post("/github/callback", async (c) => {
  const body = githubLoginCallbackSchema.parse(await c.req.json());
  const result = await completeGithubLogin(c.env, {
    code: body.code,
    state: body.state,
    userAgent: c.req.header("user-agent") ?? null,
  });
  setCookie(c, SESSION_COOKIE, result.token, sessionCookieOptions(c.env));
  // R42-05: GitHub ログインでもパスワードと同じく端末所有プラグインを引き継ぐ（同期）。
  const ctx = getReqCtx(c);
  try {
    await transferDeviceOwnedPlugins(c.env.DB, ctx.device.deviceHash, result.account.id);
  } catch {
    // 引き継ぎ失敗はログインを落とさない
  }
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: result.account.id,
    action: "auth.github_login",
    target: result.account.id,
    detail: { created: result.created, linkedExisting: result.linkedExisting, githubLogin: result.githubLogin },
  });
  return c.json(
    ok({
      account: result.account,
      expiresAt: result.expiresAt,
      created: result.created,
      linkedExisting: result.linkedExisting,
      githubLogin: result.githubLogin,
    }),
  );
});

// --- 高リスク操作の再認証 -------------------------------------------------

app.post("/step-up", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const body = stepUpRequestSchema.parse(await c.req.json());
  const accountId = ctx.session.account.id;

  const totp = await verifyTotpForAccount(c.env.DB, accountId, c.env.ENC_KEY, body.code);
  let method: "totp" | "recovery" = "totp";
  if (!totp.ok) {
    if (totp.reason === "locked") {
      throw new ApiError(429, ErrorCode.TOTP_LOCKED, "TOTP の失敗回数が上限に達しました。15分後に再試行してください", {
        lockedUntil: totp.lockedUntil,
      });
    }
    const recoveryOk = await consumeRecoveryCode(c.env.DB, accountId, body.code);
    if (recoveryOk) {
      method = "recovery";
    } else if (totp.reason === "not_enabled") {
      throw new ApiError(403, ErrorCode.STEP_UP_REQUIRED, "TOTP が未登録です。/account/totp で登録してください");
    } else {
      throw new ApiError(401, ErrorCode.TOTP_INVALID, "コードが正しくありません", { remaining: totp.remaining });
    }
  }

  const expiresAt = await grantStepUp(c.env.DB, ctx.session.tokenHash, accountId);
  await writeAudit(c.env.DB, {
    actorType: auditActor(ctx.session.account.role),
    actorId: accountId,
    action: "auth.step_up",
    target: accountId,
    detail: { method },
  });
  return c.json(ok({ verifiedUntil: expiresAt }));
});

export default app;