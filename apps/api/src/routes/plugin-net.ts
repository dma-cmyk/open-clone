// sandbox ネットワークプロキシ（/v1/plugin-net/*）。
// iframe は CSP で直接通信できない。許可ドメイン（manifest.connectAllowlist）への通信だけを
// このプロキシが代行し、全呼び出しを plugin_net_log に記録する（DESIGN §7.1）。

import { Hono } from "hono";
import { ApiError, ok, pluginNetFetchSchema } from "shared";
import type { AppEnv } from "../lib/env";
import { toErrorResponse } from "../lib/middleware/error";
import { getReqCtx } from "../lib/context";
import { requireRole } from "../lib/middleware/auth";
import { pluginActorFrom, scopeRefFor } from "../services/plugins/access";
import { findInstall, getPluginRow, parseManifest } from "../services/plugins/registry";
import { assertNetRateLimit, logNetAttempt, proxyFetch, type NetCaller } from "../services/plugins/net";

const app = new Hono<AppEnv>();

// サブアプリの onError を設定する。Hono の route() はサブアプリの errorHandler が既定値だと
// 例外を親の既定ハンドラ（500 text）で握りつぶすため、envelope 変換をここで明示する。
app.onError((error) => {
  const { status, body } = toErrorResponse(error);
  return Response.json(body, { status });
});

app.post("/fetch", async (c) => {
  const input = pluginNetFetchSchema.parse(await c.req.json());
  const actor = pluginActorFrom(getReqCtx(c));
  const caller: NetCaller = {
    accountId: actor.accountId,
    deviceHash: actor.deviceHash,
    installId: null,
  };

  const plugin = await getPluginRow(c.env.DB, input.pluginId);
  if (!plugin) throw ApiError.notFound("プラグインが見つかりません");

  const isOwner = actor.accountId !== null && plugin.owner_account_id === actor.accountId;

  const deny = async (error: ApiError): Promise<never> => {
    await logNetAttempt(c.env.DB, {
      pluginId: plugin.id,
      version: input.version ?? plugin.latest_version,
      installId: caller.installId,
      scope: input.scope,
      caller,
      url: input.url,
      method: input.method,
      status: null,
      bytes: null,
      allowed: false,
      reason: error.message,
    }).catch(() => undefined);
    throw error;
  };

  if (plugin.status === "disabled") {
    await deny(ApiError.forbidden("このプラグインは停止されています"));
  }
  if (plugin.status !== "published" && !isOwner) {
    await deny(ApiError.notFound("プラグインが見つかりません"));
  }

  const manifest = parseManifest(plugin.manifest_json);
  if (!manifest.permissions.includes("net:fetch")) {
    await deny(ApiError.forbidden("manifest に net:fetch 権限が宣言されていません"));
  }

  const scopeRef = scopeRefFor(input.scope, actor, input.boardId);
  const install = await findInstall(c.env.DB, plugin.id, input.scope, scopeRef);
  if (!install && !isOwner) {
    await deny(ApiError.forbidden("このスコープにプラグインが導入されていません"));
  }
  caller.installId = install?.id ?? null;

  try {
    await assertNetRateLimit(c.env.DB, caller);
  } catch (error) {
    if (error instanceof ApiError) await deny(error);
    throw error;
  }

  try {
    const result = await proxyFetch(input, manifest.connectAllowlist);
    await logNetAttempt(c.env.DB, {
      pluginId: plugin.id,
      version: input.version ?? install?.version ?? plugin.latest_version,
      installId: caller.installId,
      scope: input.scope,
      caller,
      url: result.url,
      method: input.method,
      status: result.status,
      bytes: result.bodyEncoding === "text" ? new TextEncoder().encode(result.body).byteLength : Math.floor(result.body.length * 0.75),
      allowed: true,
      reason: result.truncated ? "response truncated" : null,
    }).catch((logError: unknown) => console.warn("net log failed", logError));

    return c.json(ok(result));
  } catch (error) {
    if (error instanceof ApiError) await deny(error);
    throw error;
  }
});

/** 監査ログ閲覧（サイト管理者）。 */
app.get("/log", requireRole("owner", "special_admin"), async (c) => {
  const pluginId = c.req.query("pluginId");
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 200);
  const allowedOnly = c.req.query("allowed");

  const where: string[] = [];
  const params: unknown[] = [];
  if (pluginId) {
    where.push("plugin_id = ?");
    params.push(pluginId);
  }
  if (allowedOnly === "0" || allowedOnly === "1") {
    where.push("allowed = ?");
    params.push(Number(allowedOnly));
  }

  const result = await c.env.DB.prepare(
    `SELECT * FROM plugin_net_log
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...params, limit)
    .all<{
      id: string;
      plugin_id: string | null;
      version: string | null;
      install_id: string | null;
      scope: string | null;
      account_id: string | null;
      device_hash: string | null;
      url: string;
      host: string;
      method: string;
      status: number | null;
      bytes: number | null;
      allowed: number;
      reason: string | null;
      created_at: number;
    }>();

  return c.json(
    ok({
      items: (result.results ?? []).map((row) => ({
        id: row.id,
        pluginId: row.plugin_id,
        version: row.version,
        installId: row.install_id,
        scope: row.scope,
        accountId: row.account_id,
        deviceHash: row.device_hash,
        url: row.url,
        host: row.host,
        method: row.method,
        status: row.status,
        bytes: row.bytes,
        allowed: row.allowed === 1,
        reason: row.reason,
        createdAt: row.created_at,
      })),
    }),
  );
});

export default app;