// rv-core A11: お絵かきモーダルの確定ボタンが初期表示で見える（スクロール不要）。
// 回帰対象: museAI #11（「この絵を添付する」がモーダル下部に隠れ、スクロールしないと押せない）。
import { expect, test } from "@playwright/test";
import { createBoard, createThread, expandPostForm } from "./rv-core-helpers";

test.describe("rv-core A11: お絵かきモーダルの操作ボタン", () => {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 360, height: 740 },
  ]) {
    test(`${viewport.width}x${viewport.height}: 確定ボタンが画面内にある`, async ({ page, request }) => {
      const slug = await createBoard(request, { turnstile: "off" });
      const threadId = await createThread(request, slug);
      await page.setViewportSize(viewport);
      await page.goto(`/b/${slug}/t/${threadId}`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      await expandPostForm(page);

      await page.getByRole("button", { name: /お絵かき/ }).click();
      const modal = page.locator(".oc-modal");
      await expect(modal).toBeVisible({ timeout: 10_000 });
      const confirm = modal.getByRole("button", { name: "この絵を添付する" });
      await expect(confirm).toBeVisible();

      const box = await confirm.boundingBox();
      expect(box).not.toBeNull();
      const viewportHeight = page.viewportSize()?.height ?? 0;
      // ボタンの下端が画面内（スクロールせずに押せる）
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewportHeight);
      // モーダル本文がスクロールしても、確定ボタンはモーダルの下端に残る
      await modal.locator(".oc-modal-body").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      const afterScroll = await confirm.boundingBox();
      expect((afterScroll?.y ?? 0) + (afterScroll?.height ?? 0)).toBeLessThanOrEqual(viewportHeight);
    });
  }
});