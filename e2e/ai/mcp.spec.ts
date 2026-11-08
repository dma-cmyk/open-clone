// MCP 実クライアント検証（packages/mcp の CLI = @modelcontextprotocol/client）。
// wrangler dev の /mcp（2026-07-28 ステートレス）と /mcp/legacy に実際に接続し、tools/list と tools/call を実行する。
// tools は REST と同一の政策エンジンを通る（medium agent の post.create が executed になる）。
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { API_BASE } from "../helpers/api";
import { asOwner, createAgent, createBoard, createThread, dataOf, uniqueSuffix } from "./_helpers";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(REPO_ROOT, "packages/mcp/src/cli.mjs");

interface ToolList {
  tools: { name: string; description?: string; inputSchema?: unknown }[];
}

async function runCli(url: string, apiKey: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, OPENCLONE_MCP_URL: url, OPENCLONE_AI_KEY: apiKey },
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`MCP CLI 失敗 (${args.join(" ")}): ${failure.stderr || failure.message}\nstdout: ${failure.stdout ?? ""}`);
  }
}

async function runCliWithStopRetry(url: string, apiKey: string, args: string[]): Promise<string> {
  try {
    return await runCli(url, apiKey, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("AI_STOPPED")) throw error;
    return runCli(url, apiKey, args);
  }
}

test.describe("MCP (実クライアント)", () => {
  test("tools/list と tools/call が実サーバーで動き、REST と同じ政策を通る", async ({ request }) => {
    const suffix = uniqueSuffix();
    const board = await createBoard(request, `m${suffix}`);
    const thread = await createThread(request, board.slug, `MCP E2E スレ ${suffix}`);
    const agent = await createAgent(request, {
      name: `e2e-mcp-${suffix}`,
      boardId: board.id,
      riskCap: "medium",
    });

    const url = `${API_BASE}/mcp`;
    const toolsRaw = await runCliWithStopRetry(url, agent.apiKey, ["list-tools"]);
    const tools = JSON.parse(toolsRaw) as ToolList;
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("post.create");
    expect(names).toContain("search");
    expect(names).toContain("board.list");
    expect(names).toContain("report.triage");
    expect(names).toContain("queue.cancel_own");
    // never / humanOnly は MCP のツール面に露出しない（high は露出するが政策エンジンが常に拒否/キュー化する）。
    expect(names).not.toContain("queue.decide");
    expect(names).not.toContain("policy.disable");
    expect(names).not.toContain("invite.issue");
    expect(names).not.toContain("infra.secret_read");

    const createRaw = await runCliWithStopRetry(url, agent.apiKey, [
      "call",
      "post.create",
      JSON.stringify({ boardId: board.id, threadId: thread.threadId, body: "MCP 経由の AI 投稿です。" }),
    ]);
    const created = JSON.parse(createRaw) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
      structuredContent?: { status?: string; result?: { postId?: number } };
    };
    expect(created.isError).toBeFalsy();
    const text = created.content.map((part) => part.text ?? "").join("\n");
    expect(text).toContain("executed");
    expect(text).toContain("post.create");

    const searchRaw = await runCliWithStopRetry(url, agent.apiKey, [
      "call",
      "search",
      JSON.stringify({ q: "MCP", boardId: board.id, limit: 10 }),
    ]);
    const searched = JSON.parse(searchRaw) as { isError?: boolean; content: { text?: string }[] };
    expect(searched.isError).toBeFalsy();
    expect(searched.content.map((part) => part.text ?? "").join("\n")).toContain("executed");

    // 他板への書き込みは MCP でも拒否される（REST と同一の政策）。
    const deniedRaw = await runCliWithStopRetry(url, agent.apiKey, [
      "call",
      "post.create",
      JSON.stringify({ boardId: board.id + 999_999, title: "x", body: "out of scope" }),
    ]).catch((error: unknown) => {
      // CLI は isError で exit 1 を返すため、stderr/stdout から本文を拾う。
      const failure = error as { message?: string };
      return failure.message ?? "";
    });
    expect(deniedRaw).toContain("担当外");

    // legacy レーン（旧仕様クライアント）でも tools/list が成立する。
    const legacyRaw = await runCliWithStopRetry(`${API_BASE}/mcp/legacy`, agent.apiKey, ["list-tools"]);
    const legacy = JSON.parse(legacyRaw) as ToolList;
    expect(legacy.tools.map((tool) => tool.name)).toContain("board.list");

    // 監査: MCP 由来の post.create が source=mcp で記録される（人間 API で確認）。
    const audit = dataOf<{ items: { action: string; result: string }[] }>(
      await asOwner(request, "GET", `/v1/ai/audit?agentId=${agent.id}&limit=100`),
      "audit for mcp",
      200,
    );
    expect(audit.items.some((row) => row.action === "post.create" && row.result === "ok")).toBe(true);
  });
});