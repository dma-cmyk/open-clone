// ヘルプ `#tour` のツアー一覧と、ツアー中の目次（設計 30 の A・B）の E2E。
//  - 一覧は TOUR_DEFINITIONS から出る（管理系は権限がある人だけ）
//  - 行を押すと対象の画面へ移り、準備ができてから 1 手順目が出る（板・スレは自動選択）
//  - 権限不足・別画面に残った予約では始めない（予約は捨てる）
//  - 目次から手順へ飛べる・Esc は目次だけ閉じる・フォーカスが戻る
//  - 360px でも一覧と目次が画面内に収まる
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { unique } from "../helpers/ids";
import { collectPageErrors, hideNextDevOverlay } from "./dev-overlay";

const OWNER_COOKIE = "e2e-owner-session-token";
// 板のスタッフを務めていないログイン利用者（seed の固定アカウント）。
// `e2e-user`（test-user）は他の spec が板の管理人として作るため、一覧の権限判定には使えない。
const PLAIN_USER_COOKIE = "e2e-tour-longname-session-token";
const DEPUTY_COOKIE = "e2e-tour-deputy-session-token";
const PENDING_KEY = "oc.tour.pending-start.v1";

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: `oc_sess=${OWNER_COOKIE}`,
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

/** 板を作る（作成者が板の管理人になる）。 */
async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("touridx").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `一覧の検証板 ${slug.slice(-4)}`,
      category: "E2E",
      description: "ツアー一覧の検証用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThread(request: APIRequestContext, slug: string): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: `一覧の検証スレ ${Date.now()}`, body: "1げっと。ツアー一覧の検証用です。" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { data?: { threadId?: number } };
  const threadId = body.data?.threadId;
  if (!threadId) throw new Error("スレ作成の応答が不正です");
  return threadId;
}

/** 板のスタッフにする（seed の固定アカウント。新規登録は使わない）。 */
async function addStaff(request: APIRequestContext, slug: string, accountName: string): Promise<void> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/staff`), {
    headers: ownerHeaders(),
    data: { accountName, level: "deputy" },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** セッション Cookie と「初回案内を出さない」設定を持たせた独立したブラウザ文脈。 */
async function openSession(browser: Browser, cookie?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("oc.tour.intro.v1", "1");
    } catch {
      // 保存できない環境でもテストは続ける
    }
  });
  if (cookie) {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: cookie, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
  }
  const page = await context.newPage();
  await hideNextDevOverlay(page);
  return { context, page };
}

const tooltip = (page: Page) => page.locator(".oc-tour-tooltip");
const row = (page: Page, key: string) => page.locator(`[data-tour-page="${key}"]`);

/** いまの画面のツアーを始める（狭幅ではヘッダーの「使い方」が隠れるのでフッターから）。 */
async function startTourHere(page: Page): Promise<void> {
  const header = page.getByRole("button", { name: "使い方", exact: true });
  if (await header.isVisible()) {
    await header.click();
    return;
  }
  await page.locator(".oc-footer-tour").click();
}

async function openTourList(page: Page): Promise<void> {
  await page.goto("/help/#tour");
  await expect(page.locator("section#tour")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-tour="tour-list"]')).toBeVisible({ timeout: 20_000 });
}

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = collectPageErrors(page);
});
test.afterEach(() => {
  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});

test.describe("ツアーの一覧", () => {
  test("一覧にツアーが並び、未ログインには管理系の行が出ない", async ({ page, request }) => {
    await createBoard(request);
    await openTourList(page);

    for (const key of ["home", "board", "thread", "board-new", "settings", "help"]) {
      await expect(row(page, key), `${key} の行`).toHaveCount(1);
    }
    // 管理系は権限が分かってから出す（未ログインでは出ない）。
    await expect(row(page, "admin")).toHaveCount(0);
    await expect(row(page, "manage")).toHaveCount(0);

    // 説明・手順数・開始ボタンがそろっている
    const home = row(page, "home");
    await expect(home.locator(".oc-tour-list-count")).toHaveText(/\d+ 手順/);
    await expect(home.locator(".oc-tour-list-summary")).not.toBeEmpty();
    await expect(home.getByRole("button", { name: "このツアーを始める" })).toBeEnabled();
  });

  test("一覧の各行から、その画面の 1 手順目が出る", async ({ page, request }) => {
    const slug = await createBoard(request);
    await createThread(request, slug);
    const expectations: Array<{ key: string; path: RegExp }> = [
      { key: "home", path: /\/$/ },
      { key: "board", path: /\/b\/[^/]+$/ },
      { key: "thread", path: /\/b\/[^/]+\/t\/\d+$/ },
      { key: "board-new", path: /\/boards\/new$/ },
      { key: "settings", path: /\/settings$/ },
      { key: "help", path: /\/help\/?(#.*)?$/ },
    ];
    for (const { key, path } of expectations) {
      await openTourList(page);
      await row(page, key).getByRole("button", { name: "このツアーを始める" }).click();
      await expect(page, `${key}: 移動先`).toHaveURL(path, { timeout: 15_000 });
      await expect(tooltip(page), `${key}: 1 手順目`).toBeVisible({ timeout: 15_000 });
      await expect(tooltip(page).locator(".oc-tour-progress"), `${key}: 手順番号`).toHaveText(/^1 \/ \d+$/);
      await expect(page.locator(".oc-tour-spot, .oc-tour-backdrop").first(), `${key}: 強調`).toBeAttached();
      await page.keyboard.press("Escape");
      await expect(tooltip(page)).toHaveCount(0);
    }
  });

  test("板とスレは自動で選んだ先を開く（削除板は選ばれない）", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug);
    await openTourList(page);

    await row(page, "board").getByRole("button", { name: "このツアーを始める" }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}$`), { timeout: 15_000 });
    await expect(tooltip(page)).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    await openTourList(page);
    await row(page, "thread").getByRole("button", { name: "このツアーを始める" }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}/t/${threadId}$`), { timeout: 15_000 });
    await expect(tooltip(page)).toBeVisible({ timeout: 15_000 });
  });

  test("一般利用者には管理系の行が出ず、板スタッフ・所有者には出る", async ({ browser, request }) => {
    const slug = await createBoard(request);
    await addStaff(request, slug, "trev-deputy");

    // 一般利用者（板のスタッフではない）
    const general = await openSession(browser, PLAIN_USER_COOKIE);
    try {
      await openTourList(general.page);
      await expect(row(general.page, "admin")).toHaveCount(0);
      await expect(row(general.page, "manage")).toHaveCount(0);
    } finally {
      await general.context.close();
    }

    // 板スタッフ（副管理人）: 板の管理の行だけが出て、押すとその板の管理画面で始まる
    const deputy = await openSession(browser, DEPUTY_COOKIE);
    try {
      await openTourList(deputy.page);
      await expect(row(deputy.page, "manage")).toHaveCount(1);
      await expect(row(deputy.page, "admin")).toHaveCount(0);
      await expect(row(deputy.page, "manage").locator(".oc-tour-list-summary")).not.toBeEmpty();
      await row(deputy.page, "manage").getByRole("button", { name: "このツアーを始める" }).click();
      await expect(deputy.page).toHaveURL(new RegExp(`/b/${slug}/manage$`), { timeout: 15_000 });
      await expect(tooltip(deputy.page)).toBeVisible({ timeout: 20_000 });
    } finally {
      await deputy.context.close();
    }

    // サイト所有者: 管理画面の行が出て、押すと /admin で始まる
    const owner = await openSession(browser, OWNER_COOKIE);
    try {
      await openTourList(owner.page);
      await expect(row(owner.page, "admin")).toHaveCount(1);
      await row(owner.page, "admin").getByRole("button", { name: "このツアーを始める" }).click();
      await expect(owner.page).toHaveURL(/\/admin\/?$/, { timeout: 15_000 });
      await expect(tooltip(owner.page)).toBeVisible({ timeout: 20_000 });
      await expect(tooltip(owner.page).locator(".oc-tour-progress")).toHaveText(/^1 \/ \d+$/);
    } finally {
      await owner.context.close();
    }
  });

  test("権限が無い画面への予約は、ツアーを始めずヘルプの該当節へ送る", async ({ browser, request }) => {
    const slug = await createBoard(request);
    const general = await openSession(browser, PLAIN_USER_COOKIE);
    try {
      const { page } = general;
      await page.goto(`/b/${slug}/manage`);
      await expect(page.locator(".oc-main").first()).toContainText("権限が必要", { timeout: 20_000 });
      await page.evaluate((key) => {
        window.sessionStorage.setItem(key, JSON.stringify({ page: "manage", at: Date.now() }));
      }, PENDING_KEY);
      await page.reload();
      await expect(page).toHaveURL(/\/help\/admin\/?#board-staff$/, { timeout: 20_000 });
      await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);
      // 予約は捨てる（残して次の画面で始めない）
      const left = await page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_KEY);
      expect(left).toBeNull();
    } finally {
      await general.context.close();
    }
  });

  test("別の画面に残っていた予約ではツアーを始めない（予約は捨てる）", async ({ page }) => {
    await page.addInitScript((key) => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify({ page: "board", at: Date.now() }));
      } catch {
        // ストレージが使えない環境ではこのテストは意味を持たない
      }
    }, PENDING_KEY);
    await page.goto("/");
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    // 板のツアーがトップで勝手に始まらない
    await page.waitForTimeout(1200);
    await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((key) => window.sessionStorage.getItem(key), PENDING_KEY))
      .toBeNull();
  });
});

test.describe("ツアー中の目次", () => {
  test("目次から途中の手順へ飛べて、次へ・戻るが続く", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    await expect(page.locator('[data-tour="home-boards"]')).toBeVisible({ timeout: 20_000 });
    await startTourHere(page);

    const dialog = tooltip(page);
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const total = Number((await dialog.locator(".oc-tour-progress").innerText()).split("/")[1]?.trim());
    // 狭幅では画面に無い部品の手順が飛ばされるため、件数は実測に合わせる。
    expect(total).toBeGreaterThanOrEqual(3);

    await dialog.getByRole("button", { name: "目次" }).click();
    const toc = page.locator("#oc-tour-toc");
    await expect(toc).toBeVisible();
    await expect(toc.locator(".oc-tour-toc-item")).toHaveCount(total);
    // いまの手順が分かる
    await expect(toc.locator('.oc-tour-toc-item[aria-current="step"]')).toHaveCount(1);
    await expect(toc.locator(".oc-tour-toc-item").first()).toHaveAttribute("aria-current", "step");

    // 3 番目の手順へ飛ぶ
    const third = toc.locator(".oc-tour-toc-item").nth(2);
    const thirdTitle = (await third.locator(".oc-tour-toc-title").innerText()).trim();
    await third.click();
    await expect(toc).toHaveCount(0);
    await expect(dialog.locator(".oc-tour-progress")).toHaveText(new RegExp(`^3 / ${total}$`));
    await expect(dialog.locator(".oc-tour-tooltip-title")).toHaveText(thirdTitle);

    // 目次から飛んだ後も「次へ」で続く
    await dialog.getByRole("button", { name: "次へ" }).click();
    await expect(dialog.locator(".oc-tour-progress")).toHaveText(new RegExp(`^4 / ${total}$`));
    // 「戻る」も続く
    await dialog.getByRole("button", { name: "戻る" }).click();
    await expect(dialog.locator(".oc-tour-progress")).toHaveText(new RegExp(`^3 / ${total}$`));
  });

  test("目次を開いている間の Esc は目次だけを閉じ、フォーカスは目次ボタンへ戻る", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    await startTourHere(page);
    const dialog = tooltip(page);
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // キーボードでも開ける
    await dialog.getByRole("button", { name: "目次" }).focus();
    await page.keyboard.press("Enter");
    const toc = page.locator("#oc-tour-toc");
    await expect(toc).toBeVisible();
    // 開いたら目次の中（いまの手順）へフォーカスが移る
    await expect
      .poll(() => page.evaluate(() => Boolean(document.querySelector("#oc-tour-toc")?.contains(document.activeElement))))
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(toc).toHaveCount(0);
    // ツアー自体は続いている
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? ""))
      .toBe("目次");

    // もう一度 Esc でツアーを終える
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("360px でも一覧と目次が画面内に収まる", async ({ page, request }) => {
    await createBoard(request);
    await page.setViewportSize({ width: 360, height: 740 });
    await openTourList(page);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth, "一覧が横にはみ出さない").toBeLessThanOrEqual(overflow.innerWidth + 1);

    await row(page, "home").getByRole("button", { name: "このツアーを始める" }).click();
    await expect(tooltip(page)).toBeVisible({ timeout: 15_000 });
    await tooltip(page).getByRole("button", { name: "目次" }).click();
    const toc = page.locator("#oc-tour-toc");
    await expect(toc).toBeVisible();

    const fits = await page.evaluate(() => {
      const tooltipEl = document.querySelector(".oc-tour-tooltip");
      const tocEl = document.querySelector("#oc-tour-toc");
      if (!(tooltipEl instanceof HTMLElement) || !(tocEl instanceof HTMLElement)) return null;
      const box = tooltipEl.getBoundingClientRect();
      const vv = window.visualViewport;
      const width = vv?.width ?? window.innerWidth;
      const height = vv?.height ?? window.innerHeight;
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width,
        height,
        tocWidth: tocEl.getBoundingClientRect().width,
      };
    });
    expect(fits).not.toBeNull();
    if (fits) {
      expect(fits.left).toBeGreaterThanOrEqual(-1);
      expect(fits.right).toBeLessThanOrEqual(fits.width + 1);
      expect(fits.top).toBeGreaterThanOrEqual(-1);
      expect(fits.bottom).toBeLessThanOrEqual(fits.height + 1);
      expect(fits.tocWidth).toBeLessThanOrEqual(fits.width + 1);
    }

    // 目次の項目はタップできる高さ（40px 以上）を保つ
    const itemHeights = await page.locator(".oc-tour-toc-item").evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height),
    );
    expect(Math.min(...itemHeights)).toBeGreaterThanOrEqual(40);
  });
});