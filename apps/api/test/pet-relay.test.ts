// AI ペット中継（POST /v1/pet/chat・/v1/pet/models）の試験。
//
// 対象:
// - 両形式の組み立て（system の位置、tools、tool の往復、連続する tool 結果のまとめ）
// - finishReason の対応と、名前が不正なツール呼び出しの破棄
// - エラー文の伏せ字（応答・ログのどこにもキーを出さない）
// - custom URL の拒否（http・私設 IP・localhost・このサイト自身）
// - モデル一覧（両形式・anthropic のページ送り・重複除去と並べ替え・上限での切り捨て）
//
// 事業者への通信は MSW でモックする（実事業者へは一切つながない）。

import { SELF } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  PET_LIMITS,
  PET_MODELS_MAX,
  randomHex,
  type PetChatRequest,
  type PetMessage,
  type PetModelsRequest,
  type PetToolSpec,
} from "shared";
import {
  normalizeAnthropicResponse,
  normalizeOpenAiResponse,
  mapFinishReason,
} from "../src/services/pet/normalize";
import { collectAnthropicModels } from "../src/services/pet/models";
import { extractProviderErrorText, redactSecrets, summarizeProviderMessage } from "../src/services/pet/redact";
import { resolvePetTarget } from "../src/services/pet/relay";
import { buildPetProviderRequest, toAnthropicMessages } from "../src/services/pet/request";
import { network } from "./network";

const ORIGIN = "http://localhost:3000";

const PAGE_CONTEXT_TOOL: PetToolSpec = {
  name: "get_page_context",
  description: "今の画面の情報を返す",
  parameters: { type: "object", properties: {} },
};

function chatRequest(overrides: Partial<PetChatRequest> = {}): PetChatRequest {
  return {
    provider: "openai",
    model: "test-model",
    system: "あなたはペットです",
    messages: [{ role: "user", content: "こんにちは" }],
    tools: [PAGE_CONTEXT_TOOL],
    ...overrides,
  };
}

interface CallOptions {
  key?: string | null;
  device?: string;
  ip?: string;
  body?: unknown;
}

interface CallResult {
  status: number;
  text: string;
  json: { ok?: boolean; data?: unknown; code?: string; message?: string; details?: unknown } | null;
}

async function call(path: string, options: CallOptions = {}): Promise<CallResult> {
  const headers = new Headers({
    origin: ORIGIN,
    "content-type": "application/json",
    cookie: `oc_did=${options.device ?? randomHex(16)}`,
    "x-real-ip": options.ip ?? `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  });
  const key = options.key === undefined ? `sk-test-${randomHex(8)}` : options.key;
  if (key !== null) headers.set("x-pet-api-key", key);
  const response = await SELF.fetch(`http://worker.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? chatRequest()),
  });
  const text = await response.text();
  let json: CallResult["json"] = null;
  try {
    json = JSON.parse(text) as CallResult["json"];
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

function expectApiError(fn: () => unknown, status: number, code: string): void {
  try {
    fn();
    expect.fail("ApiError が投げられませんでした");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    expect((error as ApiError).code).toBe(code);
  }
}

describe("要求の組み立て", () => {
  it("openai 形式: system を先頭に置き、tools と maxTokens を写す", () => {
    const built = buildPetProviderRequest({
      provider: "openai",
      protocol: "openai",
      endpoint: "https://api.example.test/v1/chat/completions",
      apiKey: "sk-test-123456",
      siteUrl: "https://site.example",
      request: chatRequest(),
    });
    expect(built.headers["authorization"]).toBe("Bearer sk-test-123456");
    expect(built.body).not.toHaveProperty("max_tokens");

    const messages = built.body["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "あなたはペットです" });
    expect(messages[1]).toEqual({ role: "user", content: "こんにちは" });
    expect(built.body["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "get_page_context",
          description: "今の画面の情報を返す",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);

    const withMax = buildPetProviderRequest({
      provider: "deepseek",
      protocol: "openai",
      endpoint: "https://api.example.test/v1/chat/completions",
      apiKey: "key",
      siteUrl: "",
      request: chatRequest({ maxTokens: 512 }),
    });
    expect(withMax.body["max_tokens"]).toBe(512);
  });

  it("openai 形式: assistant の tool_calls と tool の tool_call_id を対応させる", () => {
    const built = buildPetProviderRequest({
      provider: "openai",
      protocol: "openai",
      endpoint: "https://api.example.test/v1/chat/completions",
      apiKey: "key",
      siteUrl: "",
      request: chatRequest({
        messages: [
          { role: "user", content: "今の画面を教えて" },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "call_1", name: "get_page_context", arguments: '{"path":"/"}' }],
          },
          { role: "tool", toolCallId: "call_1", name: "get_page_context", content: '{"ok":true}' },
        ],
      }),
    });
    const messages = built.body["messages"] as Array<Record<string, unknown>>;
    expect(messages.map((message) => message["role"])).toEqual(["system", "user", "assistant", "tool"]);
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "get_page_context", arguments: '{"path":"/"}' } },
      ],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"ok":true}' });
  });

  it("openrouter には HTTP-Referer と X-Title を付ける", () => {
    const built = buildPetProviderRequest({
      provider: "openrouter",
      protocol: "openai",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: "key",
      siteUrl: "https://site.example",
      request: chatRequest(),
    });
    expect(built.headers["HTTP-Referer"]).toBe("https://site.example");
    expect(built.headers["X-Title"]).toBe("open-clone");
  });

  it("anthropic 形式: system は最上位、tools は input_schema、max_tokens は既定値", () => {
    const built = buildPetProviderRequest({
      provider: "anthropic",
      protocol: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      apiKey: "sk-ant-key",
      siteUrl: "",
      request: chatRequest({ provider: "anthropic" }),
    });
    expect(built.headers["x-api-key"]).toBe("sk-ant-key");
    expect(built.headers["anthropic-version"]).toBe("2023-06-01");
    expect(built.body["system"]).toBe("あなたはペットです");
    expect(built.body["max_tokens"]).toBe(PET_LIMITS.maxTokensDefault);
    expect(built.body["tools"]).toEqual([
      {
        name: "get_page_context",
        description: "今の画面の情報を返す",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(built.body["messages"]).toEqual([{ role: "user", content: "こんにちは" }]);
  });

  it("anthropic 形式: tool_use ブロックに直し、連続する tool 結果は 1 つの user にまとめる", () => {
    const messages: PetMessage[] = [
      { role: "user", content: "2 つ調べて" },
      {
        role: "assistant",
        content: "確認します",
        toolCalls: [
          { id: "call_1", name: "get_page_context", arguments: '{"path":"/"}' },
          { id: "call_2", name: "list_boards", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "call_1", name: "get_page_context", content: '{"ok":true}' },
      { role: "tool", toolCallId: "call_2", name: "list_boards", content: '{"ok":true}' },
    ];
    const converted = toAnthropicMessages(messages);
    expect(converted).toHaveLength(3);
    expect(converted[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "確認します" },
        { type: "tool_use", id: "call_1", name: "get_page_context", input: { path: "/" } },
        { type: "tool_use", id: "call_2", name: "list_boards", input: {} },
      ],
    });
    expect(converted[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: '{"ok":true}' },
        { type: "tool_result", tool_use_id: "call_2", content: '{"ok":true}' },
      ],
    });
  });

  it("anthropic 形式: 引数が JSON として読めない履歴は 400", () => {
    expectApiError(
      () =>
        toAnthropicMessages([
          { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "x", arguments: "{oops" }] },
        ]),
      400,
      "VALIDATION",
    );
  });
});

describe("応答の正規化", () => {
  it("finishReason を事業者ごとに対応付ける", () => {
    expect(mapFinishReason("stop", "openai")).toBe("stop");
    expect(mapFinishReason("tool_calls", "openai")).toBe("tool_calls");
    expect(mapFinishReason("length", "openai")).toBe("length");
    expect(mapFinishReason("content_filter", "openai")).toBe("other");
    expect(mapFinishReason(undefined, "openai")).toBe("other");
    expect(mapFinishReason("end_turn", "anthropic")).toBe("stop");
    expect(mapFinishReason("tool_use", "anthropic")).toBe("tool_calls");
    expect(mapFinishReason("max_tokens", "anthropic")).toBe("length");
    expect(mapFinishReason("stop_sequence", "anthropic")).toBe("other");
    expect(mapFinishReason("toString", "anthropic")).toBe("other");
  });

  it("openai: tool_calls を写し、名前が不正な呼び出しは捨てる", () => {
    const result = normalizeOpenAiResponse(
      {
        model: "gpt-mock",
        choices: [
          {
            message: {
              content: "調べます",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_page_context", arguments: '{"path":"/"}' } },
                { id: "call_2", type: "function", function: { name: "Bad-Name!", arguments: "{}" } },
                { id: "", type: "function", function: { name: "list_boards", arguments: "{}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      },
      "requested-model",
    );
    expect(result.message.content).toBe("調べます");
    expect(result.message.toolCalls).toEqual([
      { id: "call_1", name: "get_page_context", arguments: '{"path":"/"}' },
      { id: "call_2", name: "list_boards", arguments: "{}" },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.model).toBe("gpt-mock");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("anthropic: text をまとめ、tool_use の input を JSON 文字列にし、不正名は捨てる", () => {
    const result = normalizeAnthropicResponse(
      {
        model: "claude-mock",
        content: [
          { type: "text", text: "はい。" },
          { type: "text", text: "どうぞ。" },
          { type: "tool_use", id: "toolu_1", name: "get_page_context", input: { path: "/" } },
          { type: "tool_use", id: "toolu_2", name: "UPPER", input: {} },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      "requested-model",
    );
    expect(result.message.content).toBe("はい。どうぞ。");
    expect(result.message.toolCalls).toEqual([
      { id: "toolu_1", name: "get_page_context", arguments: '{"path":"/"}' },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.model).toBe("claude-mock");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});

describe("伏せ字", () => {
  it("キーの値・sk-・Bearer・AIza を伏せ、300 文字で切る", () => {
    const key = "sk-live-abcdef123456";
    const text = `Incorrect API key provided: ${key}. Authorization: Bearer ${key}. AIzaSyABCDEFGHIJKLMNOP`;
    const redacted = redactSecrets(text, key);
    expect(redacted).not.toContain(key);
    expect(redacted).toContain("[REDACTED]");
    expect(summarizeProviderMessage("x".repeat(1_000), key)).toHaveLength(300);
    expect(extractProviderErrorText('{"error":{"message":"bad key"}}')).toBe("bad key");
  });

  it("キーの変形（大文字小文字・URL エンコード・base64）も伏せる", () => {
    const key = "sk-e2e-AbCdEf123456";
    const variants = [
      key.toUpperCase(),
      "sk%2De2e%2DAbCdEf123456",
      "sk%2de2e%2dabcdef123456",
      "sk-e2e%2DAbCdEf123456",
      btoa(key),
      btoa(key).replace(/=+$/, ""),
    ];
    for (const variant of variants) {
      const redacted = redactSecrets(`Incorrect API key provided: ${variant}`, key);
      expect(redacted, variant).not.toContain(variant);
      expect(redacted).toContain("[REDACTED]");
    }
  });
});

describe("接続先の検査", () => {
  const base = {
    requestUrl: "http://worker.test/v1/pet/chat",
    allowedOrigins: "http://localhost:3000,https://site.example",
  };

  it("custom の http・私設 IP・localhost は 400", () => {
    for (const baseUrl of ["http://example.com/v1", "https://127.0.0.1/v1", "https://localhost/v1", "https://10.0.0.1/v1"]) {
      expectApiError(() => resolvePetTarget({ ...base, provider: "custom", baseUrl }), 400, "VALIDATION");
    }
  });

  it("このサイト自身は 400", () => {
    expectApiError(
      () => resolvePetTarget({ ...base, provider: "custom", baseUrl: "https://site.example/v1" }),
      400,
      "VALIDATION",
    );
  });

  it("IPv4 を埋め込んだ IPv6（mapped / compatible / NAT64）は 400", () => {
    // WHATWG URL はドット形式を 16 進 2 グループへ正規化する。両方の表記を試す。
    const privateForms = [
      "https://[::ffff:127.0.0.1]/v1",
      "https://[::ffff:7f00:1]/v1",
      "https://[::ffff:10.0.0.1]/v1",
      "https://[::ffff:a00:1]/v1",
      "https://[::127.0.0.1]/v1",
      "https://[::7f00:1]/v1",
      "https://[64:ff9b::127.0.0.1]/v1",
      "https://[64:ff9b::7f00:1]/v1",
    ];
    for (const baseUrl of privateForms) {
      expectApiError(() => resolvePetTarget({ ...base, provider: "custom", baseUrl }), 400, "VALIDATION");
    }

    // 公開 IPv4 を埋め込んだ同じ形式は通す（過剰拒否しない）。
    const publicForms = [
      "https://[::ffff:8.8.8.8]/v1",
      "https://[::ffff:808:808]/v1",
      "https://[::8.8.8.8]/v1",
      "https://[::808:808]/v1",
      "https://[64:ff9b::8.8.8.8]/v1",
      "https://[64:ff9b::808:808]/v1",
    ];
    for (const baseUrl of publicForms) {
      expect(resolvePetTarget({ ...base, provider: "custom", baseUrl }).protocol).toBe("openai");
    }
  });

  it("custom 以外の baseUrl は 400", () => {
    expectApiError(
      () => resolvePetTarget({ ...base, provider: "openai", baseUrl: "https://api.example.test/v1" }),
      400,
      "VALIDATION",
    );
  });

  it("プリセットと E2E 差し替えの送信先", () => {
    expect(resolvePetTarget({ ...base, provider: "openai" }).endpoint).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(resolvePetTarget({ ...base, provider: "anthropic" }).endpoint).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(
      resolvePetTarget({ ...base, provider: "openai", override: "http://127.0.0.1:8898/pet" }).endpoint,
    ).toBe("http://127.0.0.1:8898/pet/openai/chat/completions");
    expect(
      resolvePetTarget({ ...base, provider: "anthropic", override: "http://127.0.0.1:8898/pet/" }).endpoint,
    ).toBe("http://127.0.0.1:8898/pet/anthropic/messages");
  });
});

describe("CORS", () => {
  it("プリフライトで X-Pet-Api-Key を許可する（別オリジンからの直接呼び出し経路）", async () => {
    const response = await SELF.fetch("http://worker.test/v1/pet/chat", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-pet-api-key",
      },
    });
    expect(response.status).toBe(204);
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowed.toLowerCase()).toContain("x-pet-api-key");
    expect(allowed.toLowerCase()).toContain("content-type");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("POST /v1/pet/chat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("openai 形式の中継（system と tools が届き、応答を契約にそろえる）", async () => {
    let received: Record<string, unknown> | null = null;
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          model: "mock-model",
          choices: [{ message: { content: "了解しました" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        });
      }),
    );
    const result = await call("/v1/pet/chat");
    expect(result.status, result.text).toBe(200);
    expect(result.json?.ok).toBe(true);
    const data = result.json?.data as {
      message: { content: string };
      finishReason: string;
      model: string;
      usage: { inputTokens: number };
    };
    expect(data.message.content).toBe("了解しました");
    expect(data.finishReason).toBe("stop");
    expect(data.model).toBe("mock-model");
    expect(data.usage.inputTokens).toBe(3);
    expect(received).not.toBeNull();
    expect(received!["system"]).toBeUndefined();
    const messages = received!["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "あなたはペットです" });
    expect((received!["tools"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "function",
      function: { name: "get_page_context" },
    });
  });

  it("anthropic 形式の中継（system は最上位）", async () => {
    let received: Record<string, unknown> | null = null;
    network.use(
      http.post("https://api.anthropic.com/v1/messages", async ({ request }) => {
        received = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          model: "claude-mock",
          content: [{ type: "text", text: "はい" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    const result = await call("/v1/pet/chat", {
      body: chatRequest({ provider: "anthropic", model: "claude-test" }),
    });
    expect(result.status, result.text).toBe(200);
    const data = result.json?.data as { message: { content: string }; finishReason: string };
    expect(data.message.content).toBe("はい");
    expect(data.finishReason).toBe("stop");
    expect(received!["system"]).toBe("あなたはペットです");
    expect(received!["max_tokens"]).toBe(PET_LIMITS.maxTokensDefault);
    expect((received!["tools"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "get_page_context",
      input_schema: { type: "object" },
    });
  });

  it("キーが無い・不正なキーは 400", async () => {
    const missing = await call("/v1/pet/chat", { key: null });
    expect(missing.status).toBe(400);
    expect(missing.json?.code).toBe("VALIDATION");

    const badChars = await call("/v1/pet/chat", { key: "key\tvalue" });
    expect(badChars.status).toBe(400);
    expect(badChars.json?.code).toBe("VALIDATION");
  });

  it("事業者の 401 は 502 PET_PROVIDER_AUTH。応答にもログにもキーの値を出さない", async () => {
    const key = "sk-secret-should-not-leak-987654";
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", () =>
        HttpResponse.json({ error: { message: `Incorrect API key provided: ${key}` } }, { status: 401 }),
      ),
    );

    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    });
    const result = await call("/v1/pet/chat", { key });
    spy.mockRestore();

    expect(result.status).toBe(502);
    expect(result.json?.code).toBe("PET_PROVIDER_AUTH");
    expect(result.json?.message).toBe("AI 事業者が API キーを受け付けませんでした");
    expect(result.text).not.toContain(key);
    expect(result.text).not.toContain("sk-secret");
    for (const line of logged) expect(line).not.toContain(key);
  });

  it("要求本文が上限を超えたら 413", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: "user" as const,
      content: `${index}:`.padEnd(PET_LIMITS.messageMaxChars, "あ"),
    }));
    const result = await call("/v1/pet/chat", { body: chatRequest({ messages }) });
    expect(result.status).toBe(413);
    expect(result.json?.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("custom の http URL は 400（事業者へは送らない）", async () => {
    network.use(
      http.post("https://api.openai.com/v1/chat/completions", () => {
        throw new Error("実事業者へ送ってはいけない");
      }),
    );
    const result = await call("/v1/pet/chat", {
      body: chatRequest({ provider: "custom", baseUrl: "http://example.com/v1" }),
    });
    expect(result.status).toBe(400);
    expect(result.json?.code).toBe("VALIDATION");
  });
});

describe("POST /v1/pet/models", () => {
  const modelsRequest = (overrides: Partial<PetModelsRequest> = {}): PetModelsRequest => ({
    provider: "openai",
    ...overrides,
  });

  it("openai 形式の一覧を重複除去して id 順に返す", async () => {
    network.use(
      http.get("https://api.openai.com/v1/models", () =>
        HttpResponse.json({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }] }),
      ),
    );
    const result = await call("/v1/pet/models", { body: modelsRequest() });
    expect(result.status, result.text).toBe(200);
    expect(result.json?.data).toEqual({
      models: [
        { id: "a-model", label: null },
        { id: "z-model", label: null },
      ],
      truncated: false,
    });
  });

  it("anthropic 形式はページ送りし、表示名を保って重複を除く", async () => {
    const pages: string[] = [];
    network.use(
      http.get("https://api.anthropic.com/v1/models", ({ request }) => {
        const after = new URL(request.url).searchParams.get("after_id");
        pages.push(after ?? "first");
        if (after === null) {
          return HttpResponse.json({
            data: [
              { id: "b-claude", display_name: "B Claude" },
              { id: "a-claude", display_name: "A Claude" },
            ],
            has_more: true,
            last_id: "b-claude",
          });
        }
        return HttpResponse.json({
          data: [
            { id: "a-claude", display_name: "A Claude" },
            { id: "c-claude", display_name: "" },
          ],
          has_more: false,
          last_id: "c-claude",
        });
      }),
    );
    const result = await call("/v1/pet/models", {
      body: modelsRequest({ provider: "anthropic" }),
    });
    expect(result.status, result.text).toBe(200);
    expect(pages).toEqual(["first", "b-claude"]);
    expect(result.json?.data).toEqual({
      models: [
        { id: "a-claude", label: "A Claude" },
        { id: "b-claude", label: "B Claude" },
        { id: "c-claude", label: null },
      ],
      truncated: false,
    });
  });

  it("PET_MODELS_MAX を超えた分を捨てて truncated を立てる", async () => {
    const rows = Array.from({ length: PET_MODELS_MAX + 5 }, (_, index) => ({
      id: `model-${String(index).padStart(4, "0")}`,
    }));
    network.use(
      http.get("https://api.openai.com/v1/models", () => HttpResponse.json({ data: rows })),
    );
    const result = await call("/v1/pet/models", { body: modelsRequest() });
    expect(result.status, result.text).toBe(200);
    const data = result.json?.data as { models: unknown[]; truncated: boolean };
    expect(data.truncated).toBe(true);
    expect(data.models).toHaveLength(PET_MODELS_MAX);
  });

  it("anthropic のページ送りは全体期限を超えたら 504 PET_PROVIDER_TIMEOUT", async () => {
    const error = await collectAnthropicModels(
      "https://api.anthropic.com/v1",
      { "x-api-key": "sk-test-key", accept: "application/json" },
      "sk-test-key",
      Date.now() - 1,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(504);
    expect((error as ApiError).code).toBe("PET_PROVIDER_TIMEOUT");
  });

  it("キーが無い・custom の http は 400、bad-key は 502 PET_PROVIDER_AUTH", async () => {
    const missing = await call("/v1/pet/models", { key: null, body: modelsRequest() });
    expect(missing.status).toBe(400);

    const customHttp = await call("/v1/pet/models", {
      body: modelsRequest({ provider: "custom", baseUrl: "http://example.com/v1" }),
    });
    expect(customHttp.status).toBe(400);

    const key = "sk-models-secret-123456";
    network.use(
      http.get("https://api.openai.com/v1/models", () =>
        HttpResponse.json({ error: { message: `Incorrect API key provided: ${key}` } }, { status: 401 }),
      ),
    );
    const result = await call("/v1/pet/models", { key, body: modelsRequest() });
    expect(result.status).toBe(502);
    expect(result.json?.code).toBe("PET_PROVIDER_AUTH");
    expect(result.text).not.toContain(key);
  });
});