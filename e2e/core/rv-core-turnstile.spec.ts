// rv-core A1/A3: 投稿フォームの Turnstile は 1 個だけ・トークンも 1 つ。
// 回帰対象: museAI #1 / #5、ChatGPT F-06（同じフォームにウィジェットが 2 個並び、
// 片方だけ成功すると「トークンが必要です」で送信できない。ウィジェットが縦 180px に崩れる）。
import { expect, test, type Page } from "@playwright/test";
import { unique } from "../helpers/ids";
import {
  controlledTurnstile,
  createBoard,
  createThread,
  expandPostForm,
  postForm,
  stubTurnstile,
  turnstileState,
} from "./rv-core-helpers";

async function widgetCount(page: Page): Promise<number> {
  return page.locator(".oc-form .oc-turnstile").count();
}

test.describe("rv-core A1: 投稿フォームの Turnstile は 1 個", () => {
  test("スレ画面: ウィジェットは 1 個で、1 回の成功で投稿できる", async ({ page, request }) => {
    await stubTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug, { title: `rvcore A1 ${unique("t")}` });

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1);
    // アップロード用の別ウィジェットが復活していないこと（旧 .oc-upload-turnstile）
    await expect(page.locator(".oc-upload-turnstile")).toHaveCount(0);

    const body = `A1 送信確認 ${Date.now()}`;
    await page.locator(".oc-form textarea").fill(body);
    const posted = page.waitForResponse(
      (response) =>
        new RegExp(`/api/v1/threads/${threadId}/posts$`).test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "投稿する" }).click();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(201);
    // 送信時のトークンはウィジェットが発行したもの（空トークンで 400 になっていない）
    const sent = response.request().postDataJSON() as { turnstileToken?: string } | null;
    expect(sent?.turnstileToken ?? "").toMatch(/^stub-token-/);
    await expect(page.locator(".oc-post", { hasText: body })).toBeVisible({ timeout: 20_000 });

    // 送信後（トークン消費 → リセット）もウィジェットは 1 個のまま
    await expect.poll(() => widgetCount(page)).toBe(1);
    await expect(page.locator(".oc-form .oc-turnstile .stub-turnstile")).toHaveCount(1);
  });

  test("投稿欄を閉じて開き直しても、遷移して戻っても 1 個のまま", async ({ page, request }) => {
    await stubTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    const collapse = page.locator(".oc-form-collapse").first();
    if (await collapse.isVisible()) {
      await collapse.click();
      await expandPostForm(page);
    }
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1);
    await expect(page.locator(".oc-form .oc-turnstile .stub-turnstile")).toHaveCount(1);

    // 板 → スレ（シェル内遷移）でフォームが作り直されても 2 個にならない
    await page.locator(".oc-thread-sub a:visible, .oc-sp-maintitle a:visible").first().click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}$`), { timeout: 20_000 });
    await expect(page.locator("form.oc-form").first()).toBeVisible({ timeout: 20_000 });
    // 板ページでも投稿欄が畳まれているので開いてから数える
    await expandPostForm(page);
    // 板ページのスレ立てフォームも 1 個
    await expect(page.locator("form.oc-form .oc-turnstile")).toHaveCount(1);
    await expect(page.locator("form.oc-form .oc-turnstile .stub-turnstile")).toHaveCount(1);
  });

  test("ウィジェットは compact（150×140 の縦長）ではなく 1 行サイズで描画する（A3）", async ({ page, request }) => {
    await stubTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect(page.locator(".oc-form .oc-turnstile .stub-turnstile")).toBeVisible();

    const state = await turnstileState(page);
    // 以前は compact を渡していた（縦 140px + 折り返しで 180px になっていた）
    expect(state.sizes).not.toContain("compact");
    expect(state.sizes.at(-1)).toBe("normal");

    // CSS で縮小・切り詰めしていない（scale(0.72) + height:48px の上書きをやめた）
    const transform = await page.locator(".oc-turnstile").first().evaluate((node) => getComputedStyle(node).transform);
    expect(transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
    const slot = await page.locator(".oc-turnstile-slot").first().boundingBox();
    expect(slot?.height ?? 0).toBeGreaterThanOrEqual(65);
  });

  test("360px 幅でもウィジェットは 1 行に収まる（縦 180px に崩れない・A3）", async ({ page, request }) => {
    await stubTurnstile(page);
    await page.setViewportSize({ width: 360, height: 740 });
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect(page.locator(".oc-form .oc-turnstile .stub-turnstile")).toBeVisible();

    const state = await turnstileState(page);
    expect(state.sizes).not.toContain("compact");
    const slot = page.locator(".oc-form .oc-turnstile-slot");
    const box = await slot.boundingBox();
    expect(box).not.toBeNull();
    // 1 行分の高さ（65px 前後）。折り返して 140〜180px にならない。
    expect(box?.height ?? 0).toBeLessThanOrEqual(80);
    // 親の幅からはみ出さない
    const form = await page.locator(".oc-form-inner").first().boundingBox();
    expect((box?.width ?? 0) <= (form?.width ?? 0) + 1).toBe(true);
  });

  test("ログイン済みで anonymous の板ならウィジェットは出ない", async ({ page, context, request }) => {
    await stubTurnstile(page);
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3111");
    await context.addCookies([
      { name: "oc_sess", value: "e2e-user-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0);
  });
});

test.describe("rv-core R1: トークンは 1 成功通知につき 1 回だけ使う", () => {
  test("待機中に受け取ったトークンは投稿だけに使い、添付は新しい成功を待つ", async ({ page, request }) => {
    const turnstile = await controlledTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous", uploader: "mock" });
    const threadId = await createThread(request, slug);
    const postedTokens: string[] = [];
    const preparedTokens: string[] = [];
    await page.route(/\/api\/v1\/threads\/\d+\/posts$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const data = route.request().postDataJSON() as { turnstileToken?: string } | null;
      postedTokens.push(data?.turnstileToken ?? "");
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "VALIDATION", message: "captured" }),
      });
    });
    await page.route(/\/api\/v1\/uploads\/prepare$/, async (route) => {
      // prepare はヘッダで送る（components/uploader/api.ts）。本体には無い。
      preparedTokens.push(route.request().headers()["x-turnstile-token"] ?? "");
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "VALIDATION", message: "captured" }),
      });
    });

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect.poll(() => turnstile.widgetIds()).toHaveLength(1);

    // 成功通知前に送信 → 待機する
    await postForm(page).locator("textarea").fill("待機後のトークン");
    await page.getByRole("button", { name: "投稿する" }).click();
    await expect(page.getByRole("button", { name: "送信中…" })).toBeVisible();
    await expect.poll(() => postedTokens.length).toBe(0);

    // 1 回目の成功通知で投稿だけが送られる
    await turnstile.issue("single-use-1");
    await expect.poll(() => postedTokens.length).toBe(1);
    expect(postedTokens[0]).toBe("single-use-1");

    // 添付は同じトークンを使わず、次の成功通知まで待つ
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    await page.locator('.oc-form input[type="file"]').setInputFiles({ name: "token.png", mimeType: "image/png", buffer: png });
    await page.waitForTimeout(500);
    expect(preparedTokens, "新しい成功通知前に prepare を送ってはいけない").toHaveLength(0);

    await turnstile.issue("single-use-2");
    await expect.poll(() => preparedTokens.length).toBe(1);
    expect(preparedTokens[0]).toBe("single-use-2");
    expect(preparedTokens[0]).not.toBe(postedTokens[0]);
    // ウィジェットは 1 個のまま
    await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(1);
  });

  test("投稿欄を閉じて開き直すと、閉じる前のトークンは使わない", async ({ page, request }) => {
    const turnstile = await controlledTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug);
    const postedTokens: string[] = [];
    await page.route(/\/api\/v1\/threads\/\d+\/posts$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const data = route.request().postDataJSON() as { turnstileToken?: string } | null;
      postedTokens.push(data?.turnstileToken ?? "");
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "VALIDATION", message: "captured" }),
      });
    });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect.poll(() => turnstile.widgetIds()).toHaveLength(1);

    // 閉じる前のウィジェットで成功させてから、閉じて開く
    await turnstile.issue("old-widget-token");
    await page.locator(".oc-form-collapse").click();
    await expandPostForm(page);
    await expect.poll(() => turnstile.widgetIds()).toHaveLength(1);

    await postForm(page).locator("textarea").fill("開き直した後");
    await page.getByRole("button", { name: "投稿する" }).click();
    await page.waitForTimeout(500);
    expect(postedTokens, "閉じる前のトークンで送信してはいけない").toHaveLength(0);

    await turnstile.issue("new-widget-token");
    await expect.poll(() => postedTokens.length).toBe(1);
    expect(postedTokens[0]).toBe("new-widget-token");
  });

  test("期限切れ後は新しい成功通知を待つ", async ({ page, request }) => {
    const turnstile = await controlledTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug);
    const postedTokens: string[] = [];
    await page.route(/\/api\/v1\/threads\/\d+\/posts$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const data = route.request().postDataJSON() as { turnstileToken?: string } | null;
      postedTokens.push(data?.turnstileToken ?? "");
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "VALIDATION", message: "captured" }),
      });
    });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect.poll(() => turnstile.widgetIds()).toHaveLength(1);

    await turnstile.issue("expired-token");
    await turnstile.expire();
    await postForm(page).locator("textarea").fill("期限切れの後");
    await page.getByRole("button", { name: "投稿する" }).click();
    await page.waitForTimeout(500);
    expect(postedTokens, "期限切れのトークンで送信してはいけない").toHaveLength(0);

    await turnstile.issue("fresh-token");
    await expect.poll(() => postedTokens.length).toBe(1);
    expect(postedTokens[0]).toBe("fresh-token");
  });
});
