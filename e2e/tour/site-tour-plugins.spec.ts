// プラグイン画面のツアー E2E。
//  - 各画面のツアーが最後まで進み、実装にある手順だけが出る
//  - 権限の要る画面（板のプラグイン・審査キュー・作成トークン）は、権限のない人に開始させない
//  - 読み込み中に「使い方」を押してもヘルプへ飛ばず、読み込み後に開始する（K3）
//  - 360px でも全手順の吹き出しが画面内に収まる
//  - プラグイン／アカウント画面にサイトヘッダー・フッターが 1 つずつ出る
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";
import { collectPageErrors, hideNextDevOverlay } from "./dev-overlay";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: OWNER_COOKIE,
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

async function loginAsOwner(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3255");
  await context.clearCookies();
  await context.addCookies([
    { name: "oc_sess", value: "e2e-owner-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("ptour").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `プラグインツアー板 ${slug.slice(-4)}`,
      category: "E2E",
      description: "プラグインツアーの検証用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createOwnedPlugin(request: APIRequestContext): Promise<string> {
  const name = unique("ptour-plugin").toLowerCase().slice(0, 40);
  const response = await request.post(apiUrl("/v1/plugins"), {
    headers: ownerHeaders(),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "プラグインツアーの作者向け手順の検証用",
        scope: ["personal"],
        permissions: [],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: [],
        hooks: [],
      },
      code: "register({});",
      visibility: "private",
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = await readEnvelope<{ id: string }>(response);
  if (!body || !body.ok) throw new Error("プラグイン作成の応答が不正です");
  return body.data.id;
}

async function officialPluginId(request: APIRequestContext): Promise<string> {
  const response = await request.get(apiUrl("/v1/plugins?limit=50"), {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  const body = await readEnvelope<{ items: Array<{ id: string; ownership: string }> }>(response);
  if (!body || !body.ok) throw new Error("プラグイン一覧の取得に失敗しました");
  const official = body.data.items.find((item) => item.ownership === "official");
  if (!official) throw new Error("公式プラグインの seed がありません");
  return official.id;
}

async function closeIntro(page: Page): Promise<void> {
  const intro = page.locator(".oc-tour-intro");
  if (await intro.count()) {
    await intro.getByRole("button", { name: "案内を閉じる" }).click({ force: true });
  }
}

/** 幅が狭いとヘッダーの「使い方」は隠れるため、フッターの導線から始める。 */
async function startTour(page: Page): Promise<void> {
  await closeIntro(page);
  const headerButton = page.locator('header [data-tour="site-tour"]');
  if (await headerButton.isVisible()) {
    await headerButton.click();
    return;
  }
  await page.locator(".oc-footer-tour").click();
}

async function tourTitles(page: Page, limit = 20): Promise<string[]> {
  const tooltip = page.locator(".oc-tour-tooltip");
  await expect(tooltip).toBeVisible({ timeout: 15_000 });
  const titles: string[] = [];
  for (let guard = 0; guard < limit; guard += 1) {
    titles.push((await tooltip.locator(".oc-tour-tooltip-title").innerText()).trim());
    const next = tooltip.getByRole("button", { name: "次へ" });
    if ((await next.count()) === 0) break;
    await next.click();
    await expect(tooltip).toBeVisible();
  }
  return titles;
}

async function expectFitsViewport(page: Page): Promise<void> {
  const tooltip = page.locator(".oc-tour-tooltip");
  for (let guard = 0; guard < 20; guard += 1) {
    const fits = await tooltip.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const vv = window.visualViewport;
      const width = vv?.width ?? window.innerWidth;
      const height = vv?.height ?? window.innerHeight;
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width, height };
    });
    expect(fits.left).toBeGreaterThanOrEqual(-1);
    expect(fits.right).toBeLessThanOrEqual(fits.width + 1);
    expect(fits.top).toBeGreaterThanOrEqual(-1);
    expect(fits.bottom).toBeLessThanOrEqual(fits.height + 1);
    const next = tooltip.getByRole("button", { name: "次へ" });
    if ((await next.count()) === 0) break;
    await next.click();
    await expect(tooltip).toBeVisible();
  }
}

// 開発ツールを隠している分、本物の例外は Playwright 側で検出する。
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = collectPageErrors(page);
});
test.afterEach(() => {
  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});

test.describe("プラグイン画面のツアー", () => {
  test("一覧: 作り方・タブ・検索・一覧・取り込みを案内する", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/plugins/");
    await expect(page.locator('[data-tour="plugins-actions"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toEqual([
      "作り方と審査の入口",
      "公開・自分・導入済み",
      "検索と絞り込み",
      "プラグイン一覧",
      "GitHub / Gist から取り込む（任意）",
    ]);
    await expect(page.locator(".oc-tour-tooltip").getByRole("link", { name: "ヘルプで詳しく" })).toHaveAttribute(
      "href",
      "/help/#plugins",
    );
  });

  test("エディタ: ログインなしの制限と manifest・コード・保存・プレビューを案内する", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/plugins/new/");
    await expect(page.locator('[data-tour="plugin-editor-anon-note"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toEqual([
      "ログインせずに作るとき",
      "manifest（名前・権限・スコープ）",
      "コード（plugin.js）",
      "保存・プレビュー・静的検査・公開申請",
      "プレビュー（sandbox）",
    ]);
  });

  test("テンプレート: 選ぶ・作ったあとの扱いを案内する", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/plugins/templates/");
    await expect(page.locator('[data-tour="plugin-templates-pick"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toEqual([
      "ログインせずに保存するとき",
      "コードを直接書きたいとき",
      "テンプレートを選ぶ",
      "作ったあとの扱い",
    ]);
  });

  test("詳細（未ログイン）: 一般向けの手順だけを案内し、作者向けは出さない", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const id = await officialPluginId(request);
    await page.goto(`/plugins/view/?id=${encodeURIComponent(id)}`);
    await expect(page.locator('[data-tour="plugin-detail-basic"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toEqual(["基本情報", "インストール", "通報", "バージョン"]);
    expect(titles).not.toContain("作者向けの操作");
    expect(titles).not.toContain("GitHub / Gist（作者向け・任意）");
  });

  test("詳細（作者）: 作者向けの操作も案内する", async ({ page, request, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const id = await createOwnedPlugin(request);
    await page.goto(`/plugins/view/?id=${encodeURIComponent(id)}`);
    // 作者（viewer.canEdit）の読み込みを待ってから開始する。
    await expect(page.locator('[data-tour="plugin-detail-owner"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toContain("作者向けの操作");
    expect(titles).toContain("GitHub / Gist（作者向け・任意）");
  });

  test("板のプラグイン: 管理人だけがツアーを開始できる", async ({ page, request, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    await page.goto(`/plugins/board/?slug=${slug}`);
    await expect(page.locator('[data-tour="plugins-board-target"]')).toContainText(slug, { timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toEqual(["対象の板", "プラグインを導入", "この板のプラグイン"]);
  });

  test("板のプラグイン: 権限のない人は開始できずヘルプへ案内される", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    await page.goto(`/plugins/board/?slug=${slug}`);
    await expect(page.locator('[data-tour="plugins-board-target"]')).toContainText(slug, { timeout: 20_000 });
    await startTour(page);
    await expect(page).toHaveURL(/\/help\/?#tour$/, { timeout: 10_000 });
    await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);
  });

  test("読み込み中に押した「使い方」はヘルプへ飛ばず、権限の読み込み後に開始する", async ({ page, request, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    // 板 API を遅らせて「読み込み中に押す」状況を作る。
    await page.route("**/api/v1/boards/**", async (route) => {
      await delay(1200);
      await route.continue();
    });
    await page.goto(`/plugins/board/?slug=${slug}`);
    await closeIntro(page);
    const headerButton = page.locator('header [data-tour="site-tour"]');
    await headerButton.waitFor({ state: "visible", timeout: 10_000 });
    await headerButton.click();
    // 読み込み前なので、まだヘルプへは飛ばない。
    await expect(page).toHaveURL(new RegExp(`/plugins/board/?\\?slug=${slug}$`));
    const titles = await tourTitles(page);
    expect(titles[0]).toBe("対象の板");
  });

  test("審査キュー: 所有者だけが開始でき、状態と判定を案内する", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    await page.goto("/plugins/review/");
    await expect(page.locator('[data-tour="plugins-review-filters"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toEqual(["審査の状態", "申請の内容と判定"]);
  });

  test("審査キュー: 権限のない人は開始できずヘルプへ案内される", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/plugins/review/");
    await expect(page.locator('[data-tour="plugins-review-filters"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    await expect(page).toHaveURL(/\/help\/?#tour$/, { timeout: 10_000 });
  });

  test("作成トークン: ログイン中だけ発行・接続・失効・取り扱いを案内する", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    await page.goto("/account/plugin-tokens/");
    await expect(page.locator('[data-tour="plugin-tokens-issue"]')).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    const titles = await tourTitles(page);
    expect(titles).toEqual(["トークンを発行する", "接続手順", "発行済みのトークン", "AI が作った下書きの確認", "トークンの取り扱い"]);
  });

  test("作成トークン: 未ログインでは開始できずヘルプへ案内される", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/account/plugin-tokens/");
    await expect(page.getByText("ログインが必要です。")).toBeVisible({ timeout: 20_000 });
    await startTour(page);
    await expect(page).toHaveURL(/\/help\/?#tour$/, { timeout: 10_000 });
  });
});

test.describe("360px のツアー", () => {
  test("全プラグイン画面で全手順の吹き出しが画面内に収まる", async ({ page, request, context }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    const officialId = await officialPluginId(request);
    await page.setViewportSize({ width: 360, height: 740 });

    const cases: Array<{ path: string; selector: string; minimum: number }> = [
      // 公開画面は未ログインのまま（ログインなしの制限の手順も含める）。
      { path: "/plugins/", selector: '[data-tour="plugins-actions"]', minimum: 5 },
      { path: "/plugins/new/", selector: '[data-tour="plugin-editor-manifest"]', minimum: 5 },
      { path: "/plugins/templates/", selector: '[data-tour="plugin-templates-pick"]', minimum: 4 },
      { path: `/plugins/view/?id=${encodeURIComponent(officialId)}`, selector: '[data-tour="plugin-detail-basic"]', minimum: 4 },
      // 権限の要る画面は所有者で確認する。
      { path: `/plugins/board/?slug=${slug}`, selector: '[data-tour="plugins-board-target"]', minimum: 3 },
      { path: "/plugins/review/", selector: '[data-tour="plugins-review-filters"]', minimum: 2 },
      { path: "/account/plugin-tokens/", selector: '[data-tour="plugin-tokens-issue"]', minimum: 5 },
    ];

    for (const [index, item] of cases.entries()) {
      if (index === 4) await loginAsOwner(context);
      await page.goto(item.path);
      await expect(page.locator(item.selector)).toBeVisible({ timeout: 20_000 });
      await startTour(page);
      const tooltip = page.locator(".oc-tour-tooltip");
      await expect(tooltip).toBeVisible({ timeout: 15_000 });
      await expectFitsViewport(page);
      if (await tooltip.count()) await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
      // 全手順を歩いたことを件数で確認する。
      await startTour(page);
      const titles = await tourTitles(page);
      expect(titles.length, `${item.path} の手順数`).toBeGreaterThanOrEqual(item.minimum);
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
    }
  });
});

test.describe("サイトヘッダー・フッター", () => {
  test("プラグイン画面とアカウント画面にヘッダー・フッターが 1 つずつ出る", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const paths = [
      "/plugins/",
      "/plugins/new/",
      "/plugins/templates/",
      "/plugins/view/",
      "/plugins/board/",
      "/plugins/review/",
      "/plugins/demo/",
      "/account/",
      "/account/security",
      "/account/totp",
      "/account/plugin-tokens/",
      "/account/github",
      "/account/login",
      "/account/register",
    ];
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator(".oc-header")).toHaveCount(1);
      await expect(page.locator(".oc-header")).toBeVisible();
      await expect(page.locator(".oc-footer-tour")).toHaveCount(1);
    }
    // ツアーのある画面では「使い方」も 1 つだけ出る（狭幅では CSS で隠れる）。
    for (const path of ["/plugins/", "/plugins/new/", "/plugins/templates/", "/plugins/review/", "/account/plugin-tokens/"]) {
      await page.goto(path);
      await expect(page.locator('header [data-tour="site-tour"]')).toHaveCount(1);
    }
  });
});