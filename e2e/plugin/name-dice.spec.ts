// 名前欄コマンド `!NdM` の E2E（pc + mobile）。
//  - 名前に `!2d6` と書いてレスすると、サーバーが振った出目が名前に付いてスレに残る
//  - 手書きの `【2d6:6+6=12】` は本物と見分けられる（名前側の括弧が変わる）
//  - 長い名前でも結果の部分は切れない
// 板・スレは API で用意し、投稿だけ UI から行う（既存の core 系と同じ方針）。

import { expect, test, type Page } from "@playwright/test";
import { createBoard, createThread, expandPostForm, postForm } from "../core/rv-core-helpers";

async function openThread(page: Page, slug: string, threadId: number): Promise<void> {
  await page.goto(`/b/${slug}/t/${threadId}`);
  await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
}

async function submitReply(page: Page, name: string, body: string, threadId: number): Promise<void> {
  await expandPostForm(page);
  const form = postForm(page);
  await form.getByLabel("名前").fill(name);
  await form.locator("textarea").fill(body);
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new RegExp(`/api/v1/threads/${threadId}/posts$`).test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "投稿する" }).click();
  expect((await posted).status()).toBe(201);
}

test.describe("名前欄の !NdM", () => {
  test("名前に !2d6 と書くと、出目が付いた名前でレスが残る", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "サイコロのテスト" });
    await openThread(page, slug, threadId);

    await submitReply(page, "!2d6", "サーバーのサイコロで振ります", threadId);
    const name = page.locator("#p2 .oc-post-name");
    await expect(name).toBeVisible({ timeout: 20_000 });
    await expect(name).toContainText("【2d6:");
    const text = (await name.textContent()) ?? "";
    expect(text).toMatch(/【2d6:[1-6]\+[1-6]=([2-9]|1[0-2])】$/);
    expect(text.startsWith("名無しさん")).toBe(true);

    // 再読み込みしても保存された名前のまま（表示だけの飾りではない）。
    await page.reload();
    await expect(page.locator("#p2 .oc-post-name")).toContainText("【2d6:", { timeout: 20_000 });
  });

  test("手書きの【2d6:6+6=12】は本物と見分けられる", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "偽装のテスト" });
    await openThread(page, slug, threadId);

    await submitReply(page, "【2d6:6+6=12】", "手書きの結果", threadId);
    const name = page.locator("#p2 .oc-post-name");
    await expect(name).toBeVisible({ timeout: 20_000 });
    await expect(name).toHaveText("〔2d6:6+6=12〕");
    await expect(name).not.toContainText("【");
  });

  test("長い名前でも出目の表示は切れない", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "長い名前のテスト" });
    await openThread(page, slug, threadId);

    const longName = `${"あ".repeat(30)} !2d6`;
    await submitReply(page, longName, "長い名前で振ります", threadId);
    const name = page.locator("#p2 .oc-post-name");
    await expect(name).toBeVisible({ timeout: 20_000 });
    const text = (await name.textContent()) ?? "";
    expect(text.startsWith("あ".repeat(30))).toBe(true);
    expect(text).toMatch(/【2d6:[1-6]\+[1-6]=([2-9]|1[0-2])】$/);
  });
});