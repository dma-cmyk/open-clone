// AI ペットの画面の e2e 用ヘルパ。
//
// 中継 API（`POST /api/v1/pet/chat`・`POST /api/v1/pet/models`）は、この worktree にはまだ無いので
// `page.route` で契約の形のまま代役を置く（`{ok:true,data}` / `{ok:false,code,message}`）。
// 代役の返し方は e2e スタブ（`e2e/scripts/stub-server.mjs` のペット部分）の決まりに合わせる:
//   `#tool <name> <JSON>` → そのツールを 1 つ呼ぶ / `#tools <JSON配列>` → 複数 /
//   `#slow <ms> <文>` → 待ってから返す / `#error` → 事業者のエラー / tool の結果 → 文章 / それ以外 → 了解: <文>
// 本物の中継・本物のツールを通した確認は統合後に行う（報告書「統合後に確かめること」）。

import { randomBytes } from "node:crypto";
import { expect, type APIRequestContext, type BrowserContext, type Page, type Route } from "@playwright/test";

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
    // ヘッダーのボタンはサーバー描画で、ハイドレーション前のクリックは listener が無く
    // 何も起きない。パネルが出るまで押し直す（開いた後の再クリックで閉じないよう先に確認する）。
    await expect(async () => {
      if (await page.getByTestId("pet-panel").isVisible()) return;
      await header.click();
      await expect(page.getByTestId("pet-panel")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    return;
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

// ─── 統合後の試験（本物の中継・本物のツールを通す）用 ─────────────────────────
//
// 中継は `page.route` を使わず、本物の `POST /api/v1/pet/chat` を通す。事業者は
// e2e スタブ（`scripts/stub-server.mjs` の `#tool <name> <JSON>`）で、結果は `/pet/__last` で読む。

/** seed の固定セッション（`e2e/fixtures/seed.sql`）。 */
export const PET_SESSIONS = {
  owner: "e2e-owner-session-token",
  user: "e2e-user-session-token",
  moderator: "e2e-tour-moderator-session-token",
} as const;

export const PET_STUB_BASE = process.env.E2E_STUB_URL ?? "http://127.0.0.1:8971";

/**
 * 試験ごとに一意な API キー。`/pet/__last?key=` の照合に使う。
 * `unique()` はプロセス内の連番なので、並列の worker（pc / mobile）が同じミリ秒に
 * 同じ連番を取ると衝突し得る。プロセスごとの乱数を混ぜて、キー単位の状態を取り違えない。
 */
const PET_KEY_PREFIX = randomBytes(4).toString("hex");
let petKeySeq = 0;
export function petTestApiKey(label: string): string {
  petKeySeq += 1;
  return `sk-e2e-${label}-${PET_KEY_PREFIX}-${petKeySeq}`;
}

/**
 * ペット中継の回数制限を試験ごとに分ける。
 * 中継はセッションを使わず（キーと本文だけで動く）、制限のキーはログイン時がアカウント、
 * 未ログイン時が端末＋IP。並列試験では全ブラウザの IP が 127.0.0.1 になり、同じアカウント
 * （seed の owner 等）も共有されるため、そのままだと 20 回/分の窓を取り合う。
 *
 * 中継の要求だけ oc_sess を外して未ログイン扱いにし、試験ごとに一意な cf-connecting-ip を付ける
 * （画面の他の API は本物のセッションのまま。ツールの権限判定には影響しない）。
 */
const PET_RATE_IP_PREFIX = randomBytes(2);
const relayRateIsolated = new WeakSet<Page>();
let petRateIpSeq = 0;
export async function isolatePetRelayRate(page: Page): Promise<void> {
  if (relayRateIsolated.has(page)) return;
  relayRateIsolated.add(page);
  petRateIpSeq += 1;
  const [hi = 1, lo = 1] = PET_RATE_IP_PREFIX;
  const ip = `198.18.${hi}.${(lo + petRateIpSeq) % 256}`;
  // ブラウザの Cookie（セッション）は中継に不要なので、この要求だけテストプロセスから
  // 送り直す。ブラウザの Cookie を route.continue で確実に外す方法が無く、ログイン中の
  // アカウント窓（20 回/分）を並列試験で取り合ってしまうため。UI が作った本文・キーは
  // そのまま本物の中継 API へ渡し、応答もそのまま返す（中継・ツールの経路は本物のまま）。
  await page.route("**/api/v1/pet/chat", async (route) => {
    const request = route.request();
    const response = await fetch(`${API_BASE}/v1/pet/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ALLOWED_ORIGIN,
        "cf-connecting-ip": ip,
        "x-pet-api-key": request.headers()["x-pet-api-key"] ?? "",
      },
      body: request.postData() ?? "",
    });
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: await response.text(),
    });
  });
}

export function petApiUrl(path: string): string {
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** API 直叩きのヘッダー（`cookie` 省略で未ログイン）。 */
export function petApiHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    "x-turnstile-token": "1x00000000000000000000AA",
  };
  if (cookie) headers["cookie"] = `oc_sess=${cookie}`;
  return headers;
}

/** 追加するクッキーの型（`addCookies` の引数の要素）。 */
type CookieToAdd = Parameters<BrowserContext["addCookies"]>[0][number];

/** ブラウザのログイン状態を差し替える（`null` で未ログイン）。端末クッキー（oc_did）は残す。 */
export async function usePetSession(context: BrowserContext, token: string | null): Promise<void> {
  // 端末クッキーまで消すと「同じ端末」の前提（Turnstile の 30 分パス）が崩れるため、
  // oc_sess 以外のクッキーはそのまま戻す（`clearCookies({ name })` の名前指定が効かない版がある）。
  const host = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3450").hostname;
  const existing = await context.cookies();
  await context.clearCookies();
  const keep: CookieToAdd[] = existing
    .filter((cookie) => cookie.name !== "oc_sess")
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
    }));
  if (token) {
    keep.push({ name: "oc_sess", value: token, domain: host, path: "/", httpOnly: true, sameSite: "Lax" });
  }
  if (keep.length > 0) await context.addCookies(keep);
}

/**
 * 端末クッキー（oc_did）を指定の値に固定する。
 * 初回読み込みでは複数の API 呼び出しが並び、それぞれが端末 ID を発行して最後の応答が勝つ。
 * 通過記録（30 分パス）を作ったあとは、同じ値に固定してから操作する。
 */
export async function pinDeviceCookie(context: BrowserContext, deviceId: string): Promise<void> {
  const host = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3450").hostname;
  const existing = await context.cookies();
  await context.clearCookies();
  const keep: CookieToAdd[] = existing
    .filter((cookie) => cookie.name !== "oc_did")
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
    }));
  keep.push({ name: "oc_did", value: deviceId, domain: host, path: "/", httpOnly: true, sameSite: "Lax" });
  await context.addCookies(keep);
}

/** 板を作る（既定は Turnstile off）。`settings` でポリシーを変える。 */
export async function createPetBoard(
  request: APIRequestContext,
  options: { turnstile?: "off" | "anonymous" | "always"; turnstilePassMinutes?: number } = {},
): Promise<{ slug: string; name: string }> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(-8);
  const slug = `pet-tools-${suffix}`;
  const name = `ペットツール試験板 ${suffix}`;
  const response = await request.post(petApiUrl("/v1/boards"), {
    headers: petApiHeaders(PET_SESSIONS.owner),
    data: {
      slug,
      name,
      category: "E2E",
      description: "AI ペットのツール試験用",
      settings: {
        turnstile: options.turnstile ?? "off",
        turnstilePassMinutes: options.turnstilePassMinutes ?? 30,
        cooldownSeconds: 0,
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return { slug, name };
}

export async function createPetThread(
  request: APIRequestContext,
  slug: string,
  options: { body?: string; cookie?: string } = {},
): Promise<{ threadId: number; title: string }> {
  const title = `ペットツール試験スレ ${Date.now()}`;
  const response = await request.post(petApiUrl(`/v1/boards/${slug}/threads`), {
    headers: petApiHeaders(options.cookie ?? PET_SESSIONS.owner),
    data: {
      title,
      body: options.body ?? "1げっと\nAI ペットのツール試験用のスレです。",
      // スレ立ては本文の `turnstileToken` だけを見る（ヘッダーは読まれない）。
      turnstileToken: "1x00000000000000000000AA",
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const envelope = (await response.json()) as { ok: boolean; data?: { threadId?: number } };
  const threadId = envelope.data?.threadId;
  if (!threadId) throw new Error("スレ作成の応答に threadId がありません");
  return { threadId, title };
}

/** レスを 1 つ足す（本文を返す）。 */
export async function replyPetThread(
  request: APIRequestContext,
  threadId: number,
  body: string,
  cookie: string = PET_SESSIONS.owner,
): Promise<{ id: number; num: number }> {
  const response = await request.post(petApiUrl(`/v1/threads/${threadId}/posts`), {
    headers: petApiHeaders(cookie),
    data: { body, turnstileToken: "1x00000000000000000000AA" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const envelope = (await response.json()) as { ok: boolean; data?: { post?: { id: number; num: number } } };
  const post = envelope.data?.post;
  if (!post) throw new Error("レス作成の応答に post がありません");
  return post;
}

/** 板のスタッフにする（`level` は admin / deputy / moderator）。 */
export async function setPetBoardStaff(
  request: APIRequestContext,
  slug: string,
  accountName: string,
  level: "admin" | "deputy" | "moderator",
): Promise<void> {
  const response = await request.post(petApiUrl(`/v1/boards/${slug}/staff`), {
    headers: petApiHeaders(PET_SESSIONS.owner),
    data: { accountName, level },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * スタブがその API キーで最後に受けた中継要求の本文（`/pet/__last?key=`）。
 * `__last` はキーごとに持つので、並列の試験同士で取り合わない。
 */
export async function petLastRequest(apiKey: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${PET_STUB_BASE}/pet/__last?key=${encodeURIComponent(apiKey)}`);
  if (!response.ok) return null;
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || !("body" in parsed)) return null;
  const body = parsed.body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
}

/** スタブがその API キーで最後に受けた要求の最後のメッセージ本文（tool の結果はここに入る）。 */
export async function petLastMessageText(apiKey: string): Promise<string> {
  const body = await petLastRequest(apiKey);
  const messages = Array.isArray(body?.["messages"]) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (typeof last !== "object" || last === null) return "";
  const content = Reflect.get(last, "content");
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "object" && block !== null && typeof Reflect.get(block, "text") === "string" ? String(Reflect.get(block, "text")) : ""))
      .join("");
  }
  return "";
}

/** 画面の Turnstile をスタブに差し替える（`window.turnstile` を先に置く）。`hold: true` で解放まで発行しない。 */
export async function stubTurnstile(page: Page, options: { hold?: boolean } = {}): Promise<void> {
  await page.addInitScript((initialHold: boolean) => {
    interface WidgetEntry {
      id: string;
      callback: (token: string) => void;
    }
    const entries: WidgetEntry[] = [];
    const state = { hold: initialHold };
    let seq = 0;
    const issue = (entry: WidgetEntry) => {
      seq += 1;
      // 並列のページが同じミリ秒に同じ連番を発行しても衝突しないよう乱数を混ぜる
      // （siteverify スタブはトークンを使い切りにするため、衝突すると片方が失敗する）。
      const nonce = Math.random().toString(36).slice(2, 10);
      entry.callback(`pet-token-${Date.now().toString(36)}-${nonce}-${seq}`);
    };
    const globals = window as unknown as {
      turnstile?: {
        render: (element: HTMLElement, options: { callback: (token: string) => void }) => string;
        remove: (id: string) => void;
        reset: (id: string) => void;
      };
      __petTurnstile?: {
        renders: () => number;
        held: () => boolean;
        release: () => void;
      };
    };
    globals.turnstile = {
      render(element, opts) {
        seq += 1;
        const id = `pet-widget-${seq}`;
        const entry = { id, callback: opts.callback };
        entries.push(entry);
        const box = document.createElement("div");
        box.className = "pet-turnstile-stub";
        box.textContent = "stub-turnstile";
        element.appendChild(box);
        if (!state.hold) window.setTimeout(() => issue(entry), 0);
        return id;
      },
      remove(id) {
        const index = entries.findIndex((entry) => entry.id === id);
        if (index >= 0) entries.splice(index, 1);
      },
      reset(id) {
        const entry = entries.find((candidate) => candidate.id === id);
        if (entry) window.setTimeout(() => issue(entry), 0);
      },
    };
    globals.__petTurnstile = {
      renders: () => entries.length,
      held: () => state.hold,
      release() {
        state.hold = false;
        for (const entry of entries) window.setTimeout(() => issue(entry), 0);
      },
    };
  }, options.hold ?? false);
}

/** `stubTurnstile({ hold: true })` のトークンを解放する。 */
export async function releaseTurnstile(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globals = window as unknown as { __petTurnstile?: { release: () => void } };
    globals.__petTurnstile?.release();
  });
}

/** ツールを 1 つ呼ばせる（スタブの `#tool`）。 */
export async function sendPetTool(page: Page, name: string, args: Record<string, unknown>): Promise<void> {
  await waitPetIdle(page);
  await sendPetMessage(page, `#tool ${name} ${JSON.stringify(args)}`);
}

/** 会話が終わる（送信ボタンが「送る」に戻る）まで待つ。実行中に次の送信をすると「止める」を押してしまう。 */
export async function waitPetIdle(page: Page): Promise<void> {
  await expect(page.getByTestId("pet-send")).toHaveText("送る");
}

/** 確認カードの「本文」欄（`details` の label が「本文」の dd）。 */
export function petCardDetail(page: Page, label: string) {
  return page
    .getByTestId("pet-confirm-card")
    .locator(".oc-pet-confirm-row")
    .filter({ has: page.locator(`dt:text-is("${label}")`) })
    .locator("dd");
}