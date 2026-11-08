#!/usr/bin/env node
// おーぷんクローン MCP クライアント CLI。
// 使い方:
//   OPENCLONE_MCP_URL=http://127.0.0.1:8787/mcp OPENCLONE_AI_KEY=ocai_... \
//     node packages/mcp/src/cli.mjs list-tools
//   ... node packages/mcp/src/cli.mjs call post.create '{"boardId":1,"threadId":2,"body":"テスト"}'
// 認証は Bearer キー（AI 管理者）。stdout に JSON を出す（パイプ処理向け）。

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const url = process.env.OPENCLONE_MCP_URL ?? "http://127.0.0.1:8787/mcp";
  const key = process.env.OPENCLONE_AI_KEY;
  return { command, rest, url, key };
}

async function withClient(url, key, fn) {
  if (!key) {
    console.error("OPENCLONE_AI_KEY が未設定です（AI 管理者の API キー ocai_... を渡してください）");
    process.exit(2);
  }
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: "openclone-mcp-cli", version: "1.0.0" }, { capabilities: {}, versionNegotiation: { mode: "auto" } });
  client.onerror = (error) => console.error("MCP_CLIENT_ERROR", error.message);
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const { command, rest, url, key } = parseArgs(process.argv.slice(2));

if (command === "list-tools") {
  const result = await withClient(url, key, (client) => client.listTools());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === "call") {
  const [name, paramsJson] = rest;
  if (!name) {
    console.error("使い方: cli.mjs call <tool-name> [json-params]");
    process.exit(2);
  }
  let params = {};
  if (paramsJson) {
    try {
      params = JSON.parse(paramsJson);
    } catch (error) {
      console.error(`パラメータ JSON が不正です: ${error.message}`);
      process.exit(2);
    }
  }
  const result = await withClient(url, key, (client) =>
    client.callTool({ name, arguments: params }),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.isError ? 1 : 0);
} else {
  console.error("コマンド: list-tools | call <tool-name> [json-params]");
  process.exit(2);
}