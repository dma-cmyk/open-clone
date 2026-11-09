// core: 板作成 → スレ立て → レス → 安価ポップアップ。
// UI の見た目ではなく、操作フローと DOM の意味（役割・ラベル）を検証する。
// 実スタック（next dev + wrangler dev + D1）を WP7 の webServer が起動する前提。
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { API_BASE, ALLOWED_ORIGIN, readEnvelope } from "../helpers/api";

const OWNER_SESSION = "e2e-owner-session-token";

/** seed の固定セッション（e2e/fixtures/seed.sql）をブラウザに持たせる。 */
async function loginAsOwner(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await context.addCookies([
    { name: "oc_sess", value: OWNER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

/** クライアントルーティングなので、トップから目的の画面へリンクで入る（直リンクは dev で 500）。 */
async function openHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("おーぷんクローン");
}

async function createBoardViaUi(page: Page, slug: string, name: string): Promise<void> {
  await openHome(page);
  await page.getByRole("link", { name: /板を作る/ }).first().click();
  await expect(page.getByText("板を作る").first()).toBeVisible();

  await page.getByLabel(/板スラッグ/).fill(slug);
  await page.getByLabel(/^板名$/).fill(name);
  await page.getByLabel(/カテゴリ/).fill("E2E");
  await page.getByLabel(/板の説明/).fill("E2E 用の板です。");
  await page.getByLabel(/板ルール/).fill("1. E2E 用ルール");
  await page.getByLabel(/連投制限/).fill("0");

  const created = page.waitForResponse(
    (response) => response.url().includes("/api/v1/boards") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "板を作成する" }).click();
  const response = await created;
  const body = (await response.json()) as { ok?: boolean; data?: { board?: { slug?: string } } };
  expect(response.status(), JSON.stringify(body)).toBe(201);
  expect(body.ok).toBe(true);
  // 作成後は板ページへ遷移する（板名は h1。リンクではない）。
  await expect(page).toHaveURL(new RegExp(`/b/${slug}`), { timeout: 15_000 });
  // PC は h1（.oc-board-title）、SP は .oc-sp-maintitle に板名を出すため両方を対象にする。
  await expect(
    page
      .locator(".oc-board-title, .oc-sp-maintitle")
      .filter({ hasText: name })
      .filter({ visible: true })
      .first(),
  ).toBeVisible({ timeout: 15_000 });
}

/** スマホでは投稿欄が「✏ …」の1行バーに畳まれているので、必要なら展開する。 */
async function expandPostForm(page: Page): Promise<void> {
  const bar = page.locator(".oc-form-openbar").filter({ visible: true }).first();
  if ((await bar.count()) > 0) await bar.click();
}

async function createThreadViaUi(page: Page, title: string): Promise<void> {
  await expandPostForm(page);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: /スレを立てる/ }) }).first();
  await expect(form).toBeVisible({ timeout: 15_000 });
  await form.getByLabel(/スレタイ/).fill(title);
  await form.locator("textarea").first().fill("1げっと。安価 >>2 と >>3 を参照。");
  const created = page.waitForResponse(
    (response) => /\/api\/v1\/boards\/.+\/threads$/.test(response.url()) && response.request().method() === "POST",
  );
  await form.getByRole("button", { name: /スレを立てる/ }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  // 作成後はスレページへ遷移する（板一覧には戻らない）。
  await expect(page).toHaveURL(/\/b\/[^/]+\/t\/\d+/, { timeout: 15_000 });
  await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });
}

test.describe("core: 板作成から安価まで", () => {
  test("板を作成し、スレを立て、レスを投稿して安価ポップアップを開ける", async ({ page, context }) => {
    await loginAsOwner(context);
    const slug = `e2e${Date.now().toString(36)}`;
    const boardName = `E2E板${Date.now().toString(36).slice(-4)}`;
    const threadTitle = `E2Eスレ ${new Date().toISOString()}`;

    await createBoardViaUi(page, slug, boardName);
    await expect(page).toHaveURL(new RegExp(`/b/${slug}`));

    await createThreadViaUi(page, threadTitle);
    await expect(page).toHaveURL(new RegExp(`/b/${slug}/t/\\d+`));

    // UI: レス見出しは open2ch と同じく「時刻 ID:xxxx」の間に空白がある。
    // innerText は flex item の境界に改行を入れるため、textContent で空白そのものを見る。
    const headerText = await page
      .locator("#p1 .oc-post-header")
      .first()
      .evaluate((element) => element.textContent ?? "");
    expect(headerText).toMatch(/\d{2}:\d{2}:\d{2} ID:/);

    // 2 レス目を投稿
    const replyBody = `2げっと e2e-${Date.now()}`;
    await expandPostForm(page);
    const textarea = page.locator("form textarea").first();
    await textarea.fill(replyBody);
    const replied = page.waitForResponse(
      (response) => /\/api\/v1\/threads\/\d+\/posts$/.test(response.url()) && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /^投稿する$/ }).first().click();
    expect((await replied).status()).toBe(201);
    await expect(page.locator(".oc-post", { hasText: replyBody })).toBeVisible({ timeout: 15_000 });

    // 安価（>>2）ポップアップ
    await page.locator(".oc-anchor").first().click();
    const popup = page.getByRole("dialog", { name: "安価のプレビュー" });
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(">>2");
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });

  test("実況モードで新着レスが自動反映される", async ({ page, context, request }) => {
    await loginAsOwner(context);

    // API で板とスレを用意する（実況の検証に集中する）
    const slug = `e2elive${Date.now().toString(36)}`;
    const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` },
      data: { slug, name: `E2E実況板${slug.slice(-4)}`, category: "E2E", description: "" },
    });
    expect(boardResponse.status(), await boardResponse.text()).toBe(201);
    const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` },
      data: { title: `E2E実況スレ ${slug}`, body: "実況のテスト" },
    });
    expect(threadResponse.status(), await threadResponse.text()).toBe(201);
    const threadBody = await readEnvelope<{ threadId: number }>(threadResponse);
    if (!threadBody?.ok) throw new Error("スレ作成の応答が不正です");
    const threadId = threadBody.data.threadId;

    await openHome(page);
    await page.getByRole("link", { name: new RegExp(`E2E実況板${slug.slice(-4)}`) }).first().click();
    await page.getByRole("link", { name: new RegExp(`E2E実況スレ ${slug}`) }).first().click();
    await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /実況/ }).first().click();
    await expect(page.locator(".oc-live-on")).toBeVisible({ timeout: 20_000 });

    // 新着を API から投稿し、WS で自動反映されることを確認する
    const body = `ライブ更新 ${Date.now()}`;
    const posted = await request.post(`${API_BASE}/v1/threads/${threadId}/posts`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` },
      data: { name: "実況民", body },
    });
    expect(posted.status()).toBe(201);
    await expect(page.locator(".oc-post", { hasText: body })).toBeVisible({ timeout: 25_000 });
  });
});