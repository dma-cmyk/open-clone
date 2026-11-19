// 中継クライアントの単体試験（fetch を差し替える。本物の事業者へは通信しない）。
// キーはヘッダーで送ること・本文にキーを入れないこと・失敗を日本語の案内にすること。

import { describe, expect, it } from "vitest";
import type { PetConfig } from "./contract";
import { PET_API_KEY_HEADER } from "shared";
import { PetRelayError, petChat, petModels, petRelayMessage, petTestConnection } from "./relay-client";

const config: PetConfig = {
  provider: "openai",
  baseUrl: "",
  model: "test-model",
  apiKey: "sk-test-key",
  remember: false,
  petName: "ミケ",
  characterId: "cat",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("petChat", () => {
  it("キーをヘッダーで送り、本文には入れない", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    await petChat(
      config,
      { system: "system", messages: [{ role: "user", content: "こんにちは" }], tools: [] },
      {
        fetchImpl: async (input, init) => {
          requests.push({ url: String(input), init: init ?? {} });
          return jsonResponse({
            ok: true,
            data: {
              message: { content: "やあ", toolCalls: [] },
              finishReason: "stop",
              model: "test-model",
              usage: { inputTokens: 1, outputTokens: 2 },
            },
          });
        },
      },
    );

    const request = requests[0];
    expect(request?.url).toBe("/api/v1/pet/chat");
    const headers = request?.init.headers as Record<string, string>;
    expect(headers[PET_API_KEY_HEADER]).toBe("sk-test-key");
    const body = String(request?.init.body);
    expect(body).not.toContain("sk-test-key");
    expect(JSON.parse(body)).toMatchObject({ provider: "openai", model: "test-model" });
  });

  it("custom で URL が無いときは送らずに案内する", async () => {
    let called = false;
    await expect(
      petChat(
        { ...config, provider: "custom" },
        { system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
        {
          fetchImpl: async () => {
            called = true;
            return jsonResponse({ ok: true });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(called).toBe(false);
  });

  it("事業者の失敗は code を残して日本語にする", async () => {
    const error = await petChat(
      config,
      { system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
      {
        fetchImpl: async () =>
          jsonResponse(
            { ok: false, code: "PET_PROVIDER_AUTH", message: "AI 事業者が API キーを受け付けませんでした" },
            502,
          ),
      },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PetRelayError);
    expect((error as PetRelayError).code).toBe("PET_PROVIDER_AUTH");
    expect((error as PetRelayError).message).toContain("API キー");
  });

  it("通信できないときは NETWORK として案内する", async () => {
    const error = await petChat(
      config,
      { system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
      {
        fetchImpl: async () => {
          throw new TypeError("Failed to fetch");
        },
      },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PetRelayError);
    expect((error as PetRelayError).code).toBe("NETWORK");
  });
});

describe("petModels", () => {
  it("一覧をそのまま返す（保存はしない）", async () => {
    const models = await petModels(config, {
      fetchImpl: async () =>
        jsonResponse({ ok: true, data: { models: [{ id: "stub-mini", label: null }], truncated: false } }),
    });
    expect(models).toEqual({ models: [{ id: "stub-mini", label: null }], truncated: false });
  });

  it("壊れた項目は捨てる", async () => {
    const models = await petModels(config, {
      fetchImpl: async () =>
        jsonResponse({ ok: true, data: { models: [{ id: "" }, { id: "ok", label: "表示名" }], truncated: true } }),
    });
    expect(models).toEqual({ models: [{ id: "ok", label: "表示名" }], truncated: true });
  });
});

describe("petTestConnection", () => {
  it("ツール無しの 1 往復になる", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const reply = await petTestConnection(config, {
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({
          ok: true,
          data: {
            message: { content: "つながりました", toolCalls: [] },
            finishReason: "stop",
            model: "test-model",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        });
      },
    });
    expect(reply).toBe("つながりました");
    expect(bodies[0]?.tools).toEqual([]);
  });
});

describe("petRelayMessage", () => {
  it("回数・時間切れ・会話が長い場合の案内を分ける", () => {
    expect(petRelayMessage("RATE_LIMITED", 429, null)).toContain("利用回数が上限");
    expect(petRelayMessage("PET_PROVIDER_TIMEOUT", 504, null)).toContain("時間内に返りません");
    expect(petRelayMessage("PAYLOAD_TOO_LARGE", 413, null)).toContain("会話が長すぎます");
    expect(petRelayMessage("PET_PROVIDER_ERROR", 502, "model not found")).toContain("model not found");
  });
});