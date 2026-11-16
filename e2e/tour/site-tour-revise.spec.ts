// レビュー 52（T01〜T10）の回帰テスト。
//  - T01: 追加ラッパーでスマホの投稿バー（sticky）が壊れていないこと
//  - T02: 360px でヘッダーがはみ出さないこと
//  - T03: ツアーが開いた投稿欄は終了時に閉じる（利用者が開いたものは保持）
//  - T04: 権限が無い人には管理操作を案内しない（開始経路によらず）
//  - T06: 未対応画面の「使い方」はヘルプへ（何も起きない操作にしない）
//  - T07: ダイアログへフォーカスが移り、Tab が背景へ抜けない
//  - T08: 戻る／進むで画面が変わったらツアーを終了する
//  - T10: 管理者向けの通報リンクが実在するアンカーを指す
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { unique } from "../helpers/ids";
import { collectPageErrors, hideNextDevOverlay } from "./dev-overlay";

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: "oc_sess=e2e-owner-session-token",
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("trev").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `レビュー回帰 ${slug.slice(-4)}`,
      category: "E2E",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThread(request: APIRequestContext, slug: string, posts = 0): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: `回帰スレ ${Date.now()}`, body: "1げっと" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const threadId = ((await response.json()) as { data: { threadId: number } }).data.threadId;
  for (let index = 0; index < posts; index += 1) {
    await request.post(apiUrl(`/v1/threads/${threadId}/posts`), {
      headers: ownerHeaders(),
      data: { body: `長いスレ用のレス ${index} ${"あ".repeat(200)}` },
    });
  }
  return threadId;
}

async function loginAsUser(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
  await context.addCookies([
    { name: "oc_sess", value: "e2e-user-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

/** 上限（64 文字）の表示名を持つ実アカウントでログインする（T02）。
 *  pc/mobile の両プロジェクトで同じアカウントを使い、登録回数を増やさない（登録は 5 回/日/IP）。 */
async function loginWithLongName(context: BrowserContext, request: APIRequestContext): Promise<void> {
  const name = "長".repeat(64);
  const email = "trev-long-name@example.test";
  const password = "e2e-Password-1";
  const registered = await request.post(apiUrl("/v1/auth/register"), {
    headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    data: { name, email, password },
  });
  // 既に別プロジェクトが同じ実行内で作っている場合は 409。同じ資格情報でログインする。
  if (registered.status() !== 201) expect(registered.status(), await registered.text()).toBe(409);
  const login = await request.post(apiUrl("/v1/auth/login"), {
    headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
    data: { email, password },
  });
  expect(login.status(), await login.text()).toBe(200);
  const token = /oc_sess=([^;]+)/.exec(login.headers()["set-cookie"] ?? "")?.[1] ?? "";
  expect(token).not.toBe("");
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
  await context.addCookies([
    { name: "oc_sess", value: token, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

/** ツアーを「書き込みフォーム」の手順まで進める（reveal で投稿欄が開く）。 */
async function advanceToFormStep(tooltip: Locator): Promise<void> {
  for (let index = 0; index < 14; index += 1) {
    const title = await tooltip.locator(".oc-tour-tooltip-title").innerText();
    if (title.includes("書き込みフォーム")) return;
    const next = tooltip.getByRole("button", { name: "次へ" });
    if ((await next.count()) === 0) throw new Error("書き込みフォームの手順に到達しませんでした");
    await next.click();
    await expect(tooltip).toBeVisible();
  }
  throw new Error("書き込みフォームの手順に到達しませんでした");
}


// 開発ツールを隠している分、本物の例外は Playwright 側で検出する（レビュー M01）。
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = collectPageErrors(page);
});
test.afterEach(() => {
  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});

test.describe("サイトツアー レビュー52 回帰", () => {
  test("T01: 360px の長いスレで、ツアー未開始でも投稿バーが画面下に出る", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, 25);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });

    // いちばん下までスクロールした状態で、投稿バー（畳まれている場合は openbar）が見えている
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const bar = page.locator(".oc-form-openbar:visible, .oc-form:visible").first();
    await expect(bar).toBeVisible({ timeout: 10_000 });
    const fits = await page.evaluate(() => {
      const element = document.querySelector(".oc-form, .oc-form-openbar");
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const vv = window.visualViewport;
      return { top: rect.top, bottom: rect.bottom, height: vv?.height ?? window.innerHeight };
    });
    expect(fits).not.toBeNull();
    // ラッパーで包含ブロックが変わっていた不具合では、投稿バーが画面外（top 3476 相当）に出ていた。
    // 修正後はスクロール後に画面内（ビューポート内）に居ることを確認する。
    expect(fits!.top).toBeLessThan(fits!.height);
    expect(fits!.bottom).toBeLessThanOrEqual(fits!.height + 1);
    if (process.env.E2E_EVIDENCE_DIR) {
      await page.screenshot({ path: `${process.env.E2E_EVIDENCE_DIR}/t01_sticky_bar_360.png` });
    }
  });

  test("T02: 360-430px で案内中・閉じた後・再読込後・長い表示名でも横にはみ出さない", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, 25);
    const widths = [360, 375, 390, 414, 430];
    const metrics = () =>
      page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    for (const width of widths) {
      await page.setViewportSize({ width, height: 740 });
      // 初回案内が出ている状態
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await expect(page.locator(".oc-tour-intro")).toBeVisible({ timeout: 15_000 });
      let measured = await metrics();
      expect(measured.scroll, `案内中 ${width}px`).toBeLessThanOrEqual(measured.client);

      // 閉じた後（TourStyles が DOM から消えてもヘッダーの幅対策は残る）
      await page.locator(".oc-tour-intro").getByRole("button", { name: "案内を閉じる" }).click();
      await expect(page.locator(".oc-tour-intro")).toHaveCount(0);
      measured = await metrics();
      expect(measured.scroll, `案内を閉じた後 ${width}px`).toBeLessThanOrEqual(measured.client);

      // 再読込後（案内は再表示しない）
      await page.reload();
      await expect(page.locator(".oc-tour-intro")).toHaveCount(0);
      measured = await metrics();
      expect(measured.scroll, `再読込後 ${width}px`).toBeLessThanOrEqual(measured.client);
    }

    // 案内中でも投稿バーを通常クリックできる（force・非表示化はしない）
    await page.setViewportSize({ width: 360, height: 740 });
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.locator(".oc-tour-intro")).toBeVisible({ timeout: 15_000 });
    await page.locator(".oc-form-openbar").click();
    await expect(page.locator(".oc-form textarea")).toBeVisible({ timeout: 10_000 });
    await page.locator(".oc-form-collapse").click();

    // 案内中でもフッターの導線を通常クリックできる（画面下を覆っていない）
    await page.locator(".oc-footer-tour").click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 10_000 });
    await tooltip.getByRole("button", { name: "終了", exact: true }).click();
    await expect(tooltip).toHaveCount(0);

    // ツアー終了後も横幅が保たれる
    const after = await metrics();
    expect(after.scroll).toBeLessThanOrEqual(after.client);
  });

  test("T02: 上限 64 文字の表示名でも 360-430px で横にはみ出さない", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginWithLongName(context, request);
    await page.goto("/");
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    // セッション取得後にヘッダーへ表示名が出るまで待つ（表示前の測定をしない）
    await expect(page.locator('.oc-header [data-tour="site-account"]')).toContainText("長長", { timeout: 20_000 });
    for (const width of [360, 375, 390, 414, 430]) {
      await page.setViewportSize({ width, height: 740 });
      const measured = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(measured.scroll, `長い表示名 ${width}px`).toBeLessThanOrEqual(measured.client);
    }
    // 表示名のリンク自体が画面内に収まり、押せる
    const account = page.locator('.oc-header [data-tour="site-account"]');
    await expect(account).toBeVisible();
    const box = await account.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(430);
  });

  test("T03: ツアーが開いた投稿欄だけを、手順移動後も終了・Esc・離脱で戻す", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug);
    const threadPath = `/b/${slug}/t/${threadId}`;
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(threadPath);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();

    const tooltip = page.locator(".oc-tour-tooltip");
    const startTour = async () => {
      await page.locator(".oc-footer-tour").click();
      await expect(tooltip).toBeVisible({ timeout: 10_000 });
    };
    const endTour = async () => {
      await tooltip.getByRole("button", { name: "終了", exact: true }).click();
      await expect(tooltip).toHaveCount(0);
    };
    const expectClosed = async () => {
      await expect(page.locator(".oc-form-openbar")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".oc-form textarea")).toHaveCount(0);
    };
    const expectOpenWithDraft = async () => {
      await expect(page.locator(".oc-form textarea")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".oc-form textarea")).toHaveValue("利用者の入力済み下書き");
    };

    // (1) 初期は閉 → フォーム手順でツアーが開く → 前の手順へ戻っても終了時に閉じる
    await expect(page.locator(".oc-form-openbar")).toBeVisible();
    await startTour();
    await advanceToFormStep(tooltip);
    await expect(page.locator(".oc-form textarea")).toBeVisible({ timeout: 10_000 });
    await tooltip.getByRole("button", { name: "戻る", exact: true }).click();
    await endTour();
    await expectClosed();

    // (2) 初期は閉 → フォーム手順 → Esc でも閉じる
    await startTour();
    await advanceToFormStep(tooltip);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await expectClosed();

    // (3) 利用者が開いて下書きを入れた欄は、フォーム手順まで進めても終了時に閉じない
    await page.locator(".oc-form-openbar").click();
    await expect(page.locator(".oc-form textarea")).toBeVisible({ timeout: 10_000 });
    await page.locator(".oc-form textarea").fill("利用者の入力済み下書き");
    await startTour();
    await advanceToFormStep(tooltip);
    await endTour();
    await expectOpenWithDraft();

    // (4) 同じ欄は Esc でも閉じない
    await startTour();
    await advanceToFormStep(tooltip);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await expectOpenWithDraft();
    await page.locator(".oc-form-collapse").click();
    await expectClosed();

    // (5) SPA の履歴で離脱したら、ツアーもスポットも残らない（開いた欄は画面ごと閉じる）
    await page.goto(`/b/${slug}`);
    const threadLink = page.locator(`a[href^="${threadPath}?"]`).first();
    await expect(threadLink).toBeVisible({ timeout: 20_000 });
    await threadLink.click();
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await startTour();
    await advanceToFormStep(tooltip);
    await expect(page.locator(".oc-form textarea")).toBeVisible({ timeout: 10_000 });
    await page.goBack();
    await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator(".oc-tour-spot")).toHaveCount(0);
  });

  test("T04: スタッフでない利用者には、ヘッダーから始めても管理操作を案内しない", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    await loginAsUser(context); // 板のスタッフではない
    await page.goto(`/b/${slug}/manage`);
    await expect(page.locator(".oc-main").first()).toContainText("権限が必要", { timeout: 20_000 });

    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();
    // ヘッダー（グローバル導線）から開始しても、管理操作の手順は出ない
    await page.getByRole("button", { name: "使い方", exact: true }).click();
    await expect(page).toHaveURL(/\/help\/?(#tour)?$/, { timeout: 15_000 });
    await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);
  });

  test("T06: 未対応の画面（/search）の初回「ツアー開始」は使える導線になる", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/search");
    await expect(page.locator("main")).toContainText("検索", { timeout: 20_000 });
    // 未対応画面ではヘッダーの「使い方」を出さない（実行できない操作を見せない）
    await expect(page.getByRole("button", { name: "使い方", exact: true })).toHaveCount(0);
    // 初回案内の「ツアー開始」は、開始できないまま案内を消費せず、実際に使えるヘルプへ送る
    const intro = page.locator(".oc-tour-intro");
    await expect(intro).toBeVisible({ timeout: 15_000 });
    await expect(intro.getByRole("link", { name: "ヘルプ" })).toHaveAttribute("href", "/help/");
    await intro.getByRole("button", { name: "ツアー開始" }).click();
    await expect(page).toHaveURL(/\/help\/?#tour$/, { timeout: 15_000 });
  });

  test("T07: 開始直後の逆 Tab も内部へ循環し、Esc で開始要素へ戻る", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/");
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();
    const launcher = page.getByRole("button", { name: "使い方", exact: true });
    await launcher.click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 10_000 });

    const activeInside = () =>
      page.evaluate(() => {
        const dialog = document.querySelector(".oc-tour-tooltip");
        return dialog ? dialog.contains(document.activeElement) : false;
      });
    const activeText = () => page.evaluate(() => (document.activeElement?.textContent ?? "").trim());

    // 開始直後はダイアログ自身にフォーカスがある。最初の逆 Tab で背景へ抜けない。
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("oc-tour-tooltip");
    await page.keyboard.press("Shift+Tab");
    expect(await activeInside(), "最初の Shift+Tab でダイアログ内に留まる").toBe(true);
    expect(await activeText()).toBe("終了");

    // 両方向の循環
    await page.keyboard.press("Tab");
    expect(await activeInside()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("ツアーを終了");
    await page.keyboard.press("Shift+Tab");
    expect(await activeInside()).toBe(true);
    expect(await activeText()).toBe("終了");
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      expect(await activeInside(), "Tab で背景へ抜けない").toBe(true);
    }

    // 矢印キーは手順移動として動く
    const progress = () => tooltip.locator(".oc-tour-progress").innerText();
    const before = await progress();
    await page.keyboard.press("ArrowRight");
    await expect.poll(progress).not.toBe(before);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(progress).toBe(before);

    // Esc で終了し、開始要素へフォーカスが戻る
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await expect(launcher).toBeFocused();
  });

  test("T08: 戻る／進むで画面が変わったらツアーを終了する", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/");
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();
    await page.getByRole("link", { name: "設定" }).first().click();
    await expect(page).toHaveURL(/\/settings$/, { timeout: 20_000 });

    await page.getByRole("button", { name: "使い方", exact: true }).click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 10_000 });

    await page.goBack();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(tooltip).toHaveCount(0, { timeout: 10_000 });
    // 古いラベル・スポットも残らない
    await expect(page.locator(".oc-tour-spot")).toHaveCount(0);
  });

  test("T10: 管理者向けツアーの最後のリンクは実在するアンカー（report ではない）", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    // 管理画面は所有者セッションが要る（テスト用 seed の固定セッション）
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
    await context.addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/admin");
    await expect(page.locator(".oc-main").first()).toContainText("管理", { timeout: 20_000 });
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();
    await page.getByRole("button", { name: "使い方ツアー" }).click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 15_000 });
    for (let index = 0; index < 30; index += 1) {
      const next = tooltip.getByRole("button", { name: "次へ" });
      if ((await next.count()) === 0) break;
      await next.click();
    }
    const href = await tooltip.getByRole("link", { name: "ヘルプで詳しく" }).getAttribute("href");
    expect(href).toMatch(/^\/help\/admin\/#(roles|board-staff|site-admin|owner|plugin-review|ai|security)$/);
    expect(href).not.toContain("#report");
  });
});
