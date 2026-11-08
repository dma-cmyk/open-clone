#!/usr/bin/env node
// ローカル stdio ブリッジ（OMP / Claude Code / Codex 等の stdio MCP クライアント用）。
// リモートの Streamable HTTP MCP（/mcp）へ tools/list・tools/call をそのまま中継する。
// 使い方:
//   OPENCLONE_MCP_URL=http://127.0.0.1:8787/mcp OPENCLONE_AI_KEY=ocai_... \
//     node packages/mcp/src/bridge.mjs
// クライアント設定例（Claude Code / OMP の mcpServers）:
//   { "command": "node", "args": ["packages/mcp/src/bridge.mjs"],
//     "env": { "OPENCLONE_MCP_URL": "...", "OPENCLONE_AI_KEY": "ocai_..." } }

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const url = process.env.OPENCLONE_MCP_URL ?? "http://127.0.0.1:8787/mcp";
const key = process.env.OPENCLONE_AI_KEY;

if (!key) {
  console.error("OPENCLONE_AI_KEY が未設定です");
  process.exit(2);
}

let remotePromise = null;

/** リモート MCP に接続する（初回のみ・失敗時は次回再試行）。 */
function remoteClient() {
  if (!remotePromise) {
    remotePromise = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
      const client = new Client(
        { name: "openclone-mcp-bridge", version: "1.0.0" },
        { capabilities: {}, versionNegotiation: { mode: "auto" } },
      );
      client.onerror = (error) => console.error("BRIDGE_REMOTE_ERROR", error.message);
      await client.connect(transport);
      return client;
    })().catch((error) => {
      remotePromise = null;
      throw error;
    });
  }
  return remotePromise;
}

serveStdio(() => {
  const server = new Server(
    { name: "openclone-mcp-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => {
    const client = await remoteClient();
    return client.listTools();
  });

  server.setRequestHandler("tools/call", async (request) => {
    try {
      const client = await remoteClient();
      return await client.callTool(request.params);
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              code: "BRIDGE_ERROR",
              message: error instanceof Error ? error.message : "bridge failed",
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
});