// 一回限りの就任キーの発行・一覧・失効と、就任（accept）フロー。
// 特別管理人就任: キー検証 → アカウント登録 → TOTP 必須登録（QR 用 secret/URI）→ リカバリーコード 10 個。
// 就任完了までは accounts に special_admin を作らない（管理人として一切表示されない）。

import { Hono } from "hono";
import {
  ApiError,
  buildOtpAuthUri,
  ErrorCode,
  generateRecoveryCode,
  generateTotpSecret,
  INVITE_PREPARE_MAX_PER_IP,
  INVITE_PREPARE_MAX_PER_KEY,
  INVITE_TOTP_FAILURE_WINDOW_SECONDS,
  INVITE_TOTP_IP_MAX_FAILURES,
  INVITE_TOTP_MAX_FAILURES,
  INVITE_TTL_HOURS,
  inviteAcceptRequestSchema,
  inviteIssueRequestSchema,
  ok,
  sha256Hex,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totpSecretPrepareRequestSchema,
  ulid,
  verifyTotp,
  type InviteAcceptRequest,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { writeAudit } from "../lib/audit";
import { requireTurnstile } from "../lib/middleware/turnstile";
import { requireOwnerActive } from "../services/account/guards";
import { attemptKey, countAttemptsSince, recordAttempt } from "../services/account/attempts";
import { requireStepUp } from "../services/account/step-up";
import {
  consumeInvite,
  findInviteByKey,
  inspectInvite,
  inviteMeta,
  inviteState,
  inviteSummary,
  issueInvite,
  listInvites,
  revokeInvite,
} from "../services/account/invite";
import { encryptSecret } from "../services/account/crypto";
import { hashPassword } from "../services/account/password";
import { hashRecoveryCode } from "../services/account/recovery";
import { createSession } from "../services/account/session";
import { setSessionCookie } from "../services/account/cookie";
import { ensureSpecialAdminState, restoreSpecialAdmin } from "../services/account/special-admin";
import { getAccountRow, accountDto, type AccountRow } from "../services/account/view";

const app = new Hono<AppEnv>();

// --- 発行・一覧・失効（owner のみ） -------------------------------------

app.post("/", requireOwnerActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const body = inviteIssueRequestSchema.parse(await c.req.json());
  const db = c.env.DB;

  if (body.kind === "board_staff" && body.boardId === undefined) {
    throw ApiError.validation("board_staff の招待には boardId が必要です");
  }
  if (body.accountId) {
    const target = await db
      .prepare("SELECT id, role FROM accounts WHERE id = ?")
      .bind(body.accountId)
      .first<{ id: string; role: string }>();
    if (!target) throw ApiError.notFound("再招待先のアカウントが見つかりません");
    if (body.kind === "special_admin" && target.role !== "special_admin") {
      throw ApiError.validation("再招待できるのは特別管理人のみです");
    }
  }

  const result = await issueInvite(db, body.kind, ctx.session.account.id, {
    expiresInHours: body.expiresInHours ?? INVITE_TTL_HOURS,
    note: body.note,
    accountId: body.accountId,
    boardId: body.boardId,
    level: body.level,
  });
  await writeAudit(db, {
    actorType: "owner",
    actorId: ctx.session.account.id,
    action: "admin.invite_issue",
    target: result.id,
    detail: { kind: body.kind, expiresAt: result.expiresAt, note: body.note ?? null, accountId: body.accountId ?? null },
  });
  return c.json(ok(result), 201);
});

app.get("/", requireOwnerActive, async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const invites = await listInvites(c.env.DB);
  return c.json(
    ok({
      items: invites.map((row) => inviteSummary(row, now)),
      now,
    }),
  );
});

app.post("/:id/revoke", requireOwnerActive, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const revoked = await revokeInvite(c.env.DB, id);
  if (!revoked) throw ApiError.notFound("失効できる招待が見つかりません（使用済み・失効済み・期限切れ）");
  await writeAudit(c.env.DB, {
    actorType: "owner",
    actorId: ctx.session.account.id,
    action: "admin.invite_revoke",
    target: id,
  });
  return c.json(ok({ revoked: true }));
});

// --- 就任フォーム（未認証で利用） --------------------------------------

app.get("/inspect", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!key) throw ApiError.validation("key が必要です");
  return c.json(ok(await inspectInvite(c.env.DB, key)));
});

/** QR 表示用の TOTP secret を発行する（DB へは保存しない。accept 時に検証して保存）。 */
app.post("/prepare-totp", async (c) => {
  const body = totpSecretPrepareRequestSchema.parse(await c.req.json());
  const db = c.env.DB;
  const ctx = getReqCtx(c);
  const now = Math.floor(Date.now() / 1000);

  // 無認証で何度でも secret を発行できると総当たりの足場になる（H-1）。
  // キー単位・IP 単位の 15 分窓で発行回数を抑える。
  const keyHash = await sha256Hex(body.key.trim());
  const keyIssuanceKey = await sha256Hex(`invite-prepare:${keyHash}`);
  const ipIssuanceKey = await attemptKey(ctx.device.ipHash, "invite-prepare");
  const since = now - INVITE_TOTP_FAILURE_WINDOW_SECONDS;
  const [keyIssued, ipIssued] = await Promise.all([
    countAttemptsSince(db, ["invite_prepare"], keyIssuanceKey, since),
    countAttemptsSince(db, ["invite_prepare"], ipIssuanceKey, since),
  ]);
  if (keyIssued >= INVITE_PREPARE_MAX_PER_KEY || ipIssued >= INVITE_PREPARE_MAX_PER_IP) {
    throw ApiError.rateLimited("TOTP 情報の発行回数が上限に達しました。15 分後に再試行してください");
  }

  const inspected = await inspectInvite(db, body.key);
  if (!inspected.valid) {
    throw new ApiError(400, ErrorCode.INVITE_INVALID, inspected.reason ?? "招待キーが無効です");
  }
  await Promise.all([
    recordAttempt(db, "invite_prepare", keyIssuanceKey),
    recordAttempt(db, "invite_prepare", ipIssuanceKey),
  ]);
  const secret = generateTotpSecret();
  return c.json(
    ok({
      secret,
      otpauthUri: buildOtpAuthUri(secret, {
        accountName: inspected.email ?? "special_admin",
        issuer: "OpenClone",
        period: TOTP_PERIOD_SECONDS,
        digits: TOTP_DIGITS,
      }),
    }),
  );
});

app.post("/accept", requireTurnstile({ required: false }), async (c) => {
  const body: InviteAcceptRequest = inviteAcceptRequestSchema.parse(await c.req.json());
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  const invite = await findInviteByKey(db, body.key);
  if (!invite || inviteState(invite, now) !== "pending") {
    throw new ApiError(400, ErrorCode.INVITE_INVALID, "招待キーが無効・使用済み・期限切れです");
  }
  const meta = inviteMeta(invite);

  // H-1: accept の TOTP も通常ログインと同じ失敗カウント・ロックを通す。
  // キー単位の上限に達したらキー自体を失効させ、以降の総当たりを不可能にする。
  const ctx = getReqCtx(c);
  const keyHash = await sha256Hex(body.key.trim());
  const keyFailureKey = await sha256Hex(`invite-fail:${keyHash}`);
  const ipFailureKey = await attemptKey(ctx.device.ipHash, "invite-fail");
  const since = now - INVITE_TOTP_FAILURE_WINDOW_SECONDS;
  const [keyFailures, ipFailures] = await Promise.all([
    countAttemptsSince(db, ["invite_failed"], keyFailureKey, since),
    countAttemptsSince(db, ["invite_failed"], ipFailureKey, since),
  ]);
  if (keyFailures >= INVITE_TOTP_MAX_FAILURES) {
    await revokeInvite(db, invite.id);
    throw new ApiError(400, ErrorCode.INVITE_INVALID, "TOTP の失敗回数が上限に達したため、この招待キーは失効しました");
  }
  if (ipFailures >= INVITE_TOTP_IP_MAX_FAILURES) {
    throw ApiError.rateLimited("TOTP の試行回数が多すぎます。しばらく待ってから再試行してください");
  }

  const totpOk = await verifyTotp(body.totpSecret, body.totpCode, {
    window: 1,
    period: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
    time: now,
  });
  if (!totpOk) {
    await Promise.all([
      recordAttempt(db, "invite_failed", keyFailureKey),
      recordAttempt(db, "invite_failed", ipFailureKey),
    ]);
    if (keyFailures + 1 >= INVITE_TOTP_MAX_FAILURES) {
      await revokeInvite(db, invite.id);
      await writeAudit(db, {
        actorType: "system",
        action: "admin.invite_bruteforce_revoked",
        target: invite.id,
        detail: { failures: keyFailures + 1, ipFailures: ipFailures + 1 },
      });
      throw new ApiError(
        400,
        ErrorCode.INVITE_INVALID,
        "TOTP の失敗回数が上限に達したため、この招待キーは失効しました",
      );
    }
    if (ipFailures + 1 >= INVITE_TOTP_IP_MAX_FAILURES) {
      throw ApiError.rateLimited("TOTP の試行回数が多すぎます。しばらく待ってから再試行してください");
    }
    throw new ApiError(400, ErrorCode.TOTP_INVALID, "TOTP コードが正しくありません");
  }

  // 再招待（既存アカウント復旧）か新規登録か
  let accountId: string;
  let existing: AccountRow | null = null;
  if (meta.accountId) {
    existing = await getAccountRow(db, meta.accountId);
    if (!existing) throw new ApiError(400, ErrorCode.INVITE_INVALID, "再招待先のアカウントが存在しません");
    const emailOwner = await db
      .prepare("SELECT id FROM accounts WHERE email = ? AND id != ?")
      .bind(body.email, existing.id)
      .first<{ id: string }>();
    if (emailOwner) throw ApiError.conflict("このメールアドレスは他のアカウントで使用されています");
    accountId = existing.id;
  } else {
    const emailOwner = await db.prepare("SELECT id FROM accounts WHERE email = ?").bind(body.email).first<{ id: string }>();
    if (emailOwner) {
      throw ApiError.conflict("このメールアドレスは既に登録されています。復旧は所有者に再招待を依頼してください");
    }
    accountId = ulid();
  }

  const consumed = await consumeInvite(db, invite.id, accountId);
  if (!consumed) {
    throw new ApiError(400, ErrorCode.INVITE_INVALID, "この招待キーは既に使用されています");
  }

  const passwordHash = await hashPassword(body.password);
  const secretEnc = await encryptSecret(body.totpSecret, c.env.ENC_KEY);
  const required = invite.kind === "special_admin" ? 1 : 0;
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const hashed = await Promise.all(codes.map((code) => hashRecoveryCode(code)));

  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      db.prepare("UPDATE accounts SET name = ?, email = ?, password_hash = ?, status = 'active' WHERE id = ?")
        .bind(body.name, body.email, passwordHash, accountId),
      db
        .prepare(
          `INSERT INTO account_totp (account_id, secret_enc, verified, required, enabled_at, failed_attempts, locked_until, pending_expires_at, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, 0, NULL, NULL, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             secret_enc = excluded.secret_enc,
             verified = 1,
             required = excluded.required,
             enabled_at = excluded.enabled_at,
             failed_attempts = 0,
             locked_until = NULL,
             pending_expires_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .bind(accountId, secretEnc, required, now, now, now),
      db.prepare("DELETE FROM recovery_codes WHERE account_id = ?").bind(accountId),
    );
  } else {
    statements.push(
      db
        .prepare("INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)")
        .bind(accountId, body.name, body.email, passwordHash, invite.kind === "special_admin" ? "special_admin" : "user", now),
      db.prepare("INSERT INTO account_profiles (account_id, bio, updated_at) VALUES (?, '', ?)").bind(accountId, now),
      db
        .prepare("INSERT INTO account_totp (account_id, secret_enc, verified, required, enabled_at, failed_attempts, locked_until, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 0, NULL, ?, ?)")
        .bind(accountId, secretEnc, required, now, now, now),
    );
  }
  hashed.forEach((hash) => {
    statements.push(
      db
        .prepare("INSERT INTO recovery_codes (id, account_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)")
        .bind(ulid(), accountId, hash, now),
    );
  });
  await db.batch(statements);

  if (invite.kind === "special_admin") {
    if (existing) await restoreSpecialAdmin(db, accountId);
    else await ensureSpecialAdminState(db, accountId);
  }

  const session = await createSession(db, accountId, c.req.header("user-agent") ?? null);
  setSessionCookie(c, session.token);
  const row = await getAccountRow(db, accountId);
  if (!row) throw new Error("Failed to load accepted account");

  await writeAudit(db, {
    actorType: row.role === "special_admin" ? "special_admin" : "account",
    actorId: accountId,
    action: existing ? "admin.invite_reaccept" : "admin.invite_accept",
    target: invite.id,
    detail: { kind: invite.kind, email: body.email },
  });

  const boardAssignment =
    invite.kind === "board_staff" && meta.boardId !== undefined
      ? { boardId: meta.boardId, level: meta.level ?? ("moderator" as const) }
      : null;

  return c.json(
    ok({
      account: accountDto(row),
      expiresAt: session.expiresAt,
      recoveryCodes: codes,
      boardAssignment,
    }),
    201,
  );
});

export default app;