// 管理 API（所有者セットアップ・ユーザー/規制・監査ログ・サイト設定・特別管理人）。
// owner 専用操作は requireOwnerActive でサーバ側強制。高リスク操作は step-up（TOTP 再認証）必須。

import { Hono } from "hono";
import {
  ApiError,
  auditLogQuerySchema,
  likeContains,
  likePrefix,
  ok,
  OWNER_SETUP_FAILURE_WINDOW_SECONDS,
  OWNER_SETUP_MAX_FAILURES,
  ownerBootstrapRequestSchema,
  siteSettingsUpdateSchema,
  specialAdminStopRequestSchema,
  suspensionCreateRequestSchema,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { writeAudit } from "../lib/audit";
import { bootstrapOwner, ownerExists } from "../services/account/bootstrap";
import { attemptKey, countAttemptsSince, recordAttempt } from "../services/account/attempts";
import { grantStepUp, requireStepUp } from "../services/account/step-up";
import { requireAdminActive, requireOwnerActive } from "../services/account/guards";
import { createSession, countActiveSessions, revokeAllSessions } from "../services/account/session";
import { setSessionCookie } from "../services/account/cookie";
import { accountDto, getAccountRow } from "../services/account/view";
import {
  countActiveSuspensions,
  createSuspension,
  liftSuspension,
  listSuspensions,
} from "../services/account/suspension";
import {
  countPendingInvites,
  issueInvite,
} from "../services/account/invite";
import { getSiteSettings, updateSiteSettings } from "../services/account/site-config";
import { resetTotp } from "../services/account/totp";
import { countRemainingRecoveryCodes } from "../services/account/recovery";
import {
  ensureSpecialAdminState,
  getSpecialAdminState,
  listSpecialAdmins,
  restoreSpecialAdmin,
  stopSpecialAdmin,
} from "../services/account/special-admin";
import type { AdminOverview, AdminUser, AuditLogEntry } from "shared";

const app = new Hono<AppEnv>();

// --- 所有者ブートストラップ --------------------------------------------

// 所有者の有無は未認証で公開しない（L-3）。セットアップ画面は POST の 409
// OWNER_SETUP_CLOSED で「設定済み」を判定する。誤キーは所有者の有無に関わらず 403。

app.post("/owner/setup", async (c) => {
  const body = ownerBootstrapRequestSchema.parse(await c.req.json());
  const db = c.env.DB;

  // L-1: 誤キー試行の IP 窓。正しいキーの初回セットアップは 1 回で通るため妨げない。
  const ctx = getReqCtx(c);
  const now = Math.floor(Date.now() / 1000);
  const ipKey = await attemptKey(ctx.device.ipHash, "owner-setup");
  const failures = await countAttemptsSince(
    db,
    ["owner_setup_failed"],
    ipKey,
    now - OWNER_SETUP_FAILURE_WINDOW_SECONDS,
  );
  if (failures >= OWNER_SETUP_MAX_FAILURES) {
    throw ApiError.rateLimited(
      "セットアップキーの試行回数が多すぎます。しばらく待ってから再試行してください",
    );
  }

  let result: Awaited<ReturnType<typeof bootstrapOwner>>;
  try {
    result = await bootstrapOwner(db, c.env, body);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      await recordAttempt(db, "owner_setup_failed", ipKey);
    }
    throw error;
  }
  const session = await createSession(db, result.accountId, c.req.header("user-agent") ?? null);
  await grantStepUp(db, session.tokenHash, result.accountId);
  setSessionCookie(c, session.token);
  const row = await getAccountRow(db, result.accountId);
  if (!row) throw new Error("Failed to load owner account");
  await writeAudit(db, {
    actorType: "owner",
    actorId: result.accountId,
    action: "admin.owner_bootstrap",
    target: result.accountId,
  });
  return c.json(
    ok({
      account: accountDto(row),
      expiresAt: session.expiresAt,
      recoveryCodes: result.recoveryCodes,
    }),
    201,
  );
});

// --- 概要 ---------------------------------------------------------------

app.get("/overview", requireAdminActive, async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const [accounts, activeSessions, specialAdmins, stoppedSpecialAdmins, activeSuspensionsCount, pendingInvites, audit24h] =
    await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM accounts").first<{ n: number }>(),
      countActiveSessions(db),
      db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'special_admin'").first<{ n: number }>(),
      db.prepare("SELECT COUNT(*) AS n FROM special_admin_state WHERE stopped_at IS NOT NULL").first<{ n: number }>(),
      countActiveSuspensions(db),
      countPendingInvites(db),
      db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE created_at > ?").bind(now - 86_400).first<{ n: number }>(),
    ]);
  const overview: AdminOverview = {
    accounts: accounts?.n ?? 0,
    activeSessions,
    specialAdmins: specialAdmins?.n ?? 0,
    stoppedSpecialAdmins: stoppedSpecialAdmins?.n ?? 0,
    activeSuspensions: activeSuspensionsCount,
    pendingInvites,
    auditEvents24h: audit24h?.n ?? 0,
    ownerExists: await ownerExists(db),
  };
  return c.json(ok(overview));
});

// --- ユーザー一覧・詳細 -------------------------------------------------

app.get("/users", requireAdminActive, async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const q = (c.req.query("q") ?? "").trim();
  const page = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
  const role = c.req.query("role");
  const status = c.req.query("status");

  const conditions: string[] = [];
  const bindings: (string | number)[] = [now];
  if (q) {
    const pattern = likeContains(q);
    conditions.push("(a.name LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\')");
    bindings.push(pattern, pattern);
  }
  if (role === "owner" || role === "special_admin" || role === "user") {
    conditions.push("a.role = ?");
    bindings.push(role);
  }
  if (status === "active" || status === "suspended") {
    conditions.push("a.status = ?");
    bindings.push(status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM accounts a ${where}`)
    .bind(...bindings.slice(1))
    .first<{ n: number }>();
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.email, a.role, a.status, a.created_at,
              (SELECT s.stopped_at FROM special_admin_state s WHERE s.account_id = a.id) AS stopped_at,
              (SELECT COUNT(*) FROM suspensions x
                 WHERE x.account_id = a.id AND x.lifted_at IS NULL AND (x.expires_at IS NULL OR x.expires_at > ?)) AS active_suspensions
       FROM accounts a ${where}
       ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, limit, (page - 1) * limit)
    .all<{
      id: string;
      name: string;
      email: string | null;
      role: AdminUser["role"];
      status: AdminUser["status"];
      created_at: number;
      stopped_at: number | null;
      active_suspensions: number;
    }>();
  const items: AdminUser[] = results.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    specialAdminStopped: row.stopped_at !== null,
    activeSuspensions: row.active_suspensions,
  }));
  return c.json(ok({ items, total: totalRow?.n ?? 0, page, limit }));
});

app.get("/users/:id", requireAdminActive, async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const row = await getAccountRow(db, id);
  if (!row) throw ApiError.notFound("アカウントが見つかりません");
  if (c.get("reqCtx").session?.account.role === "special_admin" && id !== c.get("reqCtx").session?.account.id) {
    // 特別管理人は所有者の情報を詳細取得できない（所有者の操作に触れられない）
    if (row.role === "owner") throw ApiError.forbidden("所有者のアカウント情報は参照できません");
  }
  const [profile, suspensionList, totpRemaining, specialState] = await Promise.all([
    db.prepare("SELECT bio FROM account_profiles WHERE account_id = ?").bind(id).first<{ bio: string }>(),
    listSuspensions(db, { accountId: id, activeOnly: true, limit: 20 }),
    countRemainingRecoveryCodes(db, id),
    getSpecialAdminState(db, id),
  ]);
  return c.json(
    ok({
      account: accountDto(row),
      bio: profile?.bio ?? "",
      suspensions: suspensionList.items,
      recoveryRemaining: totpRemaining,
      specialAdmin: specialState,
    }),
  );
});

// --- 規制（suspensions） ------------------------------------------------

app.get("/suspensions", requireAdminActive, async (c) => {
  const activeOnly = c.req.query("active") !== "0";
  const result = await listSuspensions(c.env.DB, {
    activeOnly,
    page: Math.max(Number(c.req.query("page") ?? 1) || 1, 1),
    limit: Math.min(Number(c.req.query("limit") ?? 50) || 50, 100),
  });
  return c.json(ok(result));
});

app.post("/suspensions", requireAdminActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const body = suspensionCreateRequestSchema.parse(await c.req.json());
  const suspension = await createSuspension(c.env.DB, body, ctx.session.account.id);
  await writeAudit(c.env.DB, {
    actorType: ctx.session.account.role === "owner" ? "owner" : "special_admin",
    actorId: ctx.session.account.id,
    action: "admin.suspension_create",
    target: suspension.accountId ?? body.email ?? body.deviceHash ?? suspension.id,
    detail: { scope: suspension.scope, boardId: suspension.boardId, reason: suspension.reason, expiresAt: suspension.expiresAt },
  });
  return c.json(ok(suspension), 201);
});

app.post("/suspensions/:id/lift", requireAdminActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const suspension = await liftSuspension(c.env.DB, id);
  if (!suspension) throw ApiError.notFound("規制が見つかりません");
  await writeAudit(c.env.DB, {
    actorType: ctx.session.account.role === "owner" ? "owner" : "special_admin",
    actorId: ctx.session.account.id,
    action: "admin.suspension_lift",
    target: id,
  });
  return c.json(ok(suspension));
});

app.delete("/suspensions/:id", requireAdminActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const suspension = await liftSuspension(c.env.DB, id);
  if (!suspension) throw ApiError.notFound("規制が見つかりません");
  await writeAudit(c.env.DB, {
    actorType: ctx.session.account.role === "owner" ? "owner" : "special_admin",
    actorId: ctx.session.account.id,
    action: "admin.suspension_lift",
    target: id,
  });
  return c.json(ok({ lifted: true }));
});

// --- 監査ログ -----------------------------------------------------------

app.get("/audit", requireAdminActive, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const query = auditLogQuerySchema.parse({
    action: c.req.query("action") || undefined,
    actorId: c.req.query("actorId") || undefined,
    since: c.req.query("since") || undefined,
    page: c.req.query("page") || undefined,
    limit: c.req.query("limit") || undefined,
  });
  const db = c.env.DB;
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  // 特別管理人は自分の操作ログのみ閲覧できる（所有者の操作に触れられない）
  if (ctx.session.account.role === "special_admin") {
    conditions.push("l.actor_id = ?");
    bindings.push(ctx.session.account.id);
  } else if (query.actorId) {
    conditions.push("l.actor_id = ?");
    bindings.push(query.actorId);
  }
  if (query.action) {
    conditions.push("l.action LIKE ? ESCAPE '\\'");
    bindings.push(likePrefix(query.action));
  }
  if (query.since !== undefined) {
    conditions.push("l.created_at > ?");
    bindings.push(query.since);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log l ${where}`)
    .bind(...bindings)
    .first<{ n: number }>();
  const { results } = await db
    .prepare(
      `SELECT l.id, l.actor_type, l.actor_id, l.action, l.target, l.detail, l.created_at, a.name AS actor_name
       FROM audit_log l LEFT JOIN accounts a ON a.id = l.actor_id
       ${where} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, query.limit, (query.page - 1) * query.limit)
    .all<{
      id: string;
      actor_type: AuditLogEntry["actorType"];
      actor_id: string | null;
      action: string;
      target: string | null;
      detail: string | null;
      created_at: number;
      actor_name: string | null;
    }>();
  const items: AuditLogEntry[] = results.map((row) => ({
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    target: row.target,
    detail: row.detail ? JSON.parse(row.detail) : null,
    createdAt: row.created_at,
  }));
  return c.json(ok({ items, total: totalRow?.n ?? 0, page: query.page, limit: query.limit }));
});

// --- サイト設定 ---------------------------------------------------------

app.get("/site-config", requireAdminActive, async (c) => {
  return c.json(ok(await getSiteSettings(c.env.DB)));
});

app.put("/site-config", requireOwnerActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const patch = siteSettingsUpdateSchema.parse(await c.req.json());
  const settings = await updateSiteSettings(c.env.DB, patch);
  await writeAudit(c.env.DB, {
    actorType: "owner",
    actorId: ctx.session.account.id,
    action: "admin.site_config_update",
    target: "site_config",
    detail: { keys: Object.keys(patch) },
  });
  return c.json(ok(settings));
});

// --- 特別管理人 ---------------------------------------------------------

app.get("/special-admins", requireOwnerActive, async (c) => {
  return c.json(ok({ items: await listSpecialAdmins(c.env.DB) }));
});

async function requireSpecialAdminTarget(db: D1Database, id: string): Promise<{ id: string; name: string }> {
  const target = await db
    .prepare("SELECT id, name, role FROM accounts WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; role: string }>();
  if (!target) throw ApiError.notFound("アカウントが見つかりません");
  if (target.role !== "special_admin") throw ApiError.validation("対象は特別管理人ではありません");
  return target;
}

app.post("/special-admins/:id/stop", requireOwnerActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const body = specialAdminStopRequestSchema.parse(await c.req.json());
  const db = c.env.DB;
  const target = await requireSpecialAdminTarget(db, id);
  await stopSpecialAdmin(db, target.id, ctx.session.account.id, body.reason);
  const revoked = await revokeAllSessions(db, target.id);
  await writeAudit(db, {
    actorType: "owner",
    actorId: ctx.session.account.id,
    action: "admin.special_admin_stop",
    target: target.id,
    detail: { reason: body.reason, revokedSessions: revoked },
  });
  return c.json(ok({ stopped: true, revokedSessions: revoked }));
});

app.post("/special-admins/:id/restore", requireOwnerActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const db = c.env.DB;
  const target = await requireSpecialAdminTarget(db, id);
  await restoreSpecialAdmin(db, target.id);
  await ensureSpecialAdminState(db, target.id);
  await writeAudit(db, {
    actorType: "owner",
    actorId: ctx.session.account.id,
    action: "admin.special_admin_restore",
    target: target.id,
  });
  return c.json(ok({ restored: true }));
});

app.post("/special-admins/:id/totp-reset", requireOwnerActive, requireStepUp(), async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const db = c.env.DB;
  const target = await requireSpecialAdminTarget(db, id);
  const body = (await c.req.json().catch(() => ({}))) as { reinvite?: boolean; note?: string };

  await resetTotp(db, target.id);
  const revoked = await revokeAllSessions(db, target.id);
  let invite = null;
  if (body.reinvite) {
    invite = await issueInvite(db, "special_admin", ctx.session.account.id, {
      accountId: target.id,
      note: body.note ?? "TOTP リセット後の再招待",
    });
  }
  await writeAudit(db, {
    actorType: "owner",
    actorId: ctx.session.account.id,
    action: "admin.special_admin_totp_reset",
    target: target.id,
    detail: { reinvite: body.reinvite === true, inviteId: invite?.id ?? null, revokedSessions: revoked },
  });
  return c.json(ok({ invite, sessionsRevoked: revoked }));
});

export default app;