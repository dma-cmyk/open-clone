// MCP サーバー（/mcp-plugin, /mcp-plugin/legacy）— 個人用プラグイン作成レーン。
//
// AI 運営の `/mcp`（`ocai_` + 政策エンジン）とは完全に分離する:
// - 認証は Bearer `ocp_` のみ（`ocai_` は `parsePluginToken` が通さない。逆も同様）
// - ツールは `authoring.*` の 9 本だけ（投稿・管理・審査は登録しない）
// - 政策エンジン（`runAiAction`）は通さない。代わりに executor が所有者一致を毎回 DB で確認する
// 詳細: 報告書28 §4.1/§4.2、報告書30 §2.3。

import { Hono, type Context } from "hono";
import { McpServer, createMcpHandler, legacyStatelessFallback } from "@modelcontextprotocol/server";
import type { ZodType } from "zod";
import {
  ApiError,
  authoringAddVersionSchema,
  authoringCheckSchema,
  authoringCreateDraftSchema,
  authoringGetSchema,
  authoringInstallSelfSchema,
  authoringListSchema,
  authoringListTemplatesInputSchema,
  authoringPreviewSchema,
  authoringPublishSchema,
  type AuthoringToolName,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { authenticatePluginToken, parsePluginToken, type AuthenticatedPluginToken } from "../services/plugin-authoring/tokens";
import { runAuthoringTool, type AuthorToolMeta } from "../services/plugin-authoring/execute";
import { PLUGIN_AUTHOR_INSTRUCTIONS } from "../services/plugin-authoring/instructions";

export const PLUGIN_AUTHOR_SERVER_NAME = "open-clone-plugin-author";
export const PLUGIN_AUTHOR_SERVER_VERSION = "1.0.0";

interface ToolDefinition {
  name: AuthoringToolName;
  title: string;
  description: string;
  inputSchema: ZodType;
  readOnly: boolean;
}

/** 9 ツールの定義（報告書28 §4.2 の一覧と 1 対 1）。 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "authoring.list_templates",
    title: "テンプレート一覧",
    description:
      "プラグイン作成テンプレート（id・説明・入力パラメータ・既定 manifest）を返す。生成はあなた（AI）側で行う。\nrisk: low",
    inputSchema: authoringListTemplatesInputSchema,
    readOnly: true,
  },
  {
    name: "authoring.create_draft",
    title: "下書き作成",
    description:
      "manifest とコードから自分の下書きプラグインを作成する。保存前に静的検査（runStaticChecks）を必ず通す。\nrisk: medium",
    inputSchema: authoringCreateDraftSchema,
    readOnly: false,
  },
  {
    name: "authoring.add_version",
    title: "版追加",
    description: "自分のプラグインに新しい版を追加する（version 省略時は patch+1）。\nrisk: medium",
    inputSchema: authoringAddVersionSchema,
    readOnly: false,
  },
  {
    name: "authoring.check",
    title: "静的検査",
    description:
      "未保存のコード/manifest に静的検査と権限警告を返す（保存しない）。保存前に必ず呼ぶ。\nrisk: low",
    inputSchema: authoringCheckSchema,
    readOnly: true,
  },
  {
    name: "authoring.preview",
    title: "プレビュー情報",
    description:
      "自分の下書きの静的検査・manifest・render 規則の安全性・版/審査状態と、ブラウザで確認する URL を返す。サーバーでは描画しない。\nrisk: low",
    inputSchema: authoringPreviewSchema,
    readOnly: true,
  },
  {
    name: "authoring.publish",
    title: "公開申請",
    description:
      "自分のプラグインを公開する。personal/board は即時、site を含む場合は人間の審査（plugin_reviews pending）で止まる。\nrisk: high",
    inputSchema: authoringPublishSchema,
    readOnly: false,
  },
  {
    name: "authoring.install_self",
    title: "自分用に導入",
    description:
      "自分の personal スコープにのみ導入・更新・解除する。板/サイトへの導入はできない。\nrisk: medium",
    inputSchema: authoringInstallSelfSchema,
    readOnly: false,
  },
  {
    name: "authoring.get",
    title: "プラグイン詳細",
    description: "自分のプラグインの manifest・版・審査状態を返す。\nrisk: low",
    inputSchema: authoringGetSchema,
    readOnly: true,
  },
  {
    name: "authoring.list",
    title: "自分のプラグイン一覧",
    description: "自分のプラグインを状態・キーワードで絞り込んで返す（カーソルページング）。\nrisk: low",
    inputSchema: authoringListSchema,
    readOnly: true,
  },
];

const app = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

async function requirePluginToken(c: Ctx): Promise<AuthenticatedPluginToken> {
  const token = parsePluginToken(c.req.header("authorization"));
  if (!token) {
    throw ApiError.unauthorized("MCP にはプラグイン作成トークン（Bearer ocp_...）が必要です");
  }
  return authenticatePluginToken(c.env, token);
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

/** リクエスト 1 回分のサーバーを構築する（ステートレス）。 */
function buildServer(env: AppEnv["Bindings"], token: AuthenticatedPluginToken, meta: AuthorToolMeta): McpServer {
  const server = new McpServer(
    { name: PLUGIN_AUTHOR_SERVER_NAME, version: PLUGIN_AUTHOR_SERVER_VERSION },
    { instructions: PLUGIN_AUTHOR_INSTRUCTIONS },
  );

  for (const definition of TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const result = await runAuthoringTool(env, token, definition.name, args, meta);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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

async function handlePluginMcp(c: Ctx): Promise<Response> {
  assertOrigin(c);
  const token = await requirePluginToken(c);
  const ctx = getReqCtx(c);
  const meta: AuthorToolMeta = { ipHash: ctx.device.ipHash, requestId: ctx.requestId };

  if (isLegacyLane(c)) {
    const legacy = legacyStatelessFallback(() => buildServer(c.env, token, meta));
    return legacy(c.req.raw);
  }

  const handler = createMcpHandler(() => buildServer(c.env, token, meta), { legacy: "reject" });
  return handler.fetch(c.req.raw);
}

app.all("/", async (c) => handlePluginMcp(c));
app.all("/legacy", async (c) => handlePluginMcp(c));

// MCP のエラーは JSON-RPC ではなく HTTP エラーで返る（クライアントは status で判断する）。
app.onError((error, c) => {
  const ctx = getReqCtx(c);
  if (error instanceof ApiError) {
    const headers: Record<string, string> = {};
    if (error.status === 401) headers["www-authenticate"] = 'Bearer realm="open-clone-plugin-author"';
    return Response.json(
      { ok: false, code: error.code, message: error.message, requestId: ctx.requestId },
      { status: error.status, headers },
    );
  }
  console.error("MCP_PLUGIN_UNHANDLED", error);
  return c.json({ ok: false, code: "INTERNAL", message: "内部エラーが発生しました" }, 500);
});

export default app;