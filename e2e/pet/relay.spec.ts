// AI ペット中継（POST /v1/pet/chat・/v1/pet/models）の E2E。
//
// API 直叩きだけの試験（画面は DSPetUI の担当）。事業者への通信はすべて `e2e/scripts/stub-server.mjs`
// へ差し替えられている（`start-api.sh` が PET_PROVIDER_BASE_OVERRIDE を渡す）。
//
// 確かめること:
// - openai / anthropic の成功と、system・tools が中継で届くこと（`/pet/__last`）
// - ツール呼び出しの往復（両形式。anthropic は tool_result のまとめ）
// - キー無しは 400、`bad-key` は 502 PET_PROVIDER_AUTH で応答にキーの値が出ない
// - custom の http URL は 400
// - 回数制限（1 分 20 回）
// - モデル一覧（openai / anthropic・bad-key・custom の http 拒否）

import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { fakeDeviceId, unique } from "../helpers/ids";
import { resetStubs, stubUrl } from "../helpers/stubs";

interface PetChatEnvelope {
  message: {
    content: string | null;
    toolCalls: { id: string; name: string; arguments: string }[];
  };
  finishReason: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

interface PetModelsEnvelope {
  models: { id: string; label: string | null }[];
  truncated: boolean;
}

interface StubLastRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

interface ErrorEnvelope {
  ok?: boolean;
  code?: string;
  message?: string;
}

/** 応答本文（外部）から、検証しながら error envelope の項目だけ読む。 */
function readErrorEnvelope(text: string): ErrorEnvelope {
  const parsed: unknown = JSON.parse(text);
  const envelope: ErrorEnvelope = {};
  if (typeof parsed !== "object" || parsed === null) return envelope;
  if ("ok" in parsed && typeof parsed.ok === "boolean") envelope.ok = parsed.ok;
  if ("code" in parsed && typeof parsed.code === "string") envelope.code = parsed.code;
  if ("message" in parsed && typeof parsed.message === "string") envelope.message = parsed.message;
  return envelope;
}

const PAGE_CONTEXT_TOOL = {
  name: "get_page_context",
  description: "今の画面の情報を返す",
  parameters: { type: "object", properties: {} },
};

// 匿名の回数制限は端末＋IP で数える。`wrangler dev` は cf-connecting-ip を 127.0.0.1 にするため、
// x-real-ip だけでは全試験が同じ IP 窓を共有してしまう（20 回/分をすぐ使い切る）。
// cf-connecting-ip はクライアント指定がそのまま届くので、試験ごとに一意にする。
// pc / mobile は別プロセスなので、接頭辞もプロセスごとに乱数で分ける。
const [IP_PREFIX_HI = 1, IP_PREFIX_LO = 1] = randomBytes(2);
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `198.51.${IP_PREFIX_HI}.${(IP_PREFIX_LO + ipSeq) % 256}`;
}

function petHeaders(key: string | null, device: string, ip: string): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    "cf-connecting-ip": ip,
    Cookie: `oc_did=${device}`,
    ...(key === null ? {} : { "X-Pet-Api-Key": key }),
  };
}

function chatBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openai",
    model: "stub-model",
    system: "あなたはペットです",
    messages: [{ role: "user", content: "こんにちは" }],
    tools: [PAGE_CONTEXT_TOOL],
    ...overrides,
  };
}

async function lastStubRequest(): Promise<StubLastRequest> {
  const response = await fetch(stubUrl("/pet/__last"));
  expect(response.ok).toBe(true);
  return (await response.json()) as StubLastRequest;
}

test.describe("中継 API", () => {
  test.beforeEach(async () => {
    await resetStubs();
  });

  test("openai: 成功し、system と tools が事業者へ届く", async ({ request }) => {
    const device = fakeDeviceId();
    const response = await request.post(`${API_BASE}/v1/pet/chat`, {
      headers: petHeaders(`sk-e2e-openai-${unique("k")}`, device, nextIp()),
      data: chatBody(),
    });
    expect(response.status(), await response.text()).toBe(200);
    const envelope = await readEnvelope<PetChatEnvelope>(response);
    expect(envelope?.ok).toBe(true);
    const data = envelope?.ok ? envelope.data : null;
    expect(data?.message.content).toBe("了解: こんにちは");
    expect(data?.message.toolCalls).toEqual([]);
    expect(data?.finishReason).toBe("stop");
    expect(data?.model).toBe("stub-model");

    const last = await lastStubRequest();
    expect(last.path).toBe("/pet/openai/chat/completions");
    expect(last.body["system"]).toBeUndefined();
    expect((last.body["messages"] as unknown[])[0]).toEqual({ role: "system", content: "あなたはペットです" });
    expect((last.body["messages"] as unknown[])[1]).toEqual({ role: "user", content: "こんにちは" });
    const tools = last.body["tools"] as Array<{ type: string; function: { name: string } }>;
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function.name).toBe("get_page_context");
  });

  test("anthropic: 成功し、system は最上位・tools は input_schema", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/chat`, {
      headers: petHeaders(`sk-e2e-anthropic-${unique("k")}`, fakeDeviceId(), nextIp()),
      data: chatBody({ provider: "anthropic", model: "stub-claude-test", messages: [{ role: "user", content: "おはよう" }] }),
    });
    expect(response.status(), await response.text()).toBe(200);
    const envelope = await readEnvelope<PetChatEnvelope>(response);
    const data = envelope?.ok ? envelope.data : null;
    expect(data?.message.content).toBe("了解: おはよう");
    expect(data?.finishReason).toBe("stop");
    expect(data?.model).toBe("stub-claude-test");

    const last = await lastStubRequest();
    expect(last.path).toBe("/pet/anthropic/messages");
    expect(last.body["system"]).toBe("あなたはペットです");
    expect(last.body["max_tokens"]).toBe(2048);
    const tools = last.body["tools"] as Array<{ name: string; input_schema: unknown }>;
    expect(tools[0]?.name).toBe("get_page_context");
    expect(tools[0]?.input_schema).toEqual({ type: "object", properties: {} });
  });

  for (const provider of ["openai", "anthropic"] as const) {
    test(`${provider}: ツール呼び出しの往復`, async ({ request }) => {
      const headers = petHeaders(`sk-e2e-tool-${unique("k")}`, fakeDeviceId(), nextIp());

      const first = await request.post(`${API_BASE}/v1/pet/chat`, {
        headers,
        data: chatBody({
          provider,
          messages: [{ role: "user", content: '#tool get_page_context {"path":"/"}' }],
        }),
      });
      expect(first.status(), await first.text()).toBe(200);
      const firstEnvelope = await readEnvelope<PetChatEnvelope>(first);
      const firstData = firstEnvelope?.ok ? firstEnvelope.data : null;
      expect(firstData?.finishReason).toBe("tool_calls");
      expect(firstData?.message.content).toBeNull();
      expect(firstData?.message.toolCalls).toHaveLength(1);
      const call = firstData?.message.toolCalls[0];
      expect(call?.name).toBe("get_page_context");
      expect(call?.arguments).toBe('{"path":"/"}');
      expect(call?.id).toMatch(/^call_\d+$/);

      const second = await request.post(`${API_BASE}/v1/pet/chat`, {
        headers,
        data: chatBody({
          provider,
          messages: [
            { role: "user", content: '#tool get_page_context {"path":"/"}' },
            { role: "assistant", content: null, toolCalls: [call] },
            { role: "tool", toolCallId: call!.id, name: "get_page_context", content: '{"ok":true}' },
          ],
        }),
      });
      expect(second.status(), await second.text()).toBe(200);
      const secondEnvelope = await readEnvelope<PetChatEnvelope>(second);
      const secondData = secondEnvelope?.ok ? secondEnvelope.data : null;
      expect(secondData?.message.content).toBe('ツール結果(get_page_context): {"ok":true}');
      expect(secondData?.finishReason).toBe("stop");
      expect(secondData?.message.toolCalls).toEqual([]);

      // 中継が tool の往復を事業者の形に直していること。
      const last = await lastStubRequest();
      const messages = last.body["messages"] as Array<Record<string, unknown>>;
      const lastMessage = messages[messages.length - 1]!;
      if (provider === "openai") {
        expect(lastMessage["role"]).toBe("tool");
        expect(lastMessage["tool_call_id"]).toBe(call!.id);
      } else {
        expect(lastMessage["role"]).toBe("user");
        const blocks = lastMessage["content"] as Array<Record<string, unknown>>;
        expect(blocks[0]?.["type"]).toBe("tool_result");
        expect(blocks[0]?.["tool_use_id"]).toBe(call!.id);
        const assistant = messages[messages.length - 2]!;
        const assistantBlocks = assistant["content"] as Array<Record<string, unknown>>;
        const toolUse = assistantBlocks.find((block) => block["type"] === "tool_use");
        expect(toolUse?.["input"]).toEqual({ path: "/" });
      }
    });
  }

  test("キー無しは 400", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/chat`, {
      headers: petHeaders(null, fakeDeviceId(), nextIp()),
      data: chatBody(),
    });
    expect(response.status()).toBe(400);
    const envelope = await readEnvelope(response);
    expect(envelope?.ok).toBe(false);
    if (envelope && !envelope.ok) expect(envelope.code).toBe("VALIDATION");
  });

  test("bad-key は 502 PET_PROVIDER_AUTH で、応答にキーの値が出ない", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/chat`, {
      headers: petHeaders("bad-key", fakeDeviceId(), nextIp()),
      data: chatBody(),
    });
    const text = await response.text();
    expect(response.status()).toBe(502);
    expect(text).not.toContain("bad-key");
    const envelope = readErrorEnvelope(text);
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("PET_PROVIDER_AUTH");
  });

  test("事業者のエラー文に載ったキーも応答に出ない（#error）", async ({ request }) => {
    const key = `sk-e2e-error-${unique("k")}`;
    const response = await request.post(`${API_BASE}/v1/pet/chat`, {
      headers: petHeaders(key, fakeDeviceId(), nextIp()),
      data: chatBody({ messages: [{ role: "user", content: "#error 400" }] }),
    });
    const text = await response.text();
    expect(response.status()).toBe(502);
    expect(text).not.toContain(key);
    expect(text).not.toContain("sk-e2e-error");
    expect(readErrorEnvelope(text).code).toBe("PET_PROVIDER_ERROR");
  });

  test("custom の http URL は 400", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/chat`, {
      headers: petHeaders(`sk-e2e-custom-${unique("k")}`, fakeDeviceId(), nextIp()),
      data: chatBody({ provider: "custom", baseUrl: "http://127.0.0.1:8931/pet/openai" }),
    });
    expect(response.status()).toBe(400);
    const envelope = await readEnvelope(response);
    if (envelope && !envelope.ok) expect(envelope.code).toBe("VALIDATION");
  });

  test("回数制限: 1 分 20 回を超えると 429", async ({ request }) => {
    const headers = petHeaders(`sk-e2e-rate-${unique("k")}`, fakeDeviceId(), nextIp());
    let limited = false;
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await request.post(`${API_BASE}/v1/pet/chat`, {
        headers,
        data: chatBody({ messages: [{ role: "user", content: `回数制限 ${index}` }] }),
      });
      statuses.push(response.status());
      if (response.status() === 429) {
        const envelope = await readEnvelope(response);
        if (envelope && !envelope.ok) expect(envelope.code).toBe("RATE_LIMITED");
        limited = true;
        break;
      }
    }
    expect(limited, `429 が返らなかった: ${statuses.join(",")}`).toBe(true);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
  });

  test("モデル一覧: openai は 3 件を id 順で返す", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/models`, {
      headers: petHeaders(`sk-e2e-models-${unique("k")}`, fakeDeviceId(), nextIp()),
      data: { provider: "openai" },
    });
    expect(response.status(), await response.text()).toBe(200);
    const envelope = await readEnvelope<PetModelsEnvelope>(response);
    expect(envelope?.ok ? envelope.data : null).toEqual({
      models: [
        { id: "stub-large", label: null },
        { id: "stub-mini", label: null },
        { id: "stub-vision", label: null },
      ],
      truncated: false,
    });
    const last = await lastStubRequest();
    expect(last.path).toBe("/pet/openai/models");
  });

  test("モデル一覧: anthropic は表示名つきで返す", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/models`, {
      headers: petHeaders(`sk-e2e-models-${unique("k")}`, fakeDeviceId(), nextIp()),
      data: { provider: "anthropic" },
    });
    expect(response.status(), await response.text()).toBe(200);
    const envelope = await readEnvelope<PetModelsEnvelope>(response);
    expect(envelope?.ok ? envelope.data : null).toEqual({
      models: [{ id: "stub-claude", label: "Stub Claude" }],
      truncated: false,
    });
    expect((await lastStubRequest()).path).toBe("/pet/anthropic/models");
  });

  test("モデル一覧: bad-key は 502 でキーの値が出ない", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/models`, {
      headers: petHeaders("bad-key", fakeDeviceId(), nextIp()),
      data: { provider: "openai" },
    });
    const text = await response.text();
    expect(response.status()).toBe(502);
    expect(text).not.toContain("bad-key");
    expect(readErrorEnvelope(text).code).toBe("PET_PROVIDER_AUTH");
  });

  test("モデル一覧: custom の http URL は 400", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/pet/models`, {
      headers: petHeaders(`sk-e2e-models-${unique("k")}`, fakeDeviceId(), nextIp()),
      data: { provider: "custom", baseUrl: "http://127.0.0.1:8931/pet/openai" },
    });
    expect(response.status()).toBe(400);
    const envelope = await readEnvelope(response);
    if (envelope && !envelope.ok) expect(envelope.code).toBe("VALIDATION");
  });
});