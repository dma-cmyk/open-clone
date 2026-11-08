// 自分のアカウント（プロフィール・パスワード・セッション管理）。

import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import {
  ApiError,
  ok,
  passwordChangeRequestSchema,
  profileUpdateSchema,
  SESSION_COOKIE,
  type Profile,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { writeAudit } from "../lib/audit";
import { requireAuth } from "../lib/middleware/auth";
import { hashPassword, verifyPassword } from "../services/account/password";
import { listSessions, revokeAllSessions, revokeSession } from "../services/account/session";
import { getTotpStatus } from "../services/account/totp";
import { accountDto, getAccountRow } from "../services/account/view";

const app = new Hono<AppEnv>();

async function loadProfile(db: D1Database, accountId: string): Promise<Profile> {
  const row = await getAccountRow(db, accountId);
  if (!row) throw ApiError.notFound("アカウントが見つかりません");
  const profile = await db
    .prepare("SELECT bio FROM account_profiles WHERE account_id = ?")
    .bind(accountId)
    .first<{ bio: string }>();
  return {
    ...accountDto(row),
    bio: profile?.bio ?? "",
  };
}

app.get("/me", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const [profile, totp] = await Promise.all([
    loadProfile(c.env.DB, ctx.session.account.id),
    getTotpStatus(c.env.DB, ctx.session.account.id),
  ]);
  return c.json(ok({ profile, totp }));
});

app.patch("/me", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const body = profileUpdateSchema.parse(await c.req.json());
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  const statements: D1PreparedStatement[] = [];
  if (body.name !== undefined) {
    statements.push(db.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(body.name, ctx.session.account.id));
  }
  if (body.bio !== undefined) {
    statements.push(
      db
        .prepare(
          "INSERT INTO account_profiles (account_id, bio, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET bio = excluded.bio, updated_at = excluded.updated_at",
        )
        .bind(ctx.session.account.id, body.bio, now),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  await writeAudit(db, {
    actorType: ctx.session.account.role === "owner" ? "owner" : ctx.session.account.role === "special_admin" ? "special_admin" : "account",
    actorId: ctx.session.account.id,
    action: "account.profile_update",
    target: ctx.session.account.id,
  });
  return c.json(ok(await loadProfile(db, ctx.session.account.id)));
});

app.post("/me/password", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const body = passwordChangeRequestSchema.parse(await c.req.json());
  const db = c.env.DB;
  const row = await getAccountRow(db, ctx.session.account.id);
  if (!row) throw ApiError.notFound("アカウントが見つかりません");
  const currentOk = await verifyPassword(body.currentPassword, row.password_hash);
  if (!currentOk) throw new ApiError(400, "VALIDATION", "現在のパスワードが正しくありません");

  const newHash = await hashPassword(body.newPassword);
  await db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").bind(newHash, row.id).run();
  const revoked = await revokeAllSessions(db, row.id, ctx.session.tokenHash);
  await writeAudit(db, {
    actorType: row.role === "owner" ? "owner" : row.role === "special_admin" ? "special_admin" : "account",
    actorId: row.id,
    action: "account.password_change",
    target: row.id,
    detail: { revokedSessions: revoked },
  });
  return c.json(ok({ changed: true, revokedSessions: revoked }));
});

app.get("/me/sessions", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const sessions = await listSessions(c.env.DB, ctx.session.account.id);
  return c.json(
    ok({
      items: sessions.map((session) => ({
        id: session.token_hash,
        ua: session.ua,
        createdAt: session.created_at,
        lastUsedAt: session.touched_at,
        expiresAt: session.expires_at,
        current: session.token_hash === ctx.session?.tokenHash,
      })),
    }),
  );
});

app.delete("/me/sessions/:id", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const db = c.env.DB;
  const row = await db
    .prepare("SELECT token_hash FROM sessions WHERE token_hash = ? AND account_id = ?")
    .bind(id, ctx.session.account.id)
    .first<{ token_hash: string }>();
  if (!row) throw ApiError.notFound("セッションが見つかりません");
  await revokeSession(db, row.token_hash);
  if (row.token_hash === ctx.session.tokenHash) deleteCookie(c, SESSION_COOKIE, { path: "/" });
  await writeAudit(db, {
    actorType: "account",
    actorId: ctx.session.account.id,
    action: "account.session_revoke",
    target: row.token_hash,
  });
  return c.json(ok({ revoked: true }));
});

app.post("/me/sessions/revoke-others", requireAuth, async (c) => {
  const ctx = getReqCtx(c);
  if (!ctx.session) throw ApiError.unauthorized();
  const revoked = await revokeAllSessions(c.env.DB, ctx.session.account.id, ctx.session.tokenHash);
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: ctx.session.account.id,
    action: "account.sessions_revoke_others",
    target: ctx.session.account.id,
    detail: { revoked },
  });
  return c.json(ok({ revoked }));
});

export default app;