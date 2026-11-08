// MCP サーバー（/mcp, /mcp/legacy）。
// 2026-07-28 ステートレス Streamable HTTP（`createMcpHandler`）と、2025 世代クライアント向けの
// 互換レーン（`legacyStatelessFallback`）の二本立て（DESIGN §10.1 / §A-4 / §15-10）。
// tools は REST と同じ `runAiAction()` を通るため、政策・レート・停止・監査は完全に共通。

import { Hono, type Context } from "hono";
import { McpServer, createMcpHandler, legacyStatelessFallback } from "@modelcontextprotocol/server";
import {
  AI_SYSTEM_PROMPT_TEMPLATE,
  ApiError,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  actionForToolName,
  mcpToolDescriptors,
} from "shared";
import type { AppEnv } from "../lib/env";
import type { AiAgentContext } from "../services/ai/policy-engine";
import { authenticateAiKey } from "../services/ai/agents";
import { parseBearerToken } from "../services/ai/keys";
import { runAiAction } from "../services/ai/run";
import { getReqCtx } from "../lib/context";

const app = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

async function requireAiAgent(c: Ctx): Promise<AiAgentContext> {
  const token = parseBearerToken(c.req.header("authorization"));
  if (!token) throw ApiError.unauthorized("MCP には AI API キー（Bearer ocai_...）が必要です");
  return authenticateAiKey(c.env, token);
}

/** DNS rebinding 対策: Origin が付いている場合は許可リストと一致させる（MCP 仕様要求）。 */
function assertOrigin(c: Ctx): void {
  const origin = c.req.header("origin");
  if (!origin) return;
  const allowed = c.env.ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.includes("*") && !allowed.includes(origin)) {
    throw new ApiError(403, "BAD_ORIGIN", "この Origin からの MCP 接続は許可されていません");
  }
}

/** リクエスト 1 回分の MCP サーバーを構築する（ツールは REST ミラー）。 */
function buildServer(env: AppEnv["Bindings"], agent: AiAgentContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: AI_SYSTEM_PROMPT_TEMPLATE },
  );

  for (const descriptor of mcpToolDescriptors()) {
    const action = actionForToolName(descriptor.name);
    if (!action) continue;

    server.registerTool(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        annotations: descriptor.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await runAiAction({
            env,
            agent,
            action,
            params: args,
            source: "mcp",
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          const payload =
            error instanceof ApiError
              ? { ok: false, code: error.code, message: error.message, details: error.details }
              : { ok: false, code: "INTERNAL", message: "内部エラーが発生しました" };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

function isLegacyLane(c: Ctx): boolean {
  return new URL(c.req.url).pathname.includes("/legacy");
}

async function handleMcp(c: Ctx): Promise<Response> {
  assertOrigin(c);
  const agent = await requireAiAgent(c);

  // MCP リクエストは JSON-RPC。GET/DELETE もハンドラに任せる（仕様どおり 405 等を返す）。
  if (isLegacyLane(c)) {
    const legacy = legacyStatelessFallback(() => buildServer(c.env, agent));
    return legacy(c.req.raw);
  }

  const handler = createMcpHandler(() => buildServer(c.env, agent), { legacy: "reject" });
  const response = await handler.fetch(c.req.raw);
  // Cloudflare Workers はストリーム応答をそのまま返せる。
  return response;
}

app.all("/", async (c) => handleMcp(c));
app.all("/legacy", async (c) => handleMcp(c));

// MCP のエラーは JSON-RPC ではなく HTTP エラーで返る（クライアントは status で判断する）。
app.onError((error, c) => {
  const ctx = getReqCtx(c);
  if (error instanceof ApiError) {
    const headers: Record<string, string> = {};
    if (error.status === 401) headers["www-authenticate"] = 'Bearer realm="open-clone-ai"';
    return Response.json(
      { ok: false, code: error.code, message: error.message, requestId: ctx.requestId },
      { status: error.status, headers },
    );
  }
  console.error("MCP_UNHANDLED", error);
  return c.json({ ok: false, code: "INTERNAL", message: "内部エラーが発生しました" }, 500);
});

export default app;