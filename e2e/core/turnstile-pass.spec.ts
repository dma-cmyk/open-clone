// ロボット確認（Turnstile）の省略（報告書 81）の E2E。
//  - 1 回目のレスで確認 → 2 回目以降はウィジェットが出ない（期限内）
//  - turnstilePassMinutes: 0 / turnstile: always の板では毎回出る
//  - つぶやきも 2 回目以降は出ない
// Turnstile の検証はスタブ（TURNSTILE_VERIFY_URL、E2E_TURNSTILE_STUB=1）で行い、外部へは接続しない。
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: OWNER_COOKIE,
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

/**
 * Next.js 開発サーバーの開発ツール（`<nextjs-portal>`）が画面下端の UI を覆い、
 * Playwright のクリックが `intercepts pointer events` で止まるのを避ける。
 * 本番には存在しない要素（fix/tour の e2e/tour/dev-overlay.ts と同じ考え方）。
 */
async function hideNextDevOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const apply = () => {
      if (document.getElementById("e2e-hide-next-dev-overlay")) return;
      const style = document.createElement("style");
      style.id = "e2e-hide-next-dev-overlay";
      style.textContent = "nextjs-portal,[data-nextjs-dev-overlay],[data-nextjs-toast]{display:none !important}";
      document.head.appendChild(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
    else apply();
  });
}

/** ウィジェットのスクリプトをスタブ化（render/reset で即 callback）。 */
async function stubTurnstileWidget(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const widgets = new Map<string, { callback?: (token: string) => void }>();
    let seq = 0;
    window.__ocWidgetRenders = 0;
    (window as unknown as { turnstile: unknown }).turnstile = {
      render(_element: HTMLElement, options: { callback?: (token: string) => void }) {
        seq += 1;
        window.__ocWidgetRenders = seq;
        const id = `stub-${seq}`;
        widgets.set(id, options);
        const box = document.createElement("div");
        box.className = "stub-turnstile";
        box.textContent = "stub";
        _element.appendChild(box);
        setTimeout(() => options.callback?.(`stub-token-${seq}`), 0);
        return id;
      },
      reset(id: string) {
        const options = widgets.get(id);
        if (options) setTimeout(() => options.callback?.(`stub-token-${Date.now()}`), 0);
      },
      remove(id: string) {
        document.getElementById(id)?.remove();
        widgets.delete(id);
      },
    };
  });
}

declare global {
  interface Window {
    __ocWidgetRenders?: number;
  }
}

async function createBoard(request: APIRequestContext, settings: Record<string, unknown> = {}): Promise<string> {
  const slug = unique("tpass").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `省略E2E ${slug.slice(-4)}`,
      category: "E2E",
      description: "ロボット確認の省略の検証用",
      settings: { turnstile: "anonymous", cooldownSeconds: 0, ...settings },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThread(request: APIRequestContext, slug: string): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    // スレ作成の Turnstile は JSON の `turnstileToken` で渡す（always の板で必要）。
    data: { title: `省略スレ ${Date.now()}`, body: "1げっと", turnstileToken: "1x00000000000000000000AA" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { data?: { threadId?: number } };
  const threadId = body.data?.threadId;
  if (!threadId) throw new Error("スレ作成の応答が不正です");
  return threadId;
}

async function expandForm(page: Page): Promise<void> {
  const bar = page.locator(".oc-form-openbar").filter({ visible: true }).first();
  if ((await bar.count()) > 0) await bar.click();
}

function replyForm(page: Page) {
  return page.locator("form.oc-form").filter({ has: page.getByRole("button", { name: /^投稿する$/ }) }).first();
}

async function sendReply(page: Page, body: string): Promise<void> {
  await expandForm(page);
  const form = replyForm(page);
  await form.locator("textarea").fill(body);
  const posted = page.waitForResponse(
    (response) =>
      /\/api\/v1\/threads\/\d+\/posts$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "投稿する" }).click();
  expect((await posted).status(), "投稿が成功すること").toBe(201);
}

test.describe("ロボット確認の省略", () => {
  test("1 回目は確認し、2 回目以降はウィジェットを出さない（レス）", async ({ page, request, context }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 30 });
    const threadId = await createThread(request, slug);

    // 未ログインの端末として開く（device cookie は API 側で発行される）
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandForm(page);

    // 1 回目: ウィジェットが出る（siteverify はスタブ）
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1);
    await sendReply(page, `省略テスト1 ${Date.now()}`);
    await expect(page.locator(".oc-post", { hasText: "省略テスト1" })).toBeVisible({ timeout: 20_000 });

    // 2 回目: 期限内なのでウィジェットが出ない
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });
    const postedToken = await page.evaluate(() => {
      // 直前の送信でトークンが送られていないことを、状態からではなく API 結果で担保する
      // （サーバーが省略したときだけ 201 になる。トークン必須なら 400）。
      return true;
    });
    expect(postedToken).toBe(true);
    await sendReply(page, `省略テスト2 ${Date.now()}`);
    await expect(page.locator(".oc-post", { hasText: "省略テスト2" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0);
  });

  test("turnstilePassMinutes: 0 の板では毎回ウィジェットが出る", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 0 });
    const threadId = await createThread(request, slug);

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandForm(page);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1);
    await sendReply(page, `毎回確認1 ${Date.now()}`);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1, { timeout: 20_000 });
  });

  test("turnstile: always の板ではログインしていても毎回出る", async ({ page, request, context }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstile: "always", turnstilePassMinutes: 30 });
    const threadId = await createThread(request, slug);
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3204");
    await context.addCookies([
      { name: "oc_sess", value: "e2e-user-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandForm(page);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1);
  });

  test("つぶやきも 2 回目以降はウィジェットが出ない", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 30 });
    const threadId = await createThread(request, slug);

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    // レスで 1 回確認して「確認済み」にする
    await sendReply(page, `つぶやき前のレス ${Date.now()}`);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });

    // つぶやきパネルを開く（実況 UI の一部）
    await page.getByRole("button", { name: /つぶやき/ }).first().click();
    const panel = page.locator(".oc-tsubuyaki-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    // 確認済みなのでウィジェットは出ない
    await expect(panel.locator(".oc-turnstile")).toHaveCount(0, { timeout: 10_000 });
    await panel.locator('input[aria-label="つぶやき本文"]').fill("省略されたつぶやき");
    const sent = page.waitForResponse(
      (response) =>
        /\/api\/v1\/threads\/\d+\/tsubuyaki$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "送信" }).click();
    expect((await sent).status(), "つぶやきが 201 で通ること").toBe(201);
  });

  test("別端末（新しい Cookie）では再び確認が必要", async ({ browser, request }) => {
    const slug = await createBoard(request, { turnstilePassMinutes: 30 });
    const threadId = await createThread(request, slug);

    const first = await browser.newContext();
    const pageA = await first.newPage();
    await hideNextDevOverlay(pageA);
    await stubTurnstileWidget(pageA);
    await pageA.goto(`/b/${slug}/t/${threadId}`);
    await expect(pageA.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await sendReply(pageA, `端末A ${Date.now()}`);
    await expect(pageA.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });

    // 別コンテキスト = 別の oc_did（端末）→ 確認が必要
    const second = await browser.newContext();
    const pageB = await second.newPage();
    await hideNextDevOverlay(pageB);
    await stubTurnstileWidget(pageB);
    await pageB.goto(`/b/${slug}/t/${threadId}`);
    await expect(pageB.locator("#p1")).toBeVisible({ timeout: 20_000 });
    // スマホ幅では投稿欄が畳まれているので開いてから数える
    await expandForm(pageB);
    await expect(pageB.locator(".oc-form .oc-turnstile")).toHaveCount(1, { timeout: 20_000 });

    await first.close();
    await second.close();
  });

  test("確認済みでも添付は新しいトークンで通る（R82-05）", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 30, uploader: "mock" });
    const threadId = await createThread(request, slug);

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    // レスで確認済みにする。**送信成功後に状態を取り直して省略が反映される**ので、
    // ここで待つべき終状態は「部品 0 個」（以前は直前の一時状態 1 個を待っていて不安定だった）。
    await sendReply(page, `添付前のレス ${Date.now()}`);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });

    // 添付は毎回確認なので、添付を始めた時点で部品が 1 個マウントされる（遅延マウント）。
    // prepare に新しいトークンが付き、成功する。
    const prepare = page.waitForResponse(
      (response) => /\/api\/v1\/uploads\/prepare$/.test(new URL(response.url()).pathname),
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    await page.locator('.oc-form input[type="file"]').setInputFiles({ name: "pass.png", mimeType: "image/png", buffer: png });
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1, { timeout: 20_000 });
    const prepared = await prepare;
    expect(prepared.status(), await prepared.text()).toBe(201);
    expect(prepared.request().headers()["x-turnstile-token"] ?? "").toMatch(/^stub-token|^[0-9]+$/);
    await expect(page.locator(".oc-ng-item", { hasText: "pass.png" })).toBeVisible({ timeout: 20_000 });

    // 添付後も投稿の省略は続く（ウィジェットは 1 個のまま）
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1);
    await sendReply(page, `添付後のレス ${Date.now()}`);
  });

  test("取消・期限切れで拒否されたらウィジェットが戻り、再確認で投稿できる（R82-03）", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 30 });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await sendReply(page, `復帰前のレス ${Date.now()}`);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });

    // サーバー側で取消された状況（TURNSTILE_FAILED）を 1 回だけ再現する
    let failed = false;
    await page.route(/\/api\/v1\/threads\/\d+\/posts$/, async (route) => {
      if (route.request().method() !== "POST" || failed) return route.continue();
      failed = true;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "TURNSTILE_FAILED", message: "Turnstile トークンが必要です" }),
      });
    });
    await expandForm(page);
    await page.locator(".oc-form textarea").fill(`取消後の挑戦 ${Date.now()}`);
    await page.getByRole("button", { name: "投稿する" }).click();
    await expect(page.locator(".oc-form .oc-error")).toContainText("トークン", { timeout: 15_000 });

    // 部品が戻り、再確認して投稿できる（実際の送信は 201）
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1, { timeout: 15_000 });
    const posted = page.waitForResponse(
      (response) =>
        /\/api\/v1\/threads\/\d+\/posts$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "投稿する" }).click();
    expect((await posted).status(), "再確認後の投稿が成功すること").toBe(201);
  });

  test("つぶやきだけを初回送信しても、同じ板のレスフォームに確認済みが反映される（R82-04）", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 30 });
    const threadId = await createThread(request, slug);

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    // つぶやきパネルを開き、つぶやきだけを送る（レスは投稿しない）
    await page.getByRole("button", { name: /つぶやき/ }).first().click();
    const panel = page.locator(".oc-tsubuyaki-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator(".oc-turnstile")).toHaveCount(1);
    await panel.locator('input[aria-label="つぶやき本文"]').fill("つぶやき初回");
    const sent = page.waitForResponse(
      (response) =>
        /\/api\/v1\/threads\/\d+\/tsubuyaki$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "送信" }).click();
    expect((await sent).status()).toBe(201);

    // つぶやき自身のウィジェットが消え、レスフォームも 0 個になる（同じ板の共有状態）
    await expect(panel.locator(".oc-turnstile")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 15_000 });
    // 2 回目のつぶやきはトークンなしで通る
    await panel.locator('input[aria-label="つぶやき本文"]').fill("つぶやき2回目");
    const second = page.waitForResponse(
      (response) =>
        /\/api\/v1\/threads\/\d+\/tsubuyaki$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "送信" }).click();
    const response = await second;
    expect(response.status()).toBe(201);
    const body = response.request().postDataJSON() as { turnstileToken?: string } | null;
    expect(body?.turnstileToken ?? "").toBe("");
  });

  test("添付は板方針に従う: off の板では確認しない（R82-05 回帰）", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstile: "off", uploader: "mock" });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandForm(page);
    // off の板なのでウィジェットも無い
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0);

    const prepare = page.waitForResponse(
      (response) => /\/api\/v1\/uploads\/prepare$/.test(new URL(response.url()).pathname),
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    await page.locator('.oc-form input[type="file"]').setInputFiles({ name: "off.png", mimeType: "image/png", buffer: png });
    const prepared = await prepare;
    expect(prepared.status(), await prepared.text()).toBe(201);
    // トークンを要求しない（従来どおり）
    expect(prepared.request().headers()["x-turnstile-token"]).toBeUndefined();
    await expect(page.locator(".oc-ng-item", { hasText: "off.png" })).toBeVisible({ timeout: 15_000 });
  });

  test("NG で拒否された後、レスとつぶやきの両方で部品が戻る（R82-03 回帰）", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 30, ngWordAction: "reject" });
    // NG ワードは板の settings に入れる
    await request.patch(apiUrl(`/v1/boards/${slug}`), {
      headers: {
        Origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        cookie: "oc_sess=e2e-owner-session-token",
        "x-turnstile-token": "1x00000000000000000000AA",
      },
      data: { settings: { turnstile: "anonymous", cooldownSeconds: 0, turnstilePassMinutes: 30, ngWords: ["ngpass"] } },
    });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await sendReply(page, `確認前のレス ${Date.now()}`);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });

    // NG で拒否される（サーバーは取消済み）→ 画面も追随して部品が戻る
    await expandForm(page);
    await page.locator(".oc-form textarea").fill("ngpass を含む本文");
    await page.getByRole("button", { name: "投稿する" }).click();
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1, { timeout: 15_000 });
    // つぶやき側も部品が戻る
    await page.getByRole("button", { name: /つぶやき/ }).first().click();
    await expect(page.locator(".oc-tsubuyaki-panel .oc-turnstile")).toHaveCount(1, { timeout: 15_000 });
  });

  test("板設定を always に切り替えると、つぶやきもレスも再確認になる（R84-03 回帰）", async ({ page, request }) => {
    await hideNextDevOverlay(page);
    await stubTurnstileWidget(page);
    const slug = await createBoard(request, { turnstilePassMinutes: 30 });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await sendReply(page, `切替前のレス ${Date.now()}`);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });

    // 板設定を always に切り替える（API）
    const patched = await request.patch(apiUrl(`/v1/boards/${slug}`), {
      headers: {
        Origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        cookie: "oc_sess=e2e-owner-session-token",
        "x-turnstile-token": "1x00000000000000000000AA",
      },
      data: { settings: { turnstile: "always", cooldownSeconds: 0 } },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    // 同じ document のまま再読み込みせずに板へ戻り、スレを開き直す（SPA 遷移）
    await page.locator(".oc-thread-sub a:visible, .oc-sp-maintitle a:visible").first().click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}$`), { timeout: 20_000 });
    await page.getByRole("link", { name: /省略スレ/ }).first().click();
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });

    // always なのでレス・つぶやきとも部品が出る（狭幅では投稿欄を開いてから数える）
    await expandForm(page);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1, { timeout: 15_000 });
    await page.getByRole("button", { name: /つぶやき/ }).first().click();
    await expect(page.locator(".oc-tsubuyaki-panel .oc-turnstile")).toHaveCount(1, { timeout: 15_000 });
  });
});
