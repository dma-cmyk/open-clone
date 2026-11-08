// MCP パッケージ（ツール定義の再輸出・接続ヘルパ・プロンプト）。
// サーバー実装は apps/api/src/routes/mcp.ts。このパッケージは「接続する側」と
// 「接続 AI に配る指示文」の正本を提供する（docs/mcp.md と整合）。

export {
  AI_SYSTEM_PROMPT_TEMPLATE,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  actionForToolName,
  mcpToolDescriptors,
  wrapUntrustedContent,
  type McpPolicyResult,
  type McpToolDefinition,
} from "shared";

import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "shared";

/** MCP エンドポイント（DESIGN §10.1）。 */
export const MCP_ENDPOINTS = {
  modern: "/mcp",
  legacy: "/mcp/legacy",
} as const;

/**
 * API ベース URL から MCP エンドポイントを組み立てる。
 * 例: `mcpEndpointUrl("https://api.example.com", "modern")` → `https://api.example.com/mcp`
 */
export function mcpEndpointUrl(
  apiBaseUrl: string,
  lane: keyof typeof MCP_ENDPOINTS = "modern",
): string {
  return `${apiBaseUrl.replace(/\/$/, "")}${MCP_ENDPOINTS[lane]}`;
}

/** MCP クライアント実装情報（接続ログ・serverInfo） */
export const MCP_CLIENT_INFO = {
  name: `${MCP_SERVER_NAME}-client`,
  version: MCP_SERVER_VERSION,
} as const;

/** 接続 AI に同梱するプロンプトファイル（packages/mcp/prompts）。 */
export const PROMPT_FILES = {
  system: "prompts/system.md",
  monitoring: "prompts/monitoring.md",
  reportTriage: "prompts/report-triage.md",
} as const;