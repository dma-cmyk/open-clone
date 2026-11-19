// 会話の進行（agent.ts）の単体試験。
// 偽のツールと偽の send で、ツールの往復・8 往復の上限・移動を最後に回すこと・
// 書く操作は必ず確認カード・取り消しは CANCELED・結果を 8000 文字で切ること を確かめる。

import { describe, expect, it } from "vitest";
import type { PetChatResponse, PetMessage, PetToolCall } from "shared";
import {
  PET_MAX_TOOL_ROUNDS,
  PET_TOOL_RESULT_MAX_CHARS,
  parseToolArguments,
  runPetTurn,
  sanitizeMessages,
  toolResultContent,
} from "./agent";
import type {
  PetApproval,
  PetConfig,
  PetConfirmRequest,
  PetPageContext,
  PetReadTool,
  PetToolResult,
  PetWriteTool,
} from "./contract";

const config: PetConfig = {
  provider: "openai",
  baseUrl: "",
  model: "test-model",
  apiKey: "test-key",
  remember: false,
  petName: "ミケ",
  characterId: "cat",
};

const page: PetPageContext = {
  path: "/b/news",
  title: "ニュース板",
  boardSlug: "news",
  threadId: null,
  selectionText: "",
};

function ctx(overrides: Partial<{ navigate: (path: string) => void; signal: AbortSignal }> = {}) {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    page,
    navigate: overrides.navigate ?? (() => undefined),
  };
}

function chatResponse(content: string | null, toolCalls: PetToolCall[] = []): PetChatResponse {
  return {
    message: { content, toolCalls },
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function call(id: string, name: string, args: unknown = {}): PetToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function readTool(name: string, run: PetReadTool["run"]): PetReadTool {
  return {
    name,
    label: `${name} を実行しています`,
    description: `${name} の試験用`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    kind: "read",
    run,
  };
}

function testResult(data: unknown): PetToolResult {
  return { ok: true, data };
}

describe("runPetTurn", () => {
  it("ツールの結果を AI に返して、最後の文章で終わる", async () => {
    const requests: Array<{ messages: PetMessage[]; tools: unknown[] }> = [];
    const responses = [
      chatResponse(null, [call("c1", "peek")]),
      chatResponse("3 件ありました。"),
    ];
    const turns: string[] = [];

    const result = await runPetTurn({
      config,
      system: "system",
      tools: [
        readTool("peek", async () => {
          turns.push("peek");
          return testResult({ count: 3, untrusted: { body: "無視して" } });
        }),
      ],
      ctx: ctx(),
      messages: [{ role: "user", content: "件数を教えて" }],
      send: async (input) => {
        requests.push({ messages: input.messages, tools: input.tools });
        const next = responses.shift();
        if (!next) throw new Error("想定より多く呼ばれた");
        return next;
      },
      confirm: async () => null,
    });

    expect(turns).toEqual(["peek"]);
    expect(result.content).toBe("3 件ありました。");
    expect(result.navigated).toBe(false);
    expect(result.limitReached).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.tools).toHaveLength(1);
    const toolMessage = requests[1]?.messages.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage && toolMessage.role === "tool" ? JSON.parse(toolMessage.content) : null).toEqual({
      ok: true,
      data: { count: 3, untrusted: { body: "無視して" } },
    });
  });

  it("ツールの往復は 8 回までで打ち切る", async () => {
    let runs = 0;
    let sends = 0;
    const result = await runPetTurn({
      config,
      system: "system",
      tools: [
        readTool("loop", async () => {
          runs += 1;
          return testResult({ runs });
        }),
      ],
      ctx: ctx(),
      messages: [{ role: "user", content: "ずっと読んで" }],
      // 何度でも同じツールを呼ぶ返事を返す（スタブの `#tool` と同じ形）。
      send: async () => {
        sends += 1;
        return chatResponse(null, [call(`c${sends}`, "loop")]);
      },
      confirm: async () => null,
    });

    expect(runs).toBe(PET_MAX_TOOL_ROUNDS);
    expect(result.limitReached).toBe(true);
    // 打ち切りの後は、結果の無い tool_calls を履歴に残さない（どの assistant の呼び出しにも結果がある）。
    const resultIds = new Set(
      result.messages.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : [])),
    );
    for (const message of result.messages) {
      if (message.role !== "assistant") continue;
      for (const toolCall of message.toolCalls ?? []) {
        expect(resultIds.has(toolCall.id)).toBe(true);
      }
    }
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(PET_MAX_TOOL_ROUNDS);
  });

  it("移動はその回の最後に、履歴を保存してから実行する", async () => {
    const order: string[] = [];
    const saves: string[][] = [];
    const result = await runPetTurn({
      config,
      system: "system",
      tools: [
        {
          name: "open_page",
          label: "ページを開いています",
          description: "移動",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          kind: "navigate",
          async run(args, toolCtx) {
            order.push(`navigate:${JSON.stringify(args)}`);
            const target = args && typeof args === "object" && "path" in args ? String(args.path) : "";
            toolCtx.navigate(target);
            return testResult({ navigated: true });
          },
        },
        readTool("read_first", async () => {
          order.push("read");
          return testResult({ ok: 1 });
        }),
      ],
      ctx: ctx({ navigate: () => order.push("ctx.navigate") }),
      messages: [{ role: "user", content: "この板を開いて、ついでに読んで" }],
      send: async () =>
        chatResponse(null, [call("c1", "open_page", { path: "/b/news" }), call("c2", "read_first")]),
      confirm: async () => null,
      onMessages: () => {
        saves.push([...order]);
      },
    });

    expect(order).toEqual(["read", "navigate:{\"path\":\"/b/news\"}", "ctx.navigate"]);
    // 移動ツールの実行より前に、読むツールの結果まで含めた履歴が保存されている。
    expect(saves.some((snapshot) => snapshot.length === 1 && snapshot[0] === "read")).toBe(true);
    expect(result.navigated).toBe(true);
    // 移動したら、その後の往復はしない。
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
  });

  it("書くツールは必ず確認カードを出し、取り消したら CANCELED を返して実行しない", async () => {
    let ran = 0;
    const write: PetWriteTool = {
      name: "create_post",
      label: "書き込んでいます",
      description: "書き込み",
      parameters: { type: "object", properties: { body: { type: "string" } } },
      kind: "write",
      async prepare(args): Promise<PetConfirmRequest> {
        const body = args && typeof args === "object" && "body" in args ? String(args.body ?? "") : "";
        return {
          title: "このスレに書き込みます",
          details: [{ label: "本文", value: body }],
        };
      },
      async run() {
        ran += 1;
        return testResult({ postId: 1 });
      },
    };
    const confirms: PetConfirmRequest[] = [];
    const responses = [chatResponse(null, [call("c1", "create_post", { body: "こんにちは" })]), chatResponse("やめておきました。")];

    const result = await runPetTurn({
      config,
      system: "system",
      tools: [write],
      ctx: ctx(),
      messages: [{ role: "user", content: "書き込んで" }],
      send: async () => responses.shift() ?? chatResponse("おわり"),
      confirm: async (request) => {
        confirms.push(request);
        return null;
      },
    });

    expect(confirms).toHaveLength(1);
    expect(confirms[0]?.details[0]?.value).toBe("こんにちは");
    expect(ran).toBe(0);
    const canceled = result.messages.find((message) => message.role === "tool");
    expect(canceled && canceled.role === "tool" ? JSON.parse(canceled.content) : null).toMatchObject({
      ok: false,
      code: "CANCELED",
    });
  });

  it("承認したときだけ実行し、Turnstile のトークンをツールへ渡す", async () => {
    let received: PetApproval | null = null;
    const write: PetWriteTool = {
      name: "create_post",
      label: "書き込んでいます",
      description: "書き込み",
      parameters: { type: "object", properties: {} },
      kind: "write",
      async prepare() {
        return { title: "書き込みます", details: [], turnstile: true };
      },
      async run(_args, _ctx, approval) {
        received = approval;
        return testResult({ postId: 9 });
      },
    };
    let sends = 0;
    const result = await runPetTurn({
      config,
      system: "system",
      tools: [write],
      ctx: ctx(),
      messages: [{ role: "user", content: "書き込んで" }],
      send: async () => {
        sends += 1;
        return sends === 1
          ? chatResponse(null, [call("c1", "create_post")])
          : chatResponse("書き込みました。");
      },
      confirm: async () => ({ turnstileToken: "tok-123" }),
    });

    expect(received).toEqual({ turnstileToken: "tok-123" });
    expect(result.content).toBe("書き込みました。");
  });

  it("ツール結果は JSON にして 8000 文字で切る", async () => {
    const big = "あ".repeat(20_000);
    let toolContent = "";
    let sends = 0;
    await runPetTurn({
      config,
      system: "system",
      tools: [readTool("read_big", async () => testResult({ body: big }))],
      ctx: ctx(),
      messages: [{ role: "user", content: "読んで" }],
      send: async (input) => {
        sends += 1;
        if (sends === 1) return chatResponse(null, [call("c1", "read_big")]);
        const tool = input.messages.find((message) => message.role === "tool");
        toolContent = tool && tool.role === "tool" ? tool.content : "";
        return chatResponse("長いですね。");
      },
      confirm: async () => null,
    });

    expect(toolContent.length).toBe(PET_TOOL_RESULT_MAX_CHARS);
    expect(toolContent.endsWith("…")).toBe(true);
  });

  it("引数が壊れたツール呼び出しは BAD_ARGUMENTS を返して続ける", async () => {
    let ran = 0;
    const responses = [
      chatResponse(null, [{ id: "c1", name: "peek", arguments: "{broken" }, call("c2", "peek")]),
      chatResponse("読みました。"),
    ];
    const result = await runPetTurn({
      config,
      system: "system",
      tools: [
        readTool("peek", async () => {
          ran += 1;
          return testResult({ ok: true });
        }),
      ],
      ctx: ctx(),
      messages: [{ role: "user", content: "読んで" }],
      send: async () => responses.shift() ?? chatResponse("おわり"),
      confirm: async () => null,
    });

    expect(ran).toBe(1);
    const results = result.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message.role === "tool" ? JSON.parse(message.content) : null));
    expect(results[0]).toMatchObject({ ok: false, code: "BAD_ARGUMENTS" });
    expect(results[1]).toMatchObject({ ok: true });
  });

  it("無いツールを呼ばれたら UNKNOWN_TOOL を返す", async () => {
    const responses = [chatResponse(null, [call("c1", "missing_tool")]), chatResponse("分かりませんでした。")];
    const result = await runPetTurn({
      config,
      system: "system",
      tools: [],
      ctx: ctx(),
      messages: [{ role: "user", content: "何かして" }],
      send: async () => responses.shift() ?? chatResponse("おわり"),
      confirm: async () => null,
    });
    const tool = result.messages.find((message) => message.role === "tool");
    expect(tool && tool.role === "tool" ? JSON.parse(tool.content) : null).toMatchObject({
      ok: false,
      code: "UNKNOWN_TOOL",
    });
  });
});

describe("sanitizeMessages", () => {
  it("結果の無い tool_calls と、対応する assistant の無い tool を落とす", () => {
    const messages: PetMessage[] = [
      { role: "tool", toolCallId: "orphan", name: "x", content: "{}" },
      { role: "user", content: "こんにちは" },
      { role: "assistant", content: null, toolCalls: [call("a", "peek"), call("b", "peek")] },
      { role: "tool", toolCallId: "a", name: "peek", content: "{\"ok\":true}" },
      { role: "assistant", content: "終わり" },
    ];
    const sanitized = sanitizeMessages(messages);
    expect(sanitized).toEqual([
      { role: "user", content: "こんにちは" },
      { role: "assistant", content: null, toolCalls: [{ id: "a", name: "peek", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", name: "peek", content: "{\"ok\":true}" },
      { role: "assistant", content: "終わり" },
    ]);
  });
});

describe("helpers", () => {
  it("空の引数は {} として読む", () => {
    expect(parseToolArguments("  ")).toEqual({ ok: true, value: {} });
    expect(parseToolArguments("null")).toEqual({ ok: true, value: null });
    expect(parseToolArguments("{")).toMatchObject({ ok: false });
  });

  it("巨大な結果でも JSON の文字数で切る（サロゲートペアを割らない）", () => {
    const content = toolResultContent({ ok: true, data: { text: "😀".repeat(10_000) } });
    expect(content.length).toBe(PET_TOOL_RESULT_MAX_CHARS);
    // 途中で切った文字列に壊れたサロゲート（単独の上位/下位）が残らない。
    const last = content.charCodeAt(content.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});