// rv-ux C5〜C8 + UX-R3: 板作成フォーム（カテゴリ候補・認証案内）・同名板の区別・
// GitHub 連携案内・ログイン/新規登録の next 制限。
// 実スタック（next dev + wrangler dev + D1）を webServer で起動する前提。
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type BrowserContext, type TestInfo } from "@playwright/test";
import { API_BASE, ALLOWED_ORIGIN } from "../helpers/api";
import { unique } from "../helpers/ids";
import { skipRecoveryCodeStep } from "../helpers/register";

const OWNER_SESSION = "e2e-owner-session-token";

/**
 * スクリーンショットの出力先。既定は Playwright のテスト出力ディレクトリで、
 * 証拠を残したいときだけ E2E_EVIDENCE_DIR で指定する（レビュー UX-M2: 個人の絶対パス固定を廃止）。
 */
function shotPath(info: TestInfo, name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR ?? info.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function ownerHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` };
}

async function loginAsOwner(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3131");
  await context.addCookies([
    { name: "oc_sess", value: OWNER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function createBoard(request: APIRequestContext, slug: string, description: string): Promise<void> {
  const response = await request.post(`${API_BASE}/v1/boards`, {
    headers: ownerHeaders(),
    data: {
      slug,
      name: "動作確認",
      category: "動作確認",
      description,
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
}

test.describe("rv-ux C5〜C8（フォームと案内）", () => {
  test("C5: カテゴリ欄に既存カテゴリの候補と新規カテゴリの案内が出る", async ({ page, context, request }, info) => {
    await loginAsOwner(context);
    // 既存カテゴリの候補は実在する板のカテゴリから来るため、テスト自身で1件作る
    // （新しい D1 状態でも他 spec の残りに依存しないようにする）。
    const existing = unique("c5cat");
    const slug = unique("c5board").toLowerCase();
    const board = await request.post(`${API_BASE}/v1/boards`, {
      headers: ownerHeaders(),
      data: {
        slug,
        name: `カテゴリ候補板${slug.slice(-4)}`,
        category: existing,
        description: "C5 候補検証用",
        settings: { turnstile: "off", cooldownSeconds: 0 },
      },
    });
    expect(board.status(), await board.text()).toBe(201);

    await page.goto("/");
    await page.getByRole("link", { name: /板を作る/ }).first().click();
    await expect(page.getByLabel(/カテゴリ/)).toBeVisible({ timeout: 20_000 });

    // 既存カテゴリが datalist の候補として出る。
    const options = page.locator("datalist#oc-categories option");
    await expect(options.first()).toBeAttached({ timeout: 20_000 });
    const values = await options.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLOptionElement).value),
    );
    expect(values).toContain(existing);

    // 既存カテゴリ名を入れると「既存カテゴリ」の案内、新しい名前なら「新しいカテゴリ」の案内。
    const category = page.getByLabel(/カテゴリ/);
    const note = page.locator("label.oc-field").filter({ hasText: "カテゴリ" }).locator(".oc-note");
    await category.fill(existing);
    await expect(note).toContainText(`既存カテゴリ「${existing}」に分類されます`);
    const fresh = unique("cat");
    await category.fill(fresh);
    await expect(note).toContainText(`「${fresh}」は新しいカテゴリとして作成されます。`);
    await page.locator(".oc-grid-2").first().screenshot({ path: shotPath(info, "c5-after-pc.png") });
  });

  test("C6: ログイン済みなら「アカウントが必要です」を出さず、未ログインなら入力前に認証を促す", async ({
    page,
    context,
  }, info) => {
    // ログイン済み: 矛盾する案内（museAI #14）を出さない。
    await loginAsOwner(context);
    await page.goto("/");
    await page.getByRole("link", { name: /板を作る/ }).first().click();
    await expect(page.getByText(/でログイン中です/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("板の作成にはアカウントが必要です")).toHaveCount(0);
    await page.screenshot({ path: shotPath(info, "c6-after-login-pc.png") });

    // 未ログイン: フォーム入力前に認証を促し、ログイン後この画面へ戻る導線（?next=）を出す。
    await context.clearCookies();
    await page.goto("/");
    await page.getByRole("link", { name: /板を作る/ }).first().click();
    const noticeBox = page.locator(".oc-warn-box").filter({ hasText: "板の作成にはアカウントが必要です" });
    await expect(noticeBox).toBeVisible({ timeout: 20_000 });
    await expect(noticeBox).toContainText("入力する前に認証を済ませてください");
    const loginLink = noticeBox.getByRole("link", { name: "ログイン" });
    await expect(loginLink).toHaveAttribute("href", "/account/login?next=%2Fboards%2Fnew");
    await page.screenshot({ path: shotPath(info, "c6-after-logout-pc.png") });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: shotPath(info, "c6-after-logout-360.png") });
    await page.setViewportSize({ width: 1280, height: 720 });

    // 導線どおりログイン画面へ行き、?next= が保持される（戻る先の導線）。
    await loginLink.click();
    await expect(page).toHaveURL(/\/account\/login\?next=%2Fboards%2Fnew/);
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  });

  test("C7: 同名の板が並んでもトップとサイドバーで slug から区別できる", async ({ page, context, request }, info) => {
    await loginAsOwner(context);
    const stamp = Date.now().toString(36);
    const slugA = `rvuxdup-a-${stamp}`;
    const slugB = `rvuxdup-b-${stamp}`;
    await createBoard(request, slugA, "同名板A: 区別検証用");
    await createBoard(request, slugB, "同名板B: 区別検証用");

    await page.goto("/");
    const list = page.locator(".oc-board-list").filter({ hasText: slugA }).first();
    await expect(list).toBeVisible({ timeout: 20_000 });
    // トップ: 同名の板名が並ぶ中でも、各行に slug が出て区別できる（全幅で確認）。
    await expect(list.getByText(`/b/${slugA}`)).toBeVisible();
    await expect(list.getByText(`/b/${slugB}`)).toBeVisible();
    // サイドバーは 900px 未満で非表示になる既存仕様のため、広い画面のときだけ確認する
    // （mobile プロジェクトではトップの一覧のみが検証対象）。
    if ((page.viewportSize()?.width ?? 0) >= 900) {
      const sidebar = page.locator(".oc-sidebar");
      await expect(sidebar.getByText(`/b/${slugA}`)).toBeVisible();
      await expect(sidebar.getByText(`/b/${slugB}`)).toBeVisible();
    }
    await page.screenshot({ path: shotPath(info, "c7-after-wide.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 740 });
    // 360px ではサイドバーは非表示。トップの一覧で slug が見えることを確認する。
    await expect(list.getByText(`/b/${slugA}`)).toBeVisible();
    await expect(list.getByText(`/b/${slugB}`)).toBeVisible();
    await page.screenshot({ path: shotPath(info, "c7-after-360.png"), fullPage: true });
  });

  test("C8: OAuth 未設定時に PAT 代替と管理者設定後の見通しを案内する", async ({ page, context }, info) => {
    await loginAsOwner(context);

    // 案内の表示は API の `oauthAvailable` に従うため、実サーバーの設定
    // （E2E_GITHUB_STUB=1 だと OAuth 設定済みになる）に依存せず両状態を検査する。
    const stubStatus = (oauthAvailable: boolean) =>
      page.route("**/api/v1/github/link", (route) => {
        if (route.request().method() !== "GET") return route.continue();
        return route.fulfill({
          json: {
            ok: true,
            data: {
              linked: false,
              login: null,
              userId: null,
              avatarUrl: null,
              method: null,
              scopes: [],
              linkedAt: null,
              rate: null,
              oauthAvailable,
            },
          },
        });
      });

    // 未設定: 案内（PAT 代替・管理者設定の見通し）が出て、OAuth ボタンは無効。
    await stubStatus(false);
    await page.goto("/account/github");
    await expect(page.getByText("GitHub OAuth で連携").first()).toBeVisible({ timeout: 20_000 });
    const guide = page.locator(".oc-warn-box").filter({ hasText: "GitHub OAuth App が未設定のため" });
    await expect(guide).toBeVisible();
    await expect(guide).toContainText("fine-grained PAT を持ち込んで連携する");
    await expect(guide).toContainText("サーバー管理者が GitHub OAuth App を作成し");
    await expect(page.getByRole("button", { name: "GitHub で連携する" })).toBeDisabled();
    await page.screenshot({ path: shotPath(info, "c8-after-unconfigured-pc.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: shotPath(info, "c8-after-unconfigured-360.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.unroute("**/api/v1/github/link");

    // 設定済み: 未設定の案内は出さず、OAuth ボタンは有効。
    await stubStatus(true);
    await page.goto("/account/github");
    await expect(page.getByText("GitHub OAuth で連携").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-warn-box").filter({ hasText: "GitHub OAuth App が未設定のため" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "GitHub で連携する" })).toBeEnabled();
    await page.screenshot({ path: shotPath(info, "c8-after-configured-pc.png"), fullPage: true });
    await page.unroute("**/api/v1/github/link");
  });

  test("UX-R3: ログインの next は同一サイト内のパスだけを採用する", async ({ page }) => {
    const cases = [
      // 安全なローカルパスは保持する
      { next: "/settings", expectUrl: /\/settings$/ },
      { next: "/search?q=%E6%A4%9C%E7%B4%A2&type=full", expectUrl: /\/search\?q=/ },
      // 外部へ飛びうる値は既定（/account）へ落とす
      { next: "//outside.invalid/", expectUrl: /\/account$/ },
      { next: "/\\outside.invalid/", expectUrl: /\/account$/ },
      { next: "http://outside.invalid/", expectUrl: /\/account$/ },
      { next: "/%09/outside.invalid/", expectUrl: /\/account$/ },
    ] as const;

    for (const item of cases) {
      let external = 0;
      await page.route("http://outside.invalid/**", async (route) => {
        external += 1;
        await route.abort();
      });
      // ログイン成功だけスタブし、実アカウントは使わない。
      await page.route("**/api/v1/auth/login", (route) =>
        route.fulfill({ json: { ok: true, data: { authenticated: true } } }),
      );
      await page.goto(`/account/login?next=${encodeURIComponent(item.next)}`);
      await page.getByLabel("メールアドレス").fill("rvux@example.test");
      await page.getByLabel("パスワード", { exact: true }).fill("Rvux-pass-123");
      await page.getByRole("button", { name: "ログイン", exact: true }).click();
      await expect(page).toHaveURL(item.expectUrl, { timeout: 15_000 });
      expect(external, `next=${item.next} で外部遷移を試みない`).toBe(0);
      await page.unroute("http://outside.invalid/**");
      await page.unroute("**/api/v1/auth/login");
    }
  });

  test("UX-R3: 新規登録の next も同一サイト内のパスだけを採用する", async ({ page }) => {
    const cases = [
      { next: "/settings", expectUrl: /\/settings$/ },
      { next: "//outside.invalid/", expectUrl: /\/account$/ },
    ] as const;

    for (const item of cases) {
      let external = 0;
      await page.route("http://outside.invalid/**", async (route) => {
        external += 1;
        await route.abort();
      });
      await page.route("**/api/v1/auth/register", (route) =>
        route.fulfill({ json: { ok: true, data: { authenticated: true } } }),
      );
      await page.goto(`/account/register?next=${encodeURIComponent(item.next)}`);
      await page.getByLabel("表示名").fill("rvux-reg");
      await page.getByLabel("メールアドレス").fill(`rvux-${Date.now()}@example.test`);
      await page.getByLabel("パスワード（8文字以上）").fill("Rvux-pass-123");
      await page.getByLabel("パスワード（確認）").fill("Rvux-pass-123");
      await page.getByRole("button", { name: "登録する" }).click();
      // 登録成功後は復旧コードの任意ステップを挟む（設計 50 ①）。ここでは「あとで」で next へ進む。
      await skipRecoveryCodeStep(page);
      await expect(page).toHaveURL(item.expectUrl, { timeout: 15_000 });
      expect(external, `next=${item.next} で外部遷移を試みない`).toBe(0);
      await page.unroute("http://outside.invalid/**");
      await page.unroute("**/api/v1/auth/register");
    }
  });
});
