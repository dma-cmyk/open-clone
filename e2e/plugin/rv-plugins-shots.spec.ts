// レビュー修正 B3/B7/B10/B11/B12/B13/B14 の証拠スクリーンショット撮影用 spec。
// 実行方法:
//   cd e2e && E2E_WEB_PORT=3121 E2E_API_PORT=8821 E2E_STUB_PORT=8892 ... \
//     pnpm exec playwright test rv-plugins-shots.spec.ts --project=pc --workers=1
// 出力: test-results-rv-plugins/shots/*.png（20_証拠 へコピーして使う）
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";
const OWNER_SESSION = "e2e-owner-session-token";
const SHOT_DIR = "test-results-rv-plugins/shots";

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

async function prepareBoardAndThread(request: APIRequestContext): Promise<{ slug: string }> {
  const slug = unique("shot").toLowerCase();
  // 板・スレの作成は owner セッションで行う（test-user の連続作成が
  // レート制限に触れて 500 になるのを避ける。スクリーンショットには影響しない）。
  const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      Cookie: `oc_sess=${OWNER_SESSION}`,
    },
    data: {
      slug,
      name: `証拠板${slug.slice(-4)}`,
      category: "E2E",
      description: "スクリーンショット用",
      settings: { turnstile: "off" },
    },
  });
  expect(boardResponse.status(), await boardResponse.text()).toBe(201);
  const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      Cookie: `oc_sess=${OWNER_SESSION}`,
    },
    data: { title: `証拠スレ ${slug}`, body: "1げっと\nこれは本文です", turnstileToken: "1x00000000000000000000AA" },
  });
  expect(threadResponse.status(), await threadResponse.text()).toBe(201);
  return { slug };
}

test.describe("証拠スクリーンショット（B3/B7/B10/B11/B12/B13/B14）", () => {
  // B7: プラグインナビ（PC 1142px 相当 = 既定の PC ビューポートで十分）
  test("B7: プラグイン一覧のナビがはみ出さない", async ({ page, context }) => {
    await page.setViewportSize({ width: 1142, height: 900 });
    await page.goto("/plugins/");
    await expect(page.getByRole("navigation", { name: "プラグイン内の移動" })).toBeVisible();
    await shot(page, "b7-plugins-nav-1142");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, "横スクロールが発生していない").toBe(false);
  });

  test("B7: プラグイン一覧のナビ（360px）", async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/plugins/");
    await expect(page.getByRole("navigation", { name: "プラグイン内の移動" })).toBeVisible();
    await shot(page, "b7-plugins-nav-360");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });

  // B13/B14: 未ログインの一覧と導入（40 以降: 匿名でも mine が使える）
  test("B13: 未ログインで mine タブは自分の端末の一覧（空なら空の案内）", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/plugins/?tab=mine");
    await expect(page.getByText("該当するプラグインがありません。")).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "b13-loggedout-mine-pc");
  });

  test("B13: 未ログインで mine タブ（360px）", async ({ page, context }) => {
    await context.clearCookies();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/plugins/?tab=mine");
    await expect(page.getByText("該当するプラグインがありません。")).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "b13-loggedout-mine-360");
  });

  test("B14: 匿名で公式 spoiler 詳細と導入（Cookie なし）", async ({ page, context, request }) => {
    await context.clearCookies();
    const response = await request.get(`${API_BASE}/v1/plugins?q=spoiler`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(response);
    const spoiler = body && body.ok ? body.data.items.find((item) => item.name === "spoiler") : undefined;
    expect(spoiler).toBeTruthy();
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler!.id)}`);
    await expect(page.getByRole("heading", { level: 1, name: "spoiler" })).toBeVisible();
    await shot(page, "b14-anon-detail-pc");
    // 導入して導入状況を見る
    await page.getByRole("button", { name: "個人用にインストール" }).click();
    await expect(page.getByText(/個人用にインストールしました/)).toBeVisible({ timeout: 15_000 });
    await shot(page, "b14-anon-installed-pc");
  });

  test("B14: 匿名詳細と導入（360px）", async ({ page, context, request }) => {
    await context.clearCookies();
    await page.setViewportSize({ width: 360, height: 740 });
    const response = await request.get(`${API_BASE}/v1/plugins?q=spoiler`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(response);
    const spoiler = body && body.ok ? body.data.items.find((item) => item.name === "spoiler") : undefined;
    expect(spoiler).toBeTruthy();
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler!.id)}`);
    await expect(page.getByRole("heading", { level: 1, name: "spoiler" })).toBeVisible();
    await shot(page, "b14-anon-detail-360");
  });

  // B11/B12: 詳細ページのリンクコピーと板選択（ログイン状態で）
  test("B11/B12: 詳細ページのリンクをコピーと板の選択", async ({ page, context, request }) => {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    const { slug } = await prepareBoardAndThread(request);

    const response = await request.get(`${API_BASE}/v1/plugins?q=spoiler`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(response);
    const spoiler = body && body.ok ? body.data.items.find((item) => item.name === "spoiler") : undefined;
    expect(spoiler).toBeTruthy();
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler!.id)}`);
    await expect(page.getByRole("button", { name: "リンクをコピー" })).toBeVisible();
    await shot(page, "b11-b12-detail-pc");
    // 板選択のプルダウンに作った板が載る
    const boardSelect = page.getByLabel("板用インストールの対象板");
    await expect(boardSelect).toBeVisible();
    await expect(boardSelect).toContainText(`証拠板${slug.slice(-4)}`);
    // コピー実行（権限はヘッダーで許可する）
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "リンクをコピー" }).click();
    await expect(page.getByRole("button", { name: "コピーしました" })).toBeVisible();
    await shot(page, "b11-copied-pc");
  });

  test("B11/B12: 詳細ページ（360px）", async ({ page, context, request }) => {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.setViewportSize({ width: 360, height: 740 });
    const response = await request.get(`${API_BASE}/v1/plugins?q=spoiler`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(response);
    const spoiler = body && body.ok ? body.data.items.find((item) => item.name === "spoiler") : undefined;
    expect(spoiler).toBeTruthy();
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler!.id)}`);
    await expect(page.getByRole("button", { name: "リンクをコピー" })).toBeVisible();
    await shot(page, "b11-b12-detail-360");
  });

  // B10: 名前空欄で静的検査
  test("B10: 名前空欄で静的検査を押すと名前欄のそばに理由", async ({ page, context }) => {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/plugins/new/");
    await page.getByLabel("名前（slug・変更不可）").fill("");
    await page.getByRole("button", { name: "静的検査", exact: true }).click();
    await expect(page.getByText("名前は英小文字・数字・ハイフンで 3〜41 文字")).toBeVisible({ timeout: 15_000 });
    await shot(page, "b10-empty-name-error-pc");
  });

  test("B10: 名名前欄のエラー（360px）", async ({ page, context }) => {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/plugins/new/");
    await page.getByLabel("名前（slug・変更不可）").fill("");
    await page.getByRole("button", { name: "静的検査", exact: true }).click();
    await expect(page.getByText("名前は英小文字・数字・ハイフンで 3〜41 文字")).toBeVisible({ timeout: 15_000 });
    await shot(page, "b10-empty-name-error-360");
  });

  // B3: 板一覧のスレッドリンク操作領域
  test("B3: 板ページのスレリンク操作領域（PC）", async ({ page, context, request }) => {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    const { slug } = await prepareBoardAndThread(request);
    await page.goto(`/b/${slug}`);
    await expect(page.locator(".oc-thread-row").first()).toBeVisible({ timeout: 15_000 });
    await shot(page, "b3-board-thread-links-pc");
    // 操作領域の高さを計測（44px 程度あること）
    const height = await page
      .locator(".oc-thread-row .oc-thread-link-target")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height, "リンクの高さが 30px 以上（パディング込みで押しやすい）").toBeGreaterThanOrEqual(30);
  });

  test("B3: 板ページのスレリンク（360px）", async ({ page, context, request }) => {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.setViewportSize({ width: 360, height: 740 });
    const { slug } = await prepareBoardAndThread(request);
    await page.goto(`/b/${slug}`);
    await expect(page.locator(".oc-thread-row").first()).toBeVisible({ timeout: 15_000 });
    await shot(page, "b3-board-thread-links-360");
    const height = await page
      .locator(".oc-thread-row .oc-thread-link-target")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(30);
  });
});
