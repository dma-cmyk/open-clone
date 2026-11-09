// `/plugins` の「自分のプラグイン」タブに関する回帰 E2E。
//
// 報告書34 §4（追加レビュー）の指摘: 既存のユニットテスト（`registry-query.test.ts`）は
// ヘルパー単体しか見ていないため、`page.tsx` から世代ガード（`createLatestOnly`）が
// 外れても通ってしまう。ここでは実ブラウザで `page.tsx` の挙動そのものを検証する。
//
// 検証する 2 点（どちらも修正前 `b99ec26` では落ちる）:
//  1. `?tab=mine` の直開きで、取得は `mine=true` の 1 本だけ。ハイドレーション不一致も出ない。
//  2. 公開一覧の取得が遅れている間に mine へ切り替えても、遅れて届いた公開一覧に上書きされない。
//
// API は `page.route` でモックし、応答の遅延で競合の順序を作る。
// 実スタック（webServer の web/api）は起動するが、一覧 API には一切届かない。

import { expect, test, type Page, type Request, type Route } from "@playwright/test";

interface RegistryItem {
  id: string;
  name: string;
  summary: string;
  latestVersion: string | null;
  status: string;
  visibility: string;
  scopes: string[];
  permissions: string[];
  slots: string[];
  hasRenderRules: boolean;
  installCount: number;
  reportCount: number;
  flagged: boolean;
  source: string;
  sourceRef: string | null;
  owner: null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

function registryItem(id: string, name: string, status: string, summary: string): RegistryItem {
  return {
    id,
    name,
    summary,
    latestVersion: null,
    status,
    visibility: "public",
    scopes: [],
    permissions: [],
    slots: [],
    hasRenderRules: false,
    installCount: 0,
    reportCount: 0,
    flagged: false,
    source: "local",
    sourceRef: null,
    owner: null,
    createdAt: 1_760_000_000,
    updatedAt: 1_760_000_000,
    publishedAt: null,
  };
}

const MINE_ITEM = registryItem("plg_mine_e2e", "mine-draft-e2e", "draft", "mine タブに出る下書き");
const PUBLIC_ITEM = registryItem("plg_public_e2e", "public-only-e2e", "published", "公開一覧にだけ出る");

/** 一覧 API（`/api/v1/plugins?...`・`/api/v1/plugins/mine` 等は含めない）に一致する。 */
const LIST_URL = /\/api\/v1\/plugins(?:\?|$)/;

interface MockRegistry {
  /** 受けた一覧リクエスト（発生順）。 */
  readonly calls: { mine: boolean; url: string }[];
  /** 公開一覧の応答を実際に返し終えたら解決する。 */
  readonly publicFulfilled: Promise<void>;
}

/**
 * 一覧 API をモックする。`publicDelay`/`mineDelay` で応答順を制御できる。
 * リクエストの発生は受けた時点で `calls` に記録する（遅延で取りこぼさない）。
 */
async function mockRegistry(
  page: Page,
  options: { publicDelay: number; mineDelay: number },
): Promise<MockRegistry> {
  const calls: MockRegistry["calls"] = [];
  // e2e の tsconfig は lib ES2022 のため `Promise.withResolvers` が無い（executor 形式を使う）。
  let resolvePublic: () => void = () => undefined;
  const publicFulfilled = new Promise<void>((resolve) => {
    resolvePublic = resolve;
  });

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const mine = new URL(request.url()).searchParams.get("mine") === "true";
    calls.push({ mine, url: request.url() });
    await new Promise((resolve) => setTimeout(resolve, mine ? options.mineDelay : options.publicDelay));
    const items = mine ? [MINE_ITEM] : [PUBLIC_ITEM];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { items, nextCursor: null } }),
    });
    if (!mine) resolvePublic();
  };

  await page.route(LIST_URL, handler);
  return { calls, publicFulfilled };
}

/** コンソールの error と未捕捉例外を集める。 */
function watchConsole(page: Page): string[] {
  const messages: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") messages.push(message.text());
  });
  page.on("pageerror", (error) => messages.push(`${error.name}: ${error.message}`));
  return messages;
}

/** ハイドレーション不一致（dev は英文、本番ビルドは React #418/#423 のミニファイ済み文言）。 */
function hydrationErrors(messages: string[]): string[] {
  return messages.filter((message) =>
    /hydrat|did not match|server rendered|#418|#423|Minified React error/i.test(message),
  );
}

test.describe("プラグイン一覧の mine タブ", () => {
  test("?tab=mine の直開きで取得は mine=true の 1 本だけ・下書きが出る・コンソールエラーなし", async ({
    page,
  }) => {
    const consoleMessages = watchConsole(page);
    const mock = await mockRegistry(page, { publicDelay: 800, mineDelay: 80 });

    await page.goto("/plugins/?tab=mine");

    // 下書き（mine の結果）が一覧に出る。
    await expect(page.getByText("自分のプラグイン（1）", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: MINE_ITEM.name })).toBeVisible();

    // 公開一覧の取得が 1 本でも飛んでいれば、ここで記録に残っている。
    expect(mock.calls.map((call) => call.mine)).toEqual([true]);

    // ハイドレーションの不一致（報告書34 の Low 指摘）が出ない。
    expect(hydrationErrors(consoleMessages)).toEqual([]);
  });

  test("公開一覧が遅れて届いても、mine に切り替えた後の表示は mine の結果のまま", async ({ page }) => {
    const consoleMessages = watchConsole(page);
    const mock = await mockRegistry(page, { publicDelay: 1_500, mineDelay: 80 });

    // 公開一覧の取得が in-flight のまま mine へ切り替える（報告書40 §10 と同じ順序）。
    const publicRequest = page.waitForRequest(
      (request) =>
        request.method() === "GET" &&
        LIST_URL.test(request.url()) &&
        new URL(request.url()).searchParams.get("mine") !== "true",
    );
    await page.goto("/plugins/");
    await publicRequest;
    // リクエストの発火と route ハンドラの実行は 1 tick ずれるので、記録を待つ。
    await expect.poll(() => mock.calls.some((call) => !call.mine)).toBe(true);

    await page.getByRole("button", { name: "自分のプラグイン" }).click();
    await expect(page.getByText("自分のプラグイン（1）", { exact: true })).toBeVisible();

    // 遅れて届いた公開一覧の応答が適用されていないことを確認する。
    await mock.publicFulfilled;
    await page.waitForTimeout(300);
    await expect(page.getByText("自分のプラグイン（1）", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: MINE_ITEM.name })).toBeVisible();
    await expect(page.getByRole("link", { name: PUBLIC_ITEM.name })).toHaveCount(0);
    expect(mock.calls.map((call) => call.mine)).toEqual([false, true]);
    expect(hydrationErrors(consoleMessages)).toEqual([]);
  });
});