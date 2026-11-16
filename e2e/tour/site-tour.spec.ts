// サイトツアーの E2E。
//  - 初回の案内は勝手に始まらず、閉じたら二度と出ない
//  - トップ・板・スレのツアーを最後まで進められる（手順の見出しが順に出る）
//  - 画面に無い要素の手順は飛ばす（ログイン状態・板設定で出ない部品）
//  - 360px でも説明が画面外にはみ出さない
//  - Esc / ←→ で操作できる
//  - ヘッダー・フッターの「使い方」「ヘルプ」導線
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
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
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
  await context.addCookies([
    { name: "oc_sess", value: "e2e-owner-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function createBoard(request: APIRequestContext, settings: Record<string, unknown> = {}): Promise<string> {
  const slug = unique("tour").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `ツアー検証板 ${slug.slice(-4)}`,
      category: "E2E",
      description: "サイトツアーの検証用",
      settings: { turnstile: "off", cooldownSeconds: 0, ...settings },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThread(request: APIRequestContext, slug: string): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: `ツアー検証スレ ${Date.now()}`, body: "1げっと。ツアーの検証用です。" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { ok: boolean; data?: { threadId?: number } };
  const threadId = body.data?.threadId;
  if (!threadId) throw new Error("スレ作成の応答が不正です");
  return threadId;
}

async function openHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
}

/** ツアーを最後まで進め、表示された見出しを順に集める。 */
async function runTourToEnd(page: Page): Promise<string[]> {
  const tooltip = page.locator(".oc-tour-tooltip");
  await expect(tooltip).toBeVisible({ timeout: 10_000 });
  const titles: string[] = [];
  for (let guard = 0; guard < 30; guard += 1) {
    const title = await tooltip.locator(".oc-tour-tooltip-title").innerText();
    titles.push(title.trim());
    const next = tooltip.getByRole("button", { name: "次へ" });
    if ((await next.count()) === 0) break;
    await next.click();
    await expect(tooltip).toBeVisible();
  }
  return titles;
}


// 開発ツールを隠している分、本物の例外は Playwright 側で検出する（レビュー M01）。
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = collectPageErrors(page);
});
test.afterEach(() => {
  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});

test.describe("初回の案内", () => {
  test("はじめての訪問では案内を出すが、ツアーは勝手に始まらない。閉じたら再読み込みでも出ない", async ({ page }) => {
    await hideNextDevOverlay(page);
    await openHome(page);
    const intro = page.locator(".oc-tour-intro");
    await expect(intro).toBeVisible({ timeout: 20_000 });
    await expect(intro).toContainText("はじめての方へ");
    // 勝手にツアーは始まらない
    await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);

    await intro.getByRole("button", { name: "閉じる" }).click();
    await expect(intro).toHaveCount(0);

    await page.reload();
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    await expect(page.locator(".oc-tour-intro")).toHaveCount(0);
  });

  test("案内の「ツアー開始」でツアーが始まる", async ({ page }) => {
    await hideNextDevOverlay(page);
    await openHome(page);
    await page.locator(".oc-tour-intro").getByRole("button", { name: "ツアー開始" }).click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 10_000 });
    await expect(tooltip).toContainText("トップページの使い方");
    await expect(page.locator(".oc-tour-spot")).toHaveCount(1);
  });
});

test.describe("画面ごとのツアー", () => {
  test("トップ: 最後まで進めるとヘルプへの導線になる", async ({ page }) => {
    await hideNextDevOverlay(page);
    await openHome(page);
    await page.locator(".oc-tour-intro").getByRole("button", { name: "閉じる" }).click();
    // 板一覧の読み込みを待ってから開始する（読み込み前に始めると、その手順は飛ばされる）
    await expect(page.locator('[data-tour="home-boards"]')).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "使い方", exact: true }).click();

    const titles = await runTourToEnd(page);
    expect(titles.length).toBeGreaterThanOrEqual(4);
    // ヘッダー検索は狭幅では非表示。その場合は画面内の検索帯（SP 用）を指す。
    expect(titles[0]).toBe("サイト内検索");
    expect(titles.join(" / ")).toContain("板一覧");
    // 最後の手順では「次へ」の代わりにヘルプへ行くボタンになる
    const tooltip = page.locator(".oc-tour-tooltip");
    const help = tooltip.getByRole("link", { name: "ヘルプで詳しく" });
    await expect(help).toHaveAttribute("href", /^\/help\//);
    // 「もっと詳しく（ヘルプ）」も各手順にある
    await expect(tooltip.getByRole("link", { name: "もっと詳しく（ヘルプ）" })).toHaveAttribute("href", /^\/help\/#/);
  });

  test("板: スレ一覧・並び替え・板ルール・スレ立ての順に案内する", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    await page.goto(`/b/${slug}`);
    // 板名は PC では .oc-board-title、狭幅では .oc-sp-maintitle に出る
    await expect(
      page.locator(".oc-board-title:visible, .oc-sp-maintitle:visible").first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-tour-intro")).toBeVisible();
    await page.getByRole("button", { name: "使い方", exact: true }).click();

    const titles = await runTourToEnd(page);
    expect(titles).toEqual(["板のルール", "板の中を検索", "並び替え", "スレ一覧", "スレを立てる"]);
  });

  test("スレ: 見出し・検索・表示範囲・実況・レス操作・書き込みフォームを案内する", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "使い方", exact: true }).click();

    const titles = await runTourToEnd(page);
    // 板設定で turnstile=off なので「ロボット確認」の手順は飛ばされる
    expect(titles).toContain("スレの見出し");
    expect(titles).toContain("レス番号・ID・アンカー");
    expect(titles).toContain("書き込みフォーム");
    expect(titles).toContain("画像・お絵かき");
    expect(titles).toContain("文字数の上限");
    expect(titles).not.toContain("ロボット確認");
    // ヘルプは一般向け
    await expect(page.locator(".oc-tour-tooltip").getByRole("link", { name: "ヘルプで詳しく" })).toHaveAttribute(
      "href",
      /^\/help\/#/,
    );
  });

  test("ログインしていればロボット確認の手順も飛ばす（未ログインでは出る）", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug);

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "使い方", exact: true }).click();
    const anonymousTitles = await runTourToEnd(page);
    expect(anonymousTitles).toContain("ロボット確認");

    await loginAsOwner(context);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "使い方", exact: true }).click();
    const ownerTitles = await runTourToEnd(page);
    expect(ownerTitles).not.toContain("ロボット確認");
    expect(anonymousTitles.length).toBeGreaterThan(ownerTitles.length);
  });

  test("360px でもツールチップが画面内に収まる", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    // 初回の案内が出ていれば閉じる（下端のフッター導線と重なるため）
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();
    // 狭幅ではヘッダーの「使い方」が隠れるので、フッターの導線から始める
    await page.locator(".oc-footer-tour").click();

    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 10_000 });
    for (let guard = 0; guard < 20; guard += 1) {
      // 見えている領域（visualViewport）を基準に、ブラウザ自身の座標で測る。
      // Playwright の boundingBox はモバイルエミュレーションで visual viewport と
      // ずれることがあるため（実測: innerHeight 765 / visualViewport 740）、
      // 「利用者に見えているか」は getBoundingClientRect で判定する。
      const fits = await tooltip.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const vv = window.visualViewport;
        const width = vv?.width ?? window.innerWidth;
        const height = vv?.height ?? window.innerHeight;
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width,
          height,
        };
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
  });

  test("Esc で終了し、←→ で手順を行き来できる", async ({ page }) => {
    await hideNextDevOverlay(page);
    await openHome(page);
    await page.locator(".oc-tour-intro").getByRole("button", { name: "閉じる" }).click();
    await page.getByRole("button", { name: "使い方", exact: true }).click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".oc-tour-progress")).toHaveText(/^1 \/ \d+$/);

    await page.keyboard.press("ArrowRight");
    await expect(tooltip.locator(".oc-tour-progress")).toHaveText(/^2 \/ \d+$/);
    await page.keyboard.press("ArrowLeft");
    await expect(tooltip.locator(".oc-tour-progress")).toHaveText(/^1 \/ \d+$/);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  });
});

test.describe("ヘッダー・フッターの導線", () => {
  test("ヘッダーに「使い方」と「ヘルプ」があり、ヘルプは /help/ を指す", async ({ page }) => {
    await hideNextDevOverlay(page);
    await openHome(page);
    await expect(page.getByRole("button", { name: "使い方", exact: true })).toBeVisible();
    await expect(page.locator('.oc-header-inner a[href="/help/"]')).toHaveCount(1);
  });

  test("フッターに ヘルプ・使い方ツアー・管理者の方へ がある", async ({ page }) => {
    await hideNextDevOverlay(page);
    await openHome(page);
    const footer = page.locator(".oc-footer");
    await expect(footer.locator('a[href="/help/"]')).toHaveCount(1);
    await expect(footer.locator('a[href="/help/admin/"]')).toHaveCount(1);
    await expect(footer.locator(".oc-footer-tour")).toBeVisible();
  });

  test("ツアーの無い画面では「使い方」を出さない（ヘルプは出す）", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/search");
    await expect(page.locator("main")).toContainText("検索", { timeout: 20_000 });
    await expect(page.locator('.oc-header button.oc-hide-sp', { hasText: "使い方" })).toHaveCount(0);
    await expect(page.locator('.oc-header-inner a[href="/help/"]')).toHaveCount(1);
  });
});