// 個人用プラグイン作成トークンの管理 REST（`/v1/me/plugin-tokens`）。
// 発行と全失効は step-up（TOTP 再認証）必須。平文は発行応答で 1 回だけ返す。
// トークン自体は管理 API の認証には使えない（`/mcp-plugin` 専用。`parsePluginToken` は `ocp_` のみ）。

import { Hono } from "hono";
import {
  ApiError,
  ok,
  pluginAuthorTokenCreateResponseSchema,
  pluginAuthorTokenCreateSchema,
  pluginAuthorTokenListResponseSchema,
  pluginAuthorTokenRevokeAllResponseSchema,
  pluginAuthorTokenRevokeResponseSchema,
  type AuthAccount,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { writeAudit } from "../lib/audit";
import { requireAuth } from "../lib/middleware/auth";
import { requireStepUp } from "../services/account/step-up";
import {
  createPluginToken,
  listPluginTokens,
  revokeAllPluginTokens,
  revokePluginToken,
} from "../services/plugin-authoring/tokens";

const app = new Hono<AppEnv>();

function auditActor(role: AuthAccount["role"]): "owner" | "special_admin" | "account" {
  if (role === "owner") return "owner";
  if (role === "special_admin") return "special_admin";
  return "account";
}

/** 一覧（平文・ハッシュは返さない）。期限切れも表示できるよう status と expired を併記する。 */
app.get("", requireAuth, async (c) => {
  const session = getReqCtx(c).session;
  if (!session) throw ApiError.unauthorized();
  const now = Math.floor(Date.now() / 1000);
  const rows = await listPluginTokens(c.env, session.account.id);
  const data = pluginAuthorTokenListResponseSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      prefix: row.token_prefix,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.last_used_at !== null ? { lastUsedAt: row.last_used_at } : {}),
      expired: row.expires_at <= now,
    })),
  });
  return c.json(ok(data));
});

app.post("", requireAuth, requireStepUp(), async (c) => {
  const session = getReqCtx(c).session;
  if (!session) throw ApiError.unauthorized();
  const body = pluginAuthorTokenCreateSchema.parse(await c.req.json().catch(() => ({})));
  const created = await createPluginToken(c.env, session.account.id, body.name);

  await writeAudit(c.env.DB, {
    actorType: auditActor(session.account.role),
    actorId: session.account.id,
    action: "plugin_token.issue",
    target: created.row.id,
    detail: { prefix: created.row.token_prefix, expiresAt: created.row.expires_at },
  });

  const data = pluginAuthorTokenCreateResponseSchema.parse({
    id: created.row.id,
    token: created.token,
    prefix: created.row.token_prefix,
    name: created.row.name,
    status: created.row.status,
    createdAt: created.row.created_at,
    expiresAt: created.row.expires_at,
  });
  return c.json(ok(data), 201);
});

app.post("/revoke-all", requireAuth, requireStepUp(), async (c) => {
  const session = getReqCtx(c).session;
  if (!session) throw ApiError.unauthorized();
  const revoked = await revokeAllPluginTokens(c.env, session.account.id);
  await writeAudit(c.env.DB, {
    actorType: auditActor(session.account.role),
    actorId: session.account.id,
    action: "plugin_token.revoke_all",
    target: session.account.id,
    detail: { revoked },
  });
  return c.json(ok(pluginAuthorTokenRevokeAllResponseSchema.parse({ ok: true, revoked })));
});

app.delete("/:id", requireAuth, async (c) => {
  const session = getReqCtx(c).session;
  if (!session) throw ApiError.unauthorized();
  const id = c.req.param("id");
  const revoked = await revokePluginToken(c.env, session.account.id, id);
  if (!revoked) throw ApiError.notFound("トークンが見つかりません");
  await writeAudit(c.env.DB, {
    actorType: auditActor(session.account.role),
    actorId: session.account.id,
    action: "plugin_token.revoke",
    target: id,
  });
  return c.json(ok(pluginAuthorTokenRevokeResponseSchema.parse({ ok: true, id })));
});

export default app;