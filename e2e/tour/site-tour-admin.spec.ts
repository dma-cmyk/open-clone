// 管理者・所有者向けツアーの E2E。
//  - 管理画面（所有者）: タブを順に案内し、最後は /help/admin/#... へ
//  - 特別管理人が見えないタブ（所有者専用）は飛ばす
//  - 板の管理画面: 板設定・スタッフ・通報を案内し、/help/admin/#board-staff へ
// 所有者・特別管理人は **テスト用 D1 の seed**（e2e/fixtures/seed.sql）だけで作り、本番は使わない。
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
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

/** 所有者が板を作る（作成者は板の管理人になる）。 */
async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("touradm").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `ツアー管理板 ${slug.slice(-4)}`,
      category: "E2E",
      description: "管理者ツアーの検証用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function runTourToEnd(page: Page): Promise<string[]> {
  const tooltip = page.locator(".oc-tour-tooltip");
  await expect(tooltip).toBeVisible({ timeout: 15_000 });
  const titles: string[] = [];
  for (let guard = 0; guard < 40; guard += 1) {
    titles.push((await tooltip.locator(".oc-tour-tooltip-title").innerText()).trim());
    const next = tooltip.getByRole("button", { name: "次へ" });
    if ((await next.count()) === 0) break;
    await next.click();
    await expect(tooltip).toBeVisible();
  }
  return titles;
}


/** 板スタッフの権限検証用のセッション Cookie（e2e/fixtures/seed.sql の固定アカウント）。
 *  新規登録は 5 回/日/IP の上限を他 spec と取り合い CI で 429 になるため、登録しない。 */
function createAccountSession(
  _request: APIRequestContext,
  key: "deputy" | "moderator",
): Promise<{ cookie: string; name: string }> {
  return Promise.resolve({ cookie: `oc_sess=e2e-tour-${key}-session-token`, name: `trev-${key}` });
}

async function addSessionCookie(context: BrowserContext, cookie: string): Promise<void> {
  const value = cookie.slice("oc_sess=".length);
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
  await context.clearCookies();
  await context.addCookies([
    { name: "oc_sess", value, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

// 開発ツールを隠している分、本物の例外は Playwright 側で検出する（レビュー M01）。
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = collectPageErrors(page);
});
test.afterEach(() => {
  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});

test.describe("管理画面のツアー（所有者）", () => {
  test("所有者は全タブを順に案内され、最後は管理者向けヘルプへ", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    await page.goto("/admin");
    await expect(page.locator(".oc-main").first()).toContainText("管理", { timeout: 20_000 });
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();

    await page.locator('[data-tour="admin-help"]').click();
    const titles = await runTourToEnd(page);

    expect(titles).toContain("管理メニュー");
    expect(titles).toContain("ダッシュボード");
    expect(titles).toContain("ユーザーと規制");
    expect(titles).toContain("通報の処理");
    expect(titles).toContain("AI 管理");
    // 所有者だけに見えるタブも案内される
    expect(titles).toContain("特別管理人の招待（所有者のみ）");
    expect(titles).toContain("特別管理人（所有者のみ）");
    expect(titles).toContain("規制");
    expect(titles).toContain("監査ログ");
    expect(titles).toContain("使用量");
    expect(titles).toContain("AI 承認キュー");
    expect(titles).toContain("AI の緊急停止");
    expect(titles).toContain("プラグイン管理");
    expect(titles).toContain("全板一覧");
    expect(titles).toContain("管理者向けヘルプと再認証");

    const help = page.locator(".oc-tour-tooltip").getByRole("link", { name: "ヘルプで詳しく" });
    await expect(help).toHaveAttribute("href", "/help/admin/#security");
  });

  test("T09/T10: 可視メニューの全てに対応する手順があり、途中のヘルプも固定アンカー", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    await page.goto("/admin");
    await expect(page.locator(".oc-main").first()).toContainText("管理", { timeout: 20_000 });

    // 実 DOM の可視メニュー識別子（日本語見出しではなく data-tour）を集める。
    await expect(page.locator('nav[aria-label="管理メニュー"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('nav[aria-label="管理メニュー"] a[data-tour="admin-nav--plugins"]')).toBeVisible();
    const navIds = await page
      .locator('nav[aria-label="管理メニュー"] a')
      .evaluateAll((links) =>
        links
          .map((link) => link.getAttribute("data-tour") ?? "")
          .filter((id) => id.length > 0),
      );
    expect(navIds).toContain("admin-nav--plugins");
    expect(navIds).toContain("admin-nav--b");

    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();
    await page.locator('[data-tour="admin-help"]').click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 15_000 });

    // 管理者向けヘルプの固定アンカー（設計 50）。#report は管理者側には存在しない。
    const anchors = new Set(["roles", "board-staff", "site-admin", "owner", "plugin-review", "ai", "security"]);
    const targets = new Set<string>();
    for (let guard = 0; guard < 40; guard += 1) {
      const selector = await tooltip.getAttribute("data-tour-target");
      if (selector) targets.add(selector);
      const helpHref = await tooltip.getByRole("link", { name: "もっと詳しく（ヘルプ）" }).getAttribute("href");
      expect(helpHref, "途中のヘルプリンク").toMatch(/^\/help\/admin\/#/);
      expect(anchors.has(helpHref!.split("#")[1] ?? ""), `不正なアンカー: ${helpHref}`).toBe(true);
      const next = tooltip.getByRole("button", { name: "次へ" });
      if ((await next.count()) === 0) break;
      await next.click();
      await expect(tooltip).toBeVisible();
    }
    const finalHref = await tooltip.getByRole("link", { name: "ヘルプで詳しく" }).getAttribute("href");
    expect(anchors.has(finalHref!.split("#")[1] ?? ""), `不正なアンカー: ${finalHref}`).toBe(true);

    // 可視メニューを指す手順が存在する（全メニュー。所有者専用も含む）。
    for (const id of navIds) {
      expect(targets, `メニュー ${id} を指す手順がありません`).toContain(`[data-tour="${id}"]`);
    }
  });

  test("管理画面に「管理者向けヘルプ」「二段階認証・再認証」の導線がある", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    await page.goto("/admin");
    await expect(page.locator(".oc-main").first()).toContainText("管理", { timeout: 20_000 });
    await expect(page.locator('.oc-main a[href="/help/admin/#site-admin"]')).toHaveCount(1);
    await expect(page.locator('.oc-main a[href="/help/admin/#security"]')).toHaveCount(1);
    // 各タブへの data-tour 目印（ツアーの飛ばし判定に使う）
    await expect(page.locator('[data-tour="admin-nav-users"]')).toHaveCount(1);
    await expect(page.locator('[data-tour="admin-nav-invites"]')).toHaveCount(1);
  });

  test("特別管理人の画面では所有者専用タブの手順を飛ばす", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    // サーバー側の認可は別 spec が担保する。ここでは画面の出し分け（所有者専用タブが
    // 描画されないこと）に対して、ツアーがその手順を飛ばすことを見る。
    await loginAsOwner(context);
    await page.route("**/api/v1/auth/session", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        ok: boolean;
        data: { authenticated: boolean; account?: { role: string } };
      };
      if (body?.data?.account) body.data.account.role = "special_admin";
      await route.fulfill({ response, json: body });
    });
    await page.goto("/admin");
    await expect(page.locator(".oc-main").first()).toContainText("特別管理人ダッシュボード", { timeout: 20_000 });
    // 所有者専用タブは描画されない
    await expect(page.locator('[data-tour="admin-nav-invites"]')).toHaveCount(0);

    await page.locator('[data-tour="admin-help"]').click();
    const titles = await runTourToEnd(page);
    expect(titles).toContain("管理メニュー");
    expect(titles).not.toContain("特別管理人の招待（所有者のみ）");
    expect(titles).not.toContain("特別管理人（所有者のみ）");
  });

  test("権限の無いユーザーは管理画面に入れず、ツアーも出ない", async ({ page, context }) => {
    await hideNextDevOverlay(page);
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
    await context.addCookies([
      { name: "oc_sess", value: "e2e-user-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/admin");
    await expect(page.locator(".oc-main").first()).toContainText("管理者専用", { timeout: 20_000 });
    // 管理画面のツアー導線（使い方ツアー・各タブの目印）は出ない
    await expect(page.locator('[data-tour="admin-help"]')).toHaveCount(0);
    await expect(page.locator('[data-tour="admin-nav"]')).toHaveCount(0);
    await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);
  });
});

test.describe("板の管理画面のツアー（板の管理人）", () => {
  test("板設定・スタッフ・通報を案内し、最後は板の管理ヘルプへ", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context); // 板を作成した所有者 = 板の管理人
    const slug = await createBoard(request);
    await page.goto(`/b/${slug}/manage`);
    await expect(page.locator(".oc-main").first()).toContainText("の板管理", { timeout: 20_000 });
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();

    await page.locator('[data-tour="manage-help"]').click();
    const titles = await runTourToEnd(page);

    expect(titles).toEqual(["板の管理メニュー", "設定の中身", "スタッフ", "通報", "管理者向けヘルプ"]);
    const help = page.locator(".oc-tour-tooltip").getByRole("link", { name: "ヘルプで詳しく" });
    await expect(help).toHaveAttribute("href", "/help/admin/#board-staff");
  });

  test("板の管理画面に 使い方・管理ヘルプ・通報対応 の導線がある", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    await page.goto(`/b/${slug}/manage`);
    await expect(page.locator(".oc-main").first()).toContainText("の板管理", { timeout: 20_000 });
    await expect(page.locator('.oc-main a[href="/help/admin/#board-staff"]')).toHaveCount(2);
    // 管理者向けの固定アンカーに無い #report は使わない（T10）
    await expect(page.locator('.oc-main a[href="/help/admin/#report"]')).toHaveCount(0);
    await expect(page.locator('[data-tour="manage-tabs"]')).toHaveCount(1);
    await expect(page.locator('[data-tour="manage-tab-staff"]')).toHaveCount(1);
  });

  test("T04/T05: 副管理人・モデレーターには保存を案内せず、API の拒否も維持する", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    const thread = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
      headers: ownerHeaders(),
      data: { title: `権限検証 ${Date.now()}`, body: "権限検証の本文" },
    });
    expect(thread.status(), await thread.text()).toBe(201);
    // テスト用 API の既知の応答形（E2E の作成レスポンス）。
    const threadBody = (await thread.json()) as { data: { post: { id: number } } };
    const postId = threadBody.data.post.id;

    for (const level of ["deputy", "moderator"] as const) {
      const account = await createAccountSession(request, level);
      const setStaff = await request.post(apiUrl(`/v1/boards/${slug}/staff`), {
        headers: ownerHeaders(),
        data: { accountName: account.name, level },
      });
      expect(setStaff.status(), await setStaff.text()).toBe(200);

      await addSessionCookie(context, account.cookie);
      await page.goto(`/b/${slug}/manage`);
      await expect(page.locator(".oc-main").first()).toContainText("の板管理", { timeout: 20_000 });
      await expect(page.locator('[data-tour="manage-tabs"]')).toBeVisible({ timeout: 20_000 });
      // ヘッダーの表示名（セッション取得完了）を待ってから開始する
      await expect(page.locator('.oc-header [data-tour="site-account"]')).toContainText(account.name, {
        timeout: 20_000,
      });
      const intro = page.locator(".oc-tour-intro");
      if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();

      // ヘッダーの「使い方」から開始しても、保存を促す「設定の中身」は出ない
      await page.getByRole("button", { name: "使い方", exact: true }).click();
      const tooltip = page.locator(".oc-tour-tooltip");
      await expect(tooltip).toBeVisible({ timeout: 15_000 });
      const titles: string[] = [];
      const bodies: string[] = [];
      for (let guard = 0; guard < 20; guard += 1) {
        titles.push((await tooltip.locator(".oc-tour-tooltip-title").innerText()).trim());
        bodies.push((await tooltip.locator(".oc-tour-tooltip-text").innerText()).trim());
        const next = tooltip.getByRole("button", { name: "次へ" });
        if ((await next.count()) === 0) break;
        await next.click();
        await expect(tooltip).toBeVisible();
      }
      expect(titles, `${level} に保存を案内しない`).not.toContain("設定の中身");
      expect(titles, `${level} は通報対応を案内する`).toContain("通報");
      const joined = bodies.join("\n");
      expect(joined).not.toContain("保存すると板に反映");
      expect(joined).toContain("削除は副管理人以上");
      expect(joined, "板管理に無い「規制」画面へ案内しない").not.toContain("「規制」画面");
      await tooltip.getByRole("button", { name: "終了", exact: true }).click();
      await expect(tooltip).toHaveCount(0);

      // フッターの導線からでも同じ手順（最初の手順は板の管理メニュー）
      await page.locator(".oc-footer-tour").click();
      await expect(tooltip).toBeVisible({ timeout: 10_000 });
      expect((await tooltip.locator(".oc-tour-tooltip-title").innerText()).trim()).toBe("板の管理メニュー");
      await tooltip.getByRole("button", { name: "終了", exact: true }).click();
      await expect(tooltip).toHaveCount(0);

      // 初回案内の「ツアー開始」からでも同じ手順
      await page.evaluate(() => localStorage.removeItem("oc.tour.intro.v1"));
      await page.reload();
      await expect(page.locator('[data-tour="manage-tabs"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.oc-header [data-tour="site-account"]')).toContainText(account.name, {
        timeout: 20_000,
      });
      const introAgain = page.locator(".oc-tour-intro");
      await expect(introAgain).toBeVisible({ timeout: 15_000 });
      await introAgain.getByRole("button", { name: "ツアー開始" }).click();
      await expect(tooltip).toBeVisible({ timeout: 10_000 });
      expect((await tooltip.locator(".oc-tour-tooltip-title").innerText()).trim()).toBe("板の管理メニュー");
      await tooltip.getByRole("button", { name: "終了", exact: true }).click();
      await expect(tooltip).toHaveCount(0);

      // 案内を合わせても API の権限は緩めていない
      const patch = await request.patch(apiUrl(`/v1/boards/${slug}`), {
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", cookie: account.cookie },
        data: { name: `変更 ${level}` },
      });
      expect(patch.status(), `${level} の板設定変更`).toBe(403);
    }

    // モデレーターのレス削除は 403（非表示は可）。API は変更していない。
    const moderator = await createAccountSession(request, "moderator");
    const setModerator = await request.post(apiUrl(`/v1/boards/${slug}/staff`), {
      headers: ownerHeaders(),
      data: { accountName: moderator.name, level: "moderator" },
    });
    expect(setModerator.status(), await setModerator.text()).toBe(200);
    const deleted = await request.delete(apiUrl(`/v1/posts/${postId}`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: moderator.cookie },
    });
    expect(deleted.status(), "モデレーターは削除できない").toBe(403);
  });

  test("T10: 板管理ツアーの途中と最後のヘルプリンクが固定アンカー", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    await page.goto(`/b/${slug}/manage`);
    await expect(page.locator(".oc-main").first()).toContainText("の板管理", { timeout: 20_000 });
    const intro = page.locator(".oc-tour-intro");
    if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click();

    await page.locator('[data-tour="manage-help"]').click();
    const tooltip = page.locator(".oc-tour-tooltip");
    await expect(tooltip).toBeVisible({ timeout: 15_000 });
    const anchors = new Set(["roles", "board-staff", "site-admin", "owner", "plugin-review", "ai", "security"]);
    const hrefs: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const href = await tooltip.getByRole("link", { name: "もっと詳しく（ヘルプ）" }).getAttribute("href");
      hrefs.push(href ?? "");
      const next = tooltip.getByRole("button", { name: "次へ" });
      if ((await next.count()) === 0) break;
      await next.click();
      await expect(tooltip).toBeVisible();
    }
    const finalHref = await tooltip.getByRole("link", { name: "ヘルプで詳しく" }).getAttribute("href");
    hrefs.push(finalHref ?? "");
    for (const href of hrefs) {
      expect(href, "板管理ツアーのヘルプリンク").toMatch(/^\/help\/admin\/#/);
      expect(anchors.has(href.split("#")[1] ?? ""), `不正なアンカー: ${href}`).toBe(true);
    }
    await expect(page.locator('.oc-main a[href="/help/admin/#report"]')).toHaveCount(0);
    await expect(page.locator('.oc-main a[href="/help/admin/#board-staff"]')).toHaveCount(2);
  });

  test("スタッフでない利用者には板管理のツアー導線を出さない", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    const slug = await createBoard(request);
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
    await context.addCookies([
      { name: "oc_sess", value: "e2e-user-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto(`/b/${slug}/manage`);
    await expect(page.locator(".oc-main").first()).toContainText("権限が必要", { timeout: 20_000 });
    // 管理画面のツアー導線（使い方ツアー・各タブの目印）は出ない
    await expect(page.locator('[data-tour="admin-help"]')).toHaveCount(0);
    await expect(page.locator('[data-tour="admin-nav"]')).toHaveCount(0);
    await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);
  });

  // K3: 権限の読み込み前に「使い方」を押すと、startTour() が権限不足と同じ false を返し、
  // ヘッダー／フッターの分岐でヘルプへ飛んでいた。読み込み完了後に押した操作で開始する。
  test("K3: 権限の読み込み中に「使い方」を押してもヘルプへ飛ばず、読み込み後にツアーが始まる", async ({
    page,
    context,
    request,
  }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context); // 板を作成した所有者 = 板の管理人
    const slug = await createBoard(request);
    // 権限（セッション）の取得を遅らせ、読み込み中に押した状態を作る。
    await page.route("**/api/v1/auth/session", async (route) => {
      await delay(3000);
      await route.continue();
    });
    // 初回案内は出さない（読み込み中のクリックだけを見る）。
    await page.addInitScript(() => window.localStorage.setItem("oc.tour.intro.v1", "1"));

    await page.goto(`/b/${slug}/manage`);
    // 板情報・セッションの応答を待たずに、フッターの「使い方ツアー」を押す。
    await page.locator(".oc-footer-tour").click();

    // 押した直後にヘルプへ移動しない（以前はここで /help/#tour へ飛んでいた）。
    await expect(page.locator(".oc-tour-tooltip")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-tour-tooltip-title").first()).toHaveText("板の管理メニュー");
    expect(new URL(page.url()).pathname, "押した画面に留まる").toBe(`/b/${slug}/manage`);
  });
});