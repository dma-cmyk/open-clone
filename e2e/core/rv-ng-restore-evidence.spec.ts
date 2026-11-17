// R81 証拠スクリーンショット（通常のテスト実行では skip）。
// 使い方: E2E_EVIDENCE=1 E2E_EVIDENCE_DIR=/path/to/81_証拠 pnpm exec playwright test core/rv-ng-restore-evidence.spec.ts --project=pc
import { expect, test, type Page } from "@playwright/test";
import { createBoard, createThread, postReply } from "./rv-core-helpers";

const OUT_DIR = process.env.E2E_EVIDENCE_DIR ?? "";

test.skip(!process.env.E2E_EVIDENCE, "E2E_EVIDENCE=1 のときだけ実行する");

/** 端末設定の初期値（同じ端末で 1 回だけ入れる）。 */
async function seedNgSettings(page: Page, ng: Record<string, unknown>): Promise<void> {
  await page.addInitScript((value) => {
    if (window.localStorage.getItem("oc.settings.v1") === null) {
      window.localStorage.setItem("oc.settings.v1", JSON.stringify({ ng: value }));
    }
  }, ng);
}

function threadRow(page: Page, title: string) {
  return page.locator(".oc-thread-row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

test.describe("証拠画像", () => {
  test("PC: 設定の NG タブ（件数・追加日時・無視したスレ・すべて解除）", async ({ page }) => {
    const now = Date.now();
    await seedNgSettings(page, {
      mode: "hide",
      words: ["宣伝", ":image"],
      ids: ["AbCd"],
      threads: ["旧NGスレタイ"],
      ignoredThreads: [{ id: 123, board: "news", title: "無視したスレの例", at: now - 86_400_000 }],
      addedAt: { "words:宣伝": now - 3_600_000, "ids:AbCd": now },
    });
    await page.goto("/settings?tab=ng");
    await expect(page.getByRole("heading", { name: "NG 設定" })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-history-item")).toContainText("無視したスレの例");
    await page.screenshot({ path: `${OUT_DIR}/01_pc_settings_ng_restore.png`, fullPage: true });
  });

  test("PC: 板の件数案内とスレの NG の帯", async ({ page, request }) => {
    const word = `ngword-${Date.now()}`;
    await seedNgSettings(page, { mode: "hide", words: [word] });
    const slug = await createBoard(request, { turnstile: "off" });
    const ignoreTitle = `rv 無視の証拠 ${Date.now()}`;
    await createThread(request, slug, { title: ignoreTitle, body: "無視するスレ" });
    const threadId = await createThread(request, slug, { title: `rv 証拠スレ ${Date.now()}`, body: "1げっと" });
    await postReply(request, threadId, `非表示になる本文 ${word}`);

    await page.goto(`/b/${slug}`);
    await expect(threadRow(page, ignoreTitle)).toBeVisible({ timeout: 20_000 });
    await threadRow(page, ignoreTitle).getByRole("button", { name: "無視" }).click();
    const block = page.locator(".oc-ng-block").filter({ hasText: "無視したスレです" });
    await expect(block).toBeVisible();
    await expect(block.getByRole("button", { name: "無視をやめる" })).toBeVisible();
    await page.screenshot({ path: `${OUT_DIR}/02_pc_board_ignore_undo.png`, fullPage: false });

    await page.goto(`/b/${slug}/t/${threadId}?r=all`);
    const postBlock = page.locator(".oc-ng-block").filter({ hasText: "により非表示にしました" });
    await expect(postBlock).toBeVisible({ timeout: 20_000 });
    await expect(postBlock.getByRole("button", { name: "NG を解除" })).toBeVisible();
    await page.screenshot({ path: `${OUT_DIR}/03_pc_thread_ng_band.png`, fullPage: false });
  });

  test("360px: 設定の NG タブとスレの NG の帯", async ({ page, request }) => {
    const word = `ngword-${Date.now()}`;
    await seedNgSettings(page, {
      mode: "hide",
      words: [word],
      ignoredThreads: [{ id: 456, board: "news", title: "無視したスレの例", at: Date.now() }],
    });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/settings?tab=ng");
    await expect(page.getByRole("heading", { name: "NG 設定" })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${OUT_DIR}/04_narrow360_settings_ng_restore.png`, fullPage: false });

    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "1げっと" });
    await postReply(request, threadId, `非表示になる本文 ${word}`);
    await page.goto(`/b/${slug}/t/${threadId}?r=all`);
    const postBlock = page.locator(".oc-ng-block").filter({ hasText: "により非表示にしました" });
    await expect(postBlock).toBeVisible({ timeout: 20_000 });
    await postBlock.scrollIntoViewIfNeeded();
    await expect(postBlock.getByRole("button", { name: "NG を解除" })).toBeVisible();
    await page.screenshot({ path: `${OUT_DIR}/05_narrow360_thread_ng_band.png`, fullPage: false });
  });
});