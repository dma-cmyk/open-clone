// AI ペットの画面の e2e 用ヘルパ。
//
// 中継 API（`POST /api/v1/pet/chat`・`POST /api/v1/pet/models`）は、この worktree にはまだ無いので
// `page.route` で契約の形のまま代役を置く（`{ok:true,data}` / `{ok:false,code,message}`）。
// 代役の返し方は e2e スタブ（`e2e/scripts/stub-server.mjs` のペット部分）の決まりに合わせる:
//   `#tool <name> <JSON>` → そのツールを 1 つ呼ぶ / `#tools <JSON配列>` → 複数 /
//   `#slow <ms> <文>` → 待ってから返す / `#error` → 事業者のエラー / tool の結果 → 文章 / それ以外 → 了解: <文>
// 本物の中継・本物のツールを通した確認は統合後に行う（報告書「統合後に確かめること」）。

import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";

export const API_BASE = process.env.E2E_API_URL ?? "http://127.0.0.1:8940";
export const ALLOWED_ORIGIN = process.env.E2E_ALLOWED_ORIGIN ?? "http://localhost:3420";

export interface RelayRequestLog {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

export const STUB_MODELS = [
  { id: "stub-mini", label: null },
  { id: "stub-large", label: "Stub Large" },
  { id: "stub-vision", label: null },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function lastMessage(body: Record<string, unknown> | null): Record<string, unknown> | null {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return asRecord(messages[messages.length - 1]);
}

function chatEnvelope(message: { content: string | null; toolCalls: unknown[] }, finishReason: string) {
  return {
    ok: true,
    data: {
      message,
      finishReason,
      model: "stub-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  };
}

let callCounter = 0;

function toolCall(name: string, args: unknown) {
  callCounter += 1;
  return { id: `call_${callCounter}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) };
}

/**
 * 中継の代役を置く。返した要求の記録（本文・ヘッダー）を返す。
 * キーが `bad-key` なら 401（本物のスタブと同じ）。
 */
export async function installRelayStub(page: Page): Promise<RelayRequestLog[]> {
  const logs: RelayRequestLog[] = [];
  await page.route("**/api/v1/pet/**", async (route) => {
    try {
      await handleRelayRoute(route, logs);
    } catch {
      // 「止める」で中断された要求など、応答を返せなくなった場合は何もしない。
    }
  });
  return logs;
}

async function handleRelayRoute(route: Route, logs: RelayRequestLog[]): Promise<void> {
  const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = request.headers();
    let body: Record<string, unknown> | null = null;
    try {
      body = asRecord(request.postDataJSON());
    } catch {
      body = null;
    }
    logs.push({ path, headers, body });
    const key = headers["x-pet-api-key"] ?? "";
    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });

    if (key === "bad-key") {
      return json(401, { ok: false, code: "PET_PROVIDER_AUTH", message: "Incorrect API key provided" });
    }

    if (path.endsWith("/pet/models")) {
      return json(200, { ok: true, data: { models: STUB_MODELS, truncated: false } });
    }

    const last = lastMessage(body);
    if (!last) {
      return json(200, chatEnvelope({ content: "（メッセージがありません）", toolCalls: [] }, "stop"));
    }

    if (last.role === "tool") {
      const name = typeof last.name === "string" ? last.name : "tool";
      const content = typeof last.content === "string" ? last.content : "";
      return json(200, chatEnvelope({ content: `ツール結果(${name}): ${content.slice(0, 300)}`, toolCalls: [] }, "stop"));
    }

    const text = typeof last.content === "string" ? last.content : "";
    const toolMatch = text.match(/^#tool (\S+)(?: ([\s\S]*))?$/);
    if (toolMatch?.[1]) {
      const args = toolMatch[2] ?? "{}";
      return json(200, chatEnvelope({ content: null, toolCalls: [toolCall(toolMatch[1], args)] }, "tool_calls"));
    }
    const toolsMatch = text.match(/^#tools ([\s\S]+)$/);
    if (toolsMatch?.[1]) {
      try {
        const items = JSON.parse(toolsMatch[1]) as Array<{ name: string; arguments?: unknown }>;
        return json(
          200,
          chatEnvelope(
            { content: null, toolCalls: items.map((item) => toolCall(item.name, item.arguments ?? {})) },
            "tool_calls",
          ),
        );
      } catch {
        return json(200, chatEnvelope({ content: "配列が読めませんでした", toolCalls: [] }, "stop"));
      }
    }
    const slowMatch = text.match(/^#slow (\d+) ([\s\S]+)$/);
    if (slowMatch?.[1]) {
      await new Promise((resolve) => setTimeout(resolve, Number(slowMatch[1])));
      return json(200, chatEnvelope({ content: `了解: ${slowMatch[2]}`, toolCalls: [] }, "stop"));
    }
    if (/^#error/.test(text)) {
      return json(502, {
        ok: false,
        code: "PET_PROVIDER_ERROR",
        message: "テスト用の事業者エラーです（model not found）",
      });
    }
    return json(200, chatEnvelope({ content: `了解: ${text}`, toolCalls: [] }, "stop"));
}

/** 右下のボタン（無ければヘッダーの「ペット」）からパネルを開く。 */
export async function openPet(page: Page): Promise<void> {
  const launcher = page.getByTestId("pet-launcher");
  const header = page.getByTestId("pet-header-button");
  // どちらかが出るまで待つ（右下のボタンはマウント後に出る。ヘッダーは「しまう」の後も残る）。
  await expect(launcher.or(header).first()).toBeVisible();
  if (await launcher.isVisible()) {
    await launcher.click();
  } else {
    await header.click();
  }
  await expect(page.getByTestId("pet-panel")).toBeVisible();
}

/** 最初の設定を入れて保存する（会話画面になるまで）。 */
export async function configurePet(
  page: Page,
  options: { model?: string; apiKey?: string; remember?: boolean; name?: string } = {},
): Promise<void> {
  await page.getByTestId("pet-provider").selectOption("openai");
  await page.getByTestId("pet-model-input").fill(options.model ?? "test-model");
  await page.getByTestId("pet-api-key").fill(options.apiKey ?? "sk-test");
  if (options.remember === false) await page.getByTestId("pet-remember").uncheck();
  if (options.name) await page.getByTestId("pet-name").fill(options.name);
  await page.getByTestId("pet-save").click();
  await expect(page.getByTestId("pet-input")).toBeVisible();
}

/** 会話を 1 回送る（入力欄に入れて送信ボタン）。 */
export async function sendPetMessage(page: Page, text: string): Promise<void> {
  await page.getByTestId("pet-input").fill(text);
  await page.getByTestId("pet-send").click();
}

/** 板とスレを 1 つ用意する（応答は API のもの）。 */
export async function seedBoardAndThread(
  request: APIRequestContext,
): Promise<{ slug: string; title: string; threadId: number }> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const slug = `pet-ui-${suffix}`;
  const title = `ペットUI試験スレ ${suffix}`;
  const board = await request.post(`${API_BASE}/v1/boards`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      Cookie: "oc_sess=e2e-owner-session-token",
    },
    data: { slug, name: `ペット試験板 ${suffix}`, category: "E2E", description: "AI ペットの画面試験用", settings: { turnstile: "off" } },
  });
  expect(board.status(), await board.text()).toBe(201);
  const thread = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      Cookie: "oc_sess=e2e-owner-session-token",
    },
    data: { title, body: "1げっと\nAI ペットの画面試験用のスレです。", turnstileToken: "1x00000000000000000000AA" },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const envelope = (await thread.json()) as { ok: boolean; data?: { threadId?: number } };
  const threadId = envelope.data?.threadId;
  if (!threadId) throw new Error("スレ作成の応答に threadId がありません");
  return { slug, title, threadId };
}