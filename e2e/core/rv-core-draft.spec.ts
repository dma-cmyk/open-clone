// rv-core A4/A10: 下書きの保存と本文の文字数・上限表示。
// 回帰対象: ChatGPT F-05（空にした下書きが再読み込みで復活する）、museAI #10（カウンタ・上限なし）。
import { expect, test } from "@playwright/test";
import { createBoard, createThread, expandPostForm, postForm } from "./rv-core-helpers";

test.describe("rv-core A4: 下書き", () => {
  test("空にした下書きは再読み込みで復活しない", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    const form = postForm(page);
    const textarea = form.locator("textarea");
    await textarea.fill("下書きの保持確認。投稿しません。");
    // 自動保存（600ms デバウンス）
    await expect(page.locator(".oc-draft-note")).toBeVisible({ timeout: 10_000 });

    // 空にして保存させる
    await textarea.fill("");
    await expect(page.locator(".oc-draft-note")).toHaveCount(0, { timeout: 10_000 });

    await page.reload();
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect(postForm(page).locator("textarea")).toHaveValue("");
    await expect(page.locator(".oc-draft-note")).toHaveCount(0);
  });

  test("送信が成功したら下書きは消える（再読み込みで戻らない）", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    const form = postForm(page);
    const body = `下書き消去の確認 ${Date.now()}`;
    await form.locator("textarea").fill(body);
    await expect(page.locator(".oc-draft-note")).toBeVisible({ timeout: 10_000 });
    const posted = page.waitForResponse(
      (response) =>
        new RegExp(`/api/v1/threads/${threadId}/posts$`).test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "投稿する" }).click();
    expect((await posted).status()).toBe(201);
    await expect(form.locator("textarea")).toHaveValue("");

    await page.reload();
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await expect(postForm(page).locator("textarea")).toHaveValue("");
  });
});

test.describe("rv-core A10: 文字数カウンタと上限", () => {
  test("本文の文字数・バイト数と上限（4096 バイト）を表示し、超過時は送信前に止める", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    const form = postForm(page);
    const counter = page.locator(".oc-form-count");
    await expect(counter).toContainText("0 文字");
    await expect(counter).toContainText("上限 4096 バイト");

    await form.locator("textarea").fill("あいうえお");
    await expect(counter).toContainText("5 文字");
    // 日本語 5 文字 = 15 バイト（API は UTF-8 バイトで判定する）
    await expect(counter).toContainText("15 バイト");
    await expect(counter).not.toHaveClass(/over/);

    // 上限を超える本文（4096 バイト超）を入れると、送信前に赤字で警告する
    await form.locator("textarea").fill("あ".repeat(1400));
    await expect(counter).toHaveClass(/over/);
    await expect(counter).toContainText("上限を超えています");

    let posted = false;
    page.on("request", (request) => {
      if (/\/api\/v1\/threads\/\d+\/posts$/.test(new URL(request.url()).pathname)) posted = true;
    });
    await page.getByRole("button", { name: "投稿する" }).click();
    await expect(page.locator(".oc-form .oc-error")).toContainText("本文が長すぎます");
    expect(posted).toBe(false);
  });
});