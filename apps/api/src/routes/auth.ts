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
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  ulid,
  type SiteSettings,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { writeAudit } from "../lib/audit";
import { requireAuth } from "../lib/middleware/auth";
import { requireTurnstile } from "../lib/middleware/turnstile";
import { hashPassword, verifyPassword } from "../services/account/password";
import { createSession, revokeAllSessions, revokeSession } from "../services/account/session";
import { getTotpRow, verifyTotpCode, verifyTotpForAccount, beginTotpSetup, enableTotp, disableTotp, getTotpStatus, resetTotp } from "../services/account/totp";
import { consumeRecoveryCode, countRemainingRecoveryCodes, generateRecoveryCodes } from "../services/account/recovery";
import { findActiveSiteSuspension } from "../services/account/suspension";
import { getSiteSettings } from "../services/account/site-config";
import { attemptKey, cleanupOldAttempts, countAttemptsSince, recordAttempt } from "../services/account/attempts";
import { grantStepUp, requireStepUp } from "../services/account/step-up";
import { completeGithubLogin, githubLoginAvailable, startGithubLogin } from "../services/account/github-login";
import { accountDto, buildAuthSession, getAccountRow, type AccountRow } from "../services/account/view";

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

function turnstileNeeded(settings: SiteSettings, failures: number): boolean {
  const mode = settings["security.require_turnstile"];
  if (mode === "always") return true;
  if (mode === "off") return false;
  return failures >= 3;
}

function requireTurnstileToken(c: { req: { header(name: string): string | undefined } }): void {
  if (!c.req.header("x-turnstile-token")) {
    throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile 認証が必要です");
  }
}

async function loadAccountByEmail(db: D1Database, email: string): Promise<AccountRow | null> {
  return db
    .prepare(
      "SELECT id, name, email, password_hash, role, status, created_at FROM accounts WHERE email = ?",
    )
    .bind(email)
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
  if (ipRegistrations >= RATE_LIMITS.register.max) {
    throw ApiError.rateLimited("新規登録の上限に達しました。しばらく待ってから再試行してください");
  }

  const existing = await db.prepare("SELECT id FROM accounts WHERE email = ?").bind(body.email).first<{ id: string }>();
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
  const failures = await countAttemptsSince(db, ["login_failed"], keyHash, now - RATE_LIMITS.login.windowSeconds);

  if (failures >= RATE_LIMITS.login.max) {
    throw ApiError.rateLimited("ログイン試行が多すぎます。しばらく待ってから再試行してください");
  }
  if (turnstileNeeded(settings, failures)) requireTurnstileToken(c);

  const account = await loadAccountByEmail(db, body.email);
  const passwordOk = await verifyPassword(body.password, account?.password_hash ?? null);

  if (!account || !passwordOk) {
    await recordAttempt(db, "login_failed", keyHash, account?.id ?? null);
    c.executionCtx.waitUntil(cleanupOldAttempts(db));
    throw ApiError.unauthorized("メールアドレスまたはパスワードが正しくありません");
  }

  const suspension = await findActiveSiteSuspension(db, {
    accountId: account.id,
    email: account.email,
    deviceHash: ctx.device.deviceHash,
  });
  if (account.status !== "active" || suspension) {
    await recordAttempt(db, "login_failed", keyHash, account.id);
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

app.post("/recovery-codes/regenerate", requireAuth, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const recoveryCodes = await generateRecoveryCodes(c.env.DB, ctx.session.account.id);
  await writeAudit(c.env.DB, {
    actorType: auditActor(ctx.session.account.role),
    actorId: ctx.session.account.id,
    action: "auth.recovery_codes_regenerated",
    target: ctx.session.account.id,
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

// --- GitHub OAuth ログイン（未認証） --------------------------------------
// 連携（WP4）とは別に、確認済みメールでアカウント作成/既存メール紐付けを行ってセッションを発行する。

function requestOrigin(c: { req: { header(name: string): string | undefined }; env: AppEnv["Bindings"] }): string {
  const origin = c.req.header("origin");
  if (origin) return origin;
  const referer = c.req.header("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // fall through
    }
  }
  return (c.env.ALLOWED_ORIGINS ?? "").split(",")[0]?.trim() ?? "";
}

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