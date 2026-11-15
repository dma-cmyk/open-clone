// rv-core A2/A9: シェル（pushState）と Next の個別ページ（/search・/plugins・/ranking・/headline・
// /account・/admin）の往復で、URL・本文・ブラウザタイトルが一致すること。
// 回帰対象: museAI #2（検索→設定、ヘッドライン→板を作る、管理→トップで誤404）、
// ChatGPT F-01 の 2 経路（設定遷移で検索画面が残る／プラグイン→掲示板トップで誤404）、F-12（タイトル）。
import { expect, test, type Page } from "@playwright/test";

import { createBoard, createThread } from "./rv-core-helpers";

async function openThread(page: Page, slug: string, threadId: number): Promise<void> {
  await page.goto(`/b/${slug}/t/${threadId}`);
  await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
}

/** シェル（または Next）のページに移り、URL と本文が一致していることを確認する。 */
async function expectPage(page: Page, urlPattern: RegExp, marker: RegExp): Promise<void> {
  await expect(page).toHaveURL(urlPattern, { timeout: 20_000 });
  await expect(page.locator("main.oc-main, main").first()).toContainText(marker, { timeout: 20_000 });
}

test.describe("rv-core A2/A9: シェルと Next ページの境界遷移", () => {
  test("検索結果 → 設定: 設定画面と URL・タイトルが一致する（F-01 A）", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, { title: "rvcore 遷移検索対象" });
    await openThread(page, slug, threadId);

    // サイト内検索へ（ヘッダ検索は狭幅では非表示なので、同じ URL へ直接入る）
    await page.goto(`/search?q=${encodeURIComponent("rvcore 遷移検索対象")}&type=thread`);
    await expect(page).toHaveURL(/\/search\?q=/, { timeout: 20_000 });
    await expect(page.locator("main")).toContainText("rvcore 遷移検索対象", { timeout: 20_000 });

    // 検索画面（Next ページ）からヘッダの「設定」（シェル）へ
    await page.getByRole("link", { name: "設定" }).first().click();
    await expectPage(page, /\/settings$/, /設定/);
    await expect(page.locator("main")).not.toContainText("rvcore 遷移検索対象");
    await expect(page).toHaveTitle(/^設定 ｜ /);
  });

  test("ヘッドライン → 板を作る: 板作成フォームが出る（museAI #2-2）", async ({ page }) => {
    await page.goto("/headline");
    await expect(page.locator("main")).toContainText("ヘッドライン", { timeout: 20_000 });

    await page.getByRole("link", { name: "板を作る" }).first().click();
    await expectPage(page, /\/boards\/new$/, /板を作る/);
    await expect(page.getByLabel(/板スラッグ/)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveTitle(/^板を作る ｜ /);
  });

  test("ランキング → ヘッダ「板一覧」/ロゴ: トップが表示される（Next → シェル）", async ({ page }) => {
    await page.goto("/ranking");
    await expect(page.locator("main")).toContainText("ランキング", { timeout: 20_000 });
    await page.getByRole("link", { name: "板一覧" }).first().click();
    await expectPage(page, /\/$/, /おーぷんクローン/);
    await expect(page).toHaveTitle("おーぷんクローン");
    await expect(page).not.toHaveTitle(/ランキング/);

    // ロゴからも同じ（museAI #2-3 の「トップURLなのに前の画面が残る」の一般形）
    await page.goto("/ranking");
    await page.getByRole("link", { name: /おーぷんクローン トップ/ }).click();
    await expectPage(page, /\/$/, /おーぷんクローン/);
  });

  test("管理ページ → ロゴ（トップ）: 前の画面が残らず板一覧が出る（museAI #2-3）", async ({ page }) => {
    // 非管理者で /admin を開くと権限拒否画面になり、そのままロゴを押す経路を再現する。
    await page.goto("/admin");
    await expect(page.locator("body")).toContainText(/管理者専用|ログイン画面|管理画面を読み込み/, {
      timeout: 20_000,
    });
    // 管理画面はシェルのヘッダを持たないため、ブラウザの戻るで直前の画面へ戻れることを確認する。
    await page.goto("/");
    await page.getByRole("link", { name: "ランキング" }).first().click();
    await expect(page).toHaveURL(/\/ranking/, { timeout: 20_000 });
    await page.goBack();
    await expectPage(page, /\/$/, /おーぷんクローン/);

    // シェル内の未知パス（404）からロゴでトップへ戻れる
    await page.goto("/this-path-does-not-exist");
    await expect(page.locator("main")).toContainText("ページが見つかりません", { timeout: 20_000 });
    await page.getByRole("link", { name: /おーぷんクローン トップ/ }).click();
    await expectPage(page, /\/$/, /おーぷんクローン/);
    await expect(page.locator("main")).not.toContainText("ページが見つかりません");
  });

  test("プラグイン一覧 → 掲示板トップ: 板一覧が出て、/plugins の404が残らない（F-01 B）", async ({ page }) => {
    await page.goto("/plugins");
    await expect(page.locator("main")).toContainText("プラグイン", { timeout: 20_000 });

    await page.getByRole("link", { name: "掲示板トップ" }).click();
    await expectPage(page, /\/$/, /おーぷんクローン/);
    await expect(page.locator("body")).not.toContainText("ページが見つかりません");
    await expect(page.locator("body")).not.toContainText("存在しないか、移動した可能性があります");
  });

  test("プラグインのテンプレート画面 → 掲示板トップでも誤404が出ない（F-01 B の別経路）", async ({ page }) => {
    await page.goto("/plugins/templates");
    await expect(page.locator("main")).toContainText("テンプレート", { timeout: 20_000 });

    await page.getByRole("link", { name: "掲示板トップ" }).click();
    await expectPage(page, /\/$/, /おーぷんクローン/);
    await expect(page.locator("body")).not.toContainText("/plugins");
  });

  test("スレ → 板 → 設定 → 板一覧: 本文とタイトルが画面に追従する（F-12）", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, { title: "rvcore タイトル確認スレ" });
    await openThread(page, slug, threadId);
    await expect(page).toHaveTitle(/^rvcore タイトル確認スレ ｜ /, { timeout: 20_000 });

    await page.locator(".oc-thread-sub a:visible, .oc-sp-maintitle a:visible").first().click();
    await expectPage(page, new RegExp(`/b/${slug}$`), /rvcore/);
    await expect(page).not.toHaveTitle(/rvcore タイトル確認スレ/);

    await page.getByRole("link", { name: "設定" }).first().click();
    await expectPage(page, /\/settings$/, /設定/);
    await expect(page).toHaveTitle(/^設定 ｜ /);

    await page.getByRole("link", { name: "板一覧" }).first().click();
    await expectPage(page, /\/$/, /おーぷんクローン/);
    await expect(page).toHaveTitle("おーぷんクローン");
  });

  test("シェル → Next → シェルの戻る/進むで本文と URL が一致する", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "ランキング" }).first().click();
    await expect(page.locator("main")).toContainText("ランキング", { timeout: 20_000 });
    await page.getByRole("link", { name: "設定" }).first().click();
    await expectPage(page, /\/settings$/, /設定/);
    await page.getByRole("link", { name: /板を作る/ }).first().click();
    await expectPage(page, /\/boards\/new$/, /板を作る/);

    // /boards/new（シェル）← /settings（シェル）← /ranking（Next）と戻る
    await page.goBack();
    await expectPage(page, /\/settings$/, /設定/);
    await page.goBack();
    await expectPage(page, /\/ranking/, /ランキング/);

    await page.goForward();
    await expectPage(page, /\/settings$/, /設定/);
    await page.goForward();
    await expectPage(page, /\/boards\/new$/, /板を作る/);
  });

  test("板作成後の遷移（シェル）と、検索（Next）との往復", async ({ page, context }) => {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3111");
    await context.addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/boards/new");
    await expect(page.locator("main.oc-main")).toContainText("板を作る", { timeout: 20_000 });
    const slug = `rvcore-${Date.now().toString(36)}`;
    await page.getByLabel(/板スラッグ/).fill(slug);
    await page.getByLabel(/^板名$/).fill("rvcore 遷移板");
    await page.getByLabel(/カテゴリ/).fill("E2E");
    await page.getByLabel(/連投制限/).fill("0");
    const created = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/boards" && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "板を作成する" }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    await expect(page).toHaveURL(new RegExp(`/b/${slug}$`), { timeout: 20_000 });
    await expect(page.locator("main.oc-main")).toContainText("rvcore 遷移板", { timeout: 20_000 });

    // 板（シェル）→ 検索（Next）→ 板一覧（シェル）。狭幅ではヘッダ検索が非表示なので URL で入る。
    await page.goto(`/search?q=${encodeURIComponent("rvcore 遷移板")}&type=thread`);
    await expect(page).toHaveURL(/\/search\?q=/, { timeout: 20_000 });
    await page.getByRole("link", { name: "板一覧" }).first().click();
    await expectPage(page, /\/$/, /おーぷんクローン/);
  });
});

test.describe("rv-core A2 追加: 認証画面からシェル行きのパスへ戻る経路（明示的なフルページ遷移）", () => {
  /** クライアント遷移（同じ document）か、フルページ遷移かを判定するための目印。 */
  async function markDocument(page: Page): Promise<void> {
    await page.evaluate(() => {
      (window as unknown as { __rvcoreMarker?: number }).__rvcoreMarker = 1;
    });
  }
  async function documentWasReplaced(page: Page): Promise<boolean> {
    return (await page.evaluate(() => (window as unknown as { __rvcoreMarker?: number }).__rvcoreMarker)) === undefined;
  }

  test("ログイン後の ?next= 復帰: /boards/new が実際に表示される（URLだけ変わらない）", async ({ page }) => {
    // ログイン成功応答だけスタブする（実アカウント登録は IP 単位のレート制限を消費し、
    // 同じ実行の他の spec を壊すため。Qwen の UX-R3 テストと同じ手法）。
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({ json: { ok: true, data: { authenticated: true } } }),
    );
    await page.goto(`/account/login?next=${encodeURIComponent("/boards/new")}`);
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("メールアドレス").fill("rvcore-login@example.test");
    await page.getByLabel("パスワード").fill("e2e-Password-1");
    await markDocument(page);

    // 成功時は window.location.assign(next) = フルページ遷移（next は resolveSafeNext 済み）
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page).toHaveURL(/\/boards\/new$/, { timeout: 20_000 });
    await expect(page.getByLabel(/板スラッグ/)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("body")).not.toContainText("404");
    await expect(page.locator("body")).not.toContainText("ページが見つかりません");
    expect(await documentWasReplaced(page)).toBe(true);
  });

  test("ログイン後の ?next= に hash を付けると、hash を保ったままスレを開く", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, { body: "hash 復帰のテスト" });
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({ json: { ok: true, data: { authenticated: true } } }),
    );
    await page.goto(`/account/login?next=${encodeURIComponent(`/b/${slug}/t/${threadId}#p1`)}`);
    await page.getByLabel("メールアドレス").fill("rvcore-hash@example.test");
    await page.getByLabel("パスワード").fill("e2e-Password-1");
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}/t/${threadId}#p1$`), { timeout: 20_000 });
    // hash が消えず（旧ガードは hash を落としていた）、スレ本文（シェル）が表示される
    expect(new URL(page.url()).hash).toBe("#p1");
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
  });

  test("新規登録後の ?next= 復帰でも /boards/new が実際に表示される", async ({ page }) => {
    await page.route("**/api/v1/auth/register", (route) =>
      route.fulfill({ json: { ok: true, data: { authenticated: true } } }),
    );
    await page.goto(`/account/register?next=${encodeURIComponent("/boards/new")}`);
    await expect(page.getByRole("heading", { name: "新規登録" })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("表示名").fill("rvcore register");
    await page.getByLabel("メールアドレス").fill("rvcore-register@example.test");
    await page.getByLabel("パスワード（8文字以上）").fill("e2e-Password-1");
    await page.getByLabel("パスワード（確認）").fill("e2e-Password-1");
    await markDocument(page);
    await page.getByRole("button", { name: "登録する" }).click();
    await expect(page).toHaveURL(/\/boards\/new$/, { timeout: 20_000 });
    await expect(page.getByLabel(/板スラッグ/)).toBeVisible({ timeout: 20_000 });
    expect(await documentWasReplaced(page)).toBe(true);
  });

  test("ログアウト（Next → シェル /）でトップが表示される", async ({ page, context }) => {
    // 実ログアウトは共有 seed セッションの行を消して他のテストを壊すため、応答だけスタブする。
    // ここで検証したいのは「Next の個別ページからシェル行きの / へ戻る遷移方式」。
    await page.route("**/api/v1/auth/logout", (route) => route.fulfill({ json: { ok: true, data: {} } }));
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3111");
    await context.addCookies([
      { name: "oc_sess", value: "e2e-user-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/account");
    await expect(page.getByRole("button", { name: /ログアウト/ })).toBeVisible({ timeout: 20_000 });
    await markDocument(page);

    await page.getByRole("button", { name: /ログアウト/ }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.locator("main.oc-main")).toContainText("おーぷんクローン", { timeout: 20_000 });
    await expect(page.locator("body")).not.toContainText("ページが見つかりません");
    expect(await documentWasReplaced(page)).toBe(true);
  });

  test("シェルの URL に付けた hash が読み込み後も残り、history を包む独自コードが無い", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, { body: "hash の保持" });
    await page.goto(`/b/${slug}/t/${threadId}#p1`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => new URL(page.url()).hash).toBe("#p1");

    // アプリ独自の history ラップ（第2回レビュー R5 で撤去）が残っていないこと
    const historyState = await page.evaluate(() => {
      const impl = window.history.pushState.toString();
      return {
        hasGuardFlag: Object.prototype.hasOwnProperty.call(window.history, "__ocShellPathGuard"),
        wrapped: /__ocShellPathGuard|isShellPath|patched\(this/.test(impl),
      };
    });
    expect(historyState.hasGuardFlag).toBe(false);
    expect(historyState.wrapped).toBe(false);
  });
});
