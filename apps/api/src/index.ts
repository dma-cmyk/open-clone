// Worker エントリーポイント。
// 各ルートのサブアプリを import して mount する（WORKPACKAGES §3.2）。
// 新しいルートを追加するときは、ここに import と mount を 1 行ずつ足す。

import { Hono } from "hono";
import type { AppEnv } from "./lib/env";
import { requestContext } from "./lib/context";
import { corsHeaders, originGuard } from "./lib/middleware/origin";
import { errorHandler, notFoundHandler, toErrorResponse } from "./lib/middleware/error";
import { securityHeaders } from "./lib/middleware/security-headers";
import { handleScheduled } from "./cron";

import meta from "./routes/meta";
import auth from "./routes/auth";
import githubAuth from "./routes/github-auth";
import accounts from "./routes/accounts";
import invites from "./routes/invites";
import admin from "./routes/admin";
import boards from "./routes/boards";
import threads from "./routes/threads";
import posts from "./routes/posts";
import search from "./routes/search";
import ranking from "./routes/ranking";
import reports from "./routes/reports";
import compat from "./routes/compat";
import rt from "./routes/rt";
import uploads from "./routes/uploads";
import githubFiles from "./routes/github-files";
import plugins from "./routes/plugins";
import pluginNet from "./routes/plugin-net";
import ai from "./routes/ai";
import mcp from "./routes/mcp";
import mcpPlugin from "./routes/mcp-plugin";
import pluginTokens from "./routes/plugin-tokens";

const app = new Hono<AppEnv>();

// ⓪ Hono はハンドラ内の例外を compose 内で onError に渡すため、
//    errorHandler（ミドルウェア）だけでは 500 固定になる。同じ envelope 変換を onError にも登録する。
app.onError((error, c) => {
  const reqCtx: { requestId?: string } | undefined = c.get("reqCtx");
  const response = toErrorResponse(error, {
    requestId: reqCtx?.requestId,
    method: c.req.method,
    path: c.req.path,
  });
  const headers = new Headers({
    "content-type": "application/json; charset=UTF-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  });
  return new Response(JSON.stringify(response.body), { status: response.status, headers });
});

// ⓪ セキュリティヘッダー（全レスポンス。404 / onError の envelope も含む）
app.use("*", securityHeaders);
// ① エラーを envelope に統一
app.use("*", errorHandler);
// ② Origin/CSRF（全 mutation）
app.use("*", originGuard);
// ③ CORS（直接モード用）
app.use("*", corsHeaders);
// ④ 端末識別（oc_did Cookie + device_hash）とセッション抽出
app.use("*", requestContext);

// WP0（/v1/health は /v1/meta/health のエイリアス。vercel/next の rewrites 両経路を通す）
app.route("/v1/meta", meta);
app.route("/v1", meta);
// WP6
app.route("/v1/auth", auth);
app.route("/v1/accounts", accounts);
app.route("/v1/admin/invites", invites);
app.route("/v1/admin", admin);
// WP1
app.route("/v1/boards", boards);
app.route("/v1/threads", threads);
app.route("/v1/posts", posts);
app.route("/v1/search", search);
app.route("/v1/ranking", ranking);
app.route("/v1/headline", ranking);
app.route("/v1/reports", reports);
app.route("/compat", compat);
app.route("/v1/rt", rt);
app.route("/rt", rt);
// WP4
app.route("/v1/uploads", uploads);
app.route("/v1/github/oauth", githubAuth);
app.route("/v1/github/link", githubAuth);
app.route("/v1/github/files", githubFiles);
app.route("/v1/github/hooks", githubFiles);
// WP3
app.route("/v1/plugins", plugins);
app.route("/v1/plugin-net", pluginNet);
// WP5
app.route("/v1/ai", ai);
app.route("/mcp", mcp);
app.route("/mcp/legacy", mcp);
// WP-A: 個人用プラグイン作成トークン + 作成専用 MCP レーン（`ocp_`）
app.route("/v1/me/plugin-tokens", pluginTokens);
app.route("/mcp-plugin", mcpPlugin);
app.route("/mcp-plugin/legacy", mcpPlugin);

// 404
app.notFound(notFoundHandler);

// Durable Object クラスはエントリーポイントから export する必要がある（wrangler 要件）
export { RealtimeHub } from "./durable/realtime-hub";
export { RateLimiter } from "./durable/rate-limiter";
export { AiGate } from "./durable/ai-gate";

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
