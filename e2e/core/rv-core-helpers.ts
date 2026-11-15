// rv-core（投稿と画面遷移）系スペックの共通ヘルパ。
// 板・スレは API で用意し、UI 操作の検証に集中する（board-flow.spec.ts と同じ方針）。
import type { APIRequestContext, Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

interface TurnstileState {
  renders: number;
  sizes: string[];
  tokens: number;
}

// ページ内スタブが window に置く観測値（テスト専用の境界なので宣言を足す）。
declare global {
  interface Window {
    __ocTurnstile?: TurnstileState;
    turnstile?: unknown;
    /** 操作者付きスタブ用（controlledTurnstile）。 */
    __issue?: (token: string) => void;
    __expire?: () => void;
  }
}

/** 所有者セッション + Turnstile 公式テストキー（API 直叩き用）。 */
export function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: OWNER_COOKIE,
    // 板・スレ作成は Turnstile を要求する（site_config 既定）。
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

export interface BoardSettingsInput {
  turnstile?: "off" | "anonymous" | "always";
  uploader?: string;
  cooldownSeconds?: number;
}

/** 板を作り slug を返す。 */
export async function createBoard(
  request: APIRequestContext,
  settings: BoardSettingsInput = {},
): Promise<string> {
  const slug = unique("rv").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `rv-core ${slug}`,
      category: "E2E",
      description: "rv-core の検証用",
      settings: { turnstile: settings.turnstile ?? "off", cooldownSeconds: settings.cooldownSeconds ?? 0, ...settings },
    },
  });
  if (response.status() !== 201) {
    throw new Error(`板の作成に失敗しました: ${response.status()} ${await response.text()}`);
  }
  return slug;
}

/** スレを作り id を返す。 */
export async function createThread(
  request: APIRequestContext,
  slug: string,
  input: { title?: string; body?: string } = {},
): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: input.title ?? `rv-core スレ ${Date.now()}`, body: input.body ?? "1げっと" },
  });
  if (response.status() !== 201) {
    throw new Error(`スレの作成に失敗しました: ${response.status()} ${await response.text()}`);
  }
  const body = await readEnvelope<{ threadId: number }>(response);
  if (!body || !body.ok) throw new Error("スレ作成の応答が不正です");
  return body.data.threadId;
}

/** スレにレスを 1 件足す（UI を使わない投稿。新着受信の検証などに使う）。 */
export async function postReply(
  request: APIRequestContext,
  threadId: number,
  body: string,
): Promise<void> {
  const response = await request.post(apiUrl(`/v1/threads/${threadId}/posts`), {
    headers: ownerHeaders(),
    data: { body },
  });
  if (response.status() !== 201) {
    throw new Error(`レスの作成に失敗しました: ${response.status()} ${await response.text()}`);
  }
}

/** Turnstile の描画回数・サイズ・トークン発行を記録するスタブ。外部へは接続しない。 */
export async function stubTurnstile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: TurnstileState = { renders: 0, sizes: [], tokens: 0 };
    window.__ocTurnstile = state;
    const widgets = new Map<string, { callback?: (token: string) => void; box?: HTMLElement }>();
    window.turnstile = {
      render(element: HTMLElement, options: { size?: string; callback?: (token: string) => void }) {
        state.renders += 1;
        state.sizes.push(String(options.size ?? "normal"));
        const id = `stub-${state.renders}`;
        const box = document.createElement("div");
        box.className = "stub-turnstile";
        box.textContent = "stub-turnstile";
        // 実際の normal と同じ 300×65 を確保し、レイアウト検証に使えるようにする。
        box.style.width = options.size === "flexible" ? "100%" : "300px";
        box.style.height = "65px";
        element.appendChild(box);
        widgets.set(id, { ...options, box });
        window.setTimeout(() => {
          state.tokens += 1;
          options.callback?.(`stub-token-${state.tokens}`);
        }, 0);
        return id;
      },
      reset(id: string) {
        const options = widgets.get(id);
        if (!options) return;
        window.setTimeout(() => {
          state.tokens += 1;
          options.callback?.(`stub-token-${state.tokens}`);
        }, 0);
      },
      remove(id: string) {
        // 実ウィジェット同様、対応する DOM も消す（StrictMode の再マウントで
        // スタブ要素が二重に残ると「1 個だけ」の検証が壊れる）。
        widgets.get(id)?.box?.remove();
        widgets.delete(id);
      },
    };
  });
}

/** 記録したスタブ状態を読む。 */
export async function turnstileState(page: Page): Promise<TurnstileState> {
  const state = await page.evaluate(() => window.__ocTurnstile);
  if (!state) throw new Error("Turnstile スタブが初期化されていません");
  return state;
}

/** スマホ幅の投稿欄が畳まれている場合は開く。 */
export async function expandPostForm(page: Page): Promise<void> {
  const bar = page.locator(".oc-form-openbar").filter({ visible: true }).first();
  if ((await bar.count()) > 0) await bar.click();
}

/** スレ画面の投稿フォーム（レス用）。 */
export function postForm(page: Page) {
  return page.locator("form.oc-form").filter({ has: page.getByRole("button", { name: /^投稿する$/ }) }).first();
}
/** 保存先（Catbox）の 412 を、API が返すのと同じ envelope で再現する（UI 検証を決定的にする）。 */
export async function stubBlockedProxy(page: Page): Promise<void> {
  await page.route(/\/api\/v1\/uploads\/proxy/, async (route) => {
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        code: "BAD_GATEWAY",
        message:
          "Catbox（既定・画像/動画/テキスト） がアップロードを受け付けませんでした（HTTP 412）。" +
          "保存先側の制限で拒否された可能性があります。少し待って再試行するか、保存先を別のものに変えてください。",
        details: { upstreamStatus: 412, adapter: "catbox", reason: "upstream_blocked", retryable: true },
      }),
    });
  });
}

/**
 * 操作者をテスト側が握る Turnstile スタブ（Sol の独立プローブと同じ形）。
 * 成功通知（issue）・期限切れ（expire）を任意のタイミングで発火でき、
 * 自動では何も発行しないので「遅延成功」「未確認のまま送信」を検証できる。
 */
export interface ControlledTurnstile {
  /** 成功通知を出す（ウィジェット 1 個につき 1 回）。 */
  issue: (token: string) => Promise<void>;
  /** 期限切れ通知を出す。 */
  expire: () => Promise<void>;
  /** 現在ウィジェットが生やしている DOM id 一覧。 */
  widgetIds: () => Promise<string[]>;
}

export async function controlledTurnstile(page: Page): Promise<ControlledTurnstile> {
  await page.addInitScript(() => {
    const widgets = new Map<string, { callback?: (token: string) => void; expired?: () => void }>();
    let serial = 0;
    window.__ocTurnstile = { renders: 0, sizes: [], tokens: 0 };
    window.turnstile = {
      render(element: HTMLElement, options: { size?: string; callback?: (token: string) => void; "expired-callback"?: () => void }) {
        const state = window.__ocTurnstile!;
        state.renders += 1;
        state.sizes.push(String(options.size ?? "normal"));
        const id = `controlled-${serial + 1}`;
        serial += 1;
        widgets.set(id, { callback: options.callback, expired: options["expired-callback"] });
        const box = document.createElement("div");
        box.id = id;
        box.textContent = "controlled-turnstile";
        box.style.cssText = "width:300px;height:65px";
        element.appendChild(box);
        return id;
      },
      // 実 Turnstile の reset は同じウィジェットを生かしたまま状態を戻す
      // （新しい成功通知は同じ callback へ来る）。DOM・登録は消さない。
      reset() {},
      remove(id: string) {
        widgets.delete(id);
        document.getElementById(id)?.remove();
      },
    };
    window.__issue = (token: string) => {
      const state = window.__ocTurnstile!;
      for (const options of widgets.values()) {
        state.tokens += 1;
        options.callback?.(token);
        return;
      }
    };
    window.__expire = () => {
      for (const options of widgets.values()) {
        options.expired?.();
        return;
      }
    };
  });
  return {
    issue: (token) => page.evaluate((value) => window.__issue?.(value), token),
    expire: () => page.evaluate(() => window.__expire?.()),
    widgetIds: () =>
      page.evaluate(() => Array.from(document.querySelectorAll(".oc-turnstile-slot > [id]")).map((node) => node.id)),
  };
}
