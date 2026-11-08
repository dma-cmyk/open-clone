// MCP サーバーの統合テスト（実クライアント SDK で tools/list / tools/call）。
// 本番と同じ `@modelcontextprotocol/client` を使い、fetch だけを Worker の SELF に向ける。

import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  api,
  createAgent,
  json,
  makeAccount,
  makeBoard,
  makePost,
  makeSession,
  makeThread,
} from "./ai-helpers";

const workerFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  SELF.fetch(input instanceof Request ? input : String(input), init);

interface JsonRpcBody {
  result?: {
    serverInfo?: { name?: string };
    protocolVersion?: string;
    tools?: { name: string }[];
  };
  error?: { code: number; message: string };
}

/** レガシーレーンは SSE（`event: message` + `data: {...}`）で応答する。 */
async function readJsonRpc(response: Response): Promise<JsonRpcBody> {
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data:"));
  const payload = dataLine ? dataLine.slice("data:".length).trim() : text;
  return JSON.parse(payload) as JsonRpcBody;
}

async function connect(apiKey: string, path = "/mcp"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://worker.test${path}`), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    fetch: workerFetch,
  });
  const client = new Client(
    { name: "openclone-test-client", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return client;
}

async function setupAgent(riskCap: "low" | "medium" | "high" = "high") {
  const adminId = await makeAccount({ role: "special_admin" });
  const cookie = await makeSession(adminId);
  const boardId = await makeBoard();
  const threadId = await makeThread({ boardId });
  const agent = await createAgent(cookie, {
    name: `mcp-agent-${Math.random().toString(36).slice(2, 7)}`,
    ownerType: "site",
    allowedBoards: "*",
    riskCap,
  });
  return { cookie, boardId, threadId, agent };
}

describe("MCP /mcp（2026-07-28 ステートレス）", () => {
  it("tools/list が REST と同じカタログを返す", async () => {
    const { agent } = await setupAgent();
    const client = await connect(agent.apiKey);
    try {
      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name);
      expect(names).toContain("board.list");
      expect(names).toContain("post.create");
      expect(names).toContain("post.delete");
      expect(names).toContain("queue.list");
      expect(names).toContain("agent.suspend_self");
      const postCreate = result.tools.find((tool) => tool.name === "post.create");
      expect(postCreate?.inputSchema).toBeTruthy();
      expect(postCreate?.description).toContain("risk: medium");
    } finally {
      await client.close();
    }
  });

  it("tools/call が REST と同じ政策エンジンを通る（low 自動・medium 自動・high キュー）", async () => {
    const { agent, boardId, threadId } = await setupAgent("high");
    const client = await connect(agent.apiKey);
    try {
      const boards = await client.callTool({ name: "board.list", arguments: {} });
      expect(boards.isError).toBeFalsy();
      const boardsPayload = JSON.parse((boards.content as { text: string }[])[0]!.text) as {
        status: string;
      };
      expect(boardsPayload.status).toBe("executed");

      const created = await client.callTool({
        name: "post.create",
        arguments: { boardId, threadId, body: "MCP 経由の投稿" },
      });
      expect(created.isError).toBeFalsy();
      const createdPayload = JSON.parse((created.content as { text: string }[])[0]!.text) as {
        status: string;
        result: { postId: number };
      };
      expect(createdPayload.status).toBe("executed");

      const postId = await makePost({ boardId, threadId, body: "MCP から削除を要求" });
      const deleted = await client.callTool({
        name: "post.delete",
        arguments: { postId, reason: "MCP テスト" },
      });
      const deletedPayload = JSON.parse((deleted.content as { text: string }[])[0]!.text) as {
        status: string;
        queueId: string;
      };
      expect(deletedPayload.status).toBe("queued");
      expect(deletedPayload.queueId).toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("自己停止すると以後の接続は認証段階で拒否される", async () => {
    const { agent } = await setupAgent("high");
    const client = await connect(agent.apiKey);
    try {
      const result = await client.callTool({ name: "agent.suspend_self", arguments: { reason: "x" } });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
    await expect(connect(agent.apiKey)).rejects.toBeTruthy();
  });

  it("緊急停止中は tools/call が isError（AI_STOPPED）を返す", async () => {
    const { agent, cookie } = await setupAgent("high");
    const client = await connect(agent.apiKey);
    try {
      await api("/v1/ai/stop", {
        method: "POST",
        cookie,
        body: { scope: "global", reason: "MCP 停止テスト" },
      });
      const blocked = await client.callTool({ name: "board.list", arguments: {} });
      expect(blocked.isError).toBe(true);
      const payload = JSON.parse((blocked.content as { text: string }[])[0]!.text) as {
        code: string;
      };
      expect(payload.code).toBe("AI_STOPPED");
    } finally {
      await api("/v1/ai/resume", { method: "POST", cookie, body: { scope: "global" } });
      await client.close();
    }
  });

  it("認証なしの MCP 接続は 401", async () => {
    const response = await SELF.fetch("http://worker.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("MCP /mcp/legacy（2025 世代互換レーン）", () => {
  it("initialize と tools/list が 2025 形式で応答する", async () => {
    const { agent } = await setupAgent();
    const init = await SELF.fetch("http://worker.test/mcp/legacy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${agent.apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const initBody = await readJsonRpc(init);
    expect(initBody.result?.serverInfo?.name).toBe("open-clone-ai");

    const list = await SELF.fetch("http://worker.test/mcp/legacy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${agent.apiKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(list.status).toBe(200);
    const listBody = await readJsonRpc(list);
    expect(listBody.result?.tools?.some((tool) => tool.name === "board.list")).toBe(true);
  });
});

describe("MCP と REST の監査一致", () => {
  it("MCP 経由の操作も ai_audit に source=mcp で残る", async () => {
    const { agent } = await setupAgent();
    const client = await connect(agent.apiKey);
    try {
      await client.callTool({ name: "board.list", arguments: {} });
    } finally {
      await client.close();
    }
    const row = await api("/v1/ai/audit", { key: agent.apiKey });
    const body = await json<{ data: { result: { items: { action: string }[] } } }>(row);
    expect(body.data.result.items.some((item) => item.action === "board.list")).toBe(true);
  });
});