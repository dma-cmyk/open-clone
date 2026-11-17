// R81: NG・スレの無視を「戻せる」ことの検証。
// 設計 80 の受け入れ: 追加直後の「元に戻す」／帯からの「NG を解除」／
//                   スレ ID 単位の無視（似たタイトルは隠れない）／設定からの解除／
//                   「完全に無視」での件数案内。
import { expect, test, type Page } from "@playwright/test";
import { createBoard, createThread, postReply } from "./rv-core-helpers";

/** 端末設定の初期値（同じ端末で 1 回だけ入れる。遷移のたびに上書きしない）。 */
async function seedNgSettings(page: Page, ng: Record<string, unknown>): Promise<void> {
  await page.addInitScript((value) => {
    if (window.localStorage.getItem("oc.settings.v1") === null) {
      window.localStorage.setItem("oc.settings.v1", JSON.stringify({ ng: value }));
    }
  }, ng);
}

async function storedSettings(page: Page): Promise<{ ng?: { ids?: string[]; words?: string[]; ignoredThreads?: unknown[] } }> {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem("oc.settings.v1") ?? "{}"));
}

/** スレ一覧の行（タイトルの完全一致で特定する）。 */
function threadRow(page: Page, title: string) {
  return page.locator(".oc-thread-row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

test.describe("R81: NG と無視を戻す", () => {
  test("ID を NG にした直後、トーストの「元に戻す」で戻せる", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "1げっと" });
    await postReply(request, threadId, "ID を NG にする対象のレス");

    await page.goto(`/b/${slug}/t/${threadId}?r=all`);
    const target = page.locator("#p2");
    await expect(target).toBeVisible({ timeout: 20_000 });
    await target.locator(".oc-post-ng").click();

    const toast = page.locator(".oc-toast").filter({ hasText: "を NG に追加しました" });
    await expect(toast).toBeVisible();
    // 既定の確認モードでは、NG に当たったレスに帯が出る
    await expect(page.locator(".oc-ng-confirm")).toHaveCount(1);
    expect((await storedSettings(page)).ng?.ids).toHaveLength(1);

    await toast.getByRole("button", { name: "元に戻す" }).click();
    await expect(page.locator(".oc-ng-confirm")).toHaveCount(0);
    await expect(page.locator("#p2")).toContainText("ID を NG にする対象のレス");
    expect((await storedSettings(page)).ng?.ids).toHaveLength(0);
  });

  test("スレ内の NG の帯の「NG を解除」でレスが戻る", async ({ page, request }) => {
    const word = `ngword-${Date.now()}`;
    await seedNgSettings(page, { mode: "hide", words: [word] });
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "1げっと" });
    await postReply(request, threadId, `非表示にされる本文 ${word}`);

    await page.goto(`/b/${slug}/t/${threadId}?r=all`);
    const block = page.locator(".oc-ng-block").filter({ hasText: "により非表示にしました" });
    await expect(block).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#p2")).toHaveCount(0);

    await block.getByRole("button", { name: "NG を解除" }).click();
    await expect(page.locator(".oc-ng-block")).toHaveCount(0);
    await expect(page.locator("#p2")).toContainText(word);
    expect((await storedSettings(page)).ng?.words).toEqual([]);
  });

  test("スレの無視はそのスレだけを隠し、設定の「無視したスレ」から解除できる", async ({ page, request }) => {
    await seedNgSettings(page, { mode: "hide" });
    const slug = await createBoard(request, { turnstile: "off" });
    const title = `rv 無視テスト part1 ${Date.now()}`;
    const similarTitle = `${title}0`;
    await createThread(request, slug, { title, body: "無視するスレ" });
    await createThread(request, slug, { title: similarTitle, body: "似たタイトルのスレ" });

    await page.goto(`/b/${slug}`);
    await expect(threadRow(page, title)).toBeVisible({ timeout: 20_000 });
    await expect(threadRow(page, similarTitle)).toBeVisible();

    // 1) 追加直後の「元に戻す」で戻る
    await threadRow(page, title).getByRole("button", { name: "無視" }).click();
    await page.locator(".oc-toast").getByRole("button", { name: "元に戻す" }).click();
    await expect(threadRow(page, title)).toBeVisible();

    // 2) もう一度無視すると、そのスレだけが帯に変わる（似たタイトルは残る）
    await threadRow(page, title).getByRole("button", { name: "無視" }).click();
    const block = page.locator(".oc-ng-block").filter({ hasText: "無視したスレです" });
    await expect(block).toBeVisible();
    await expect(threadRow(page, title)).toHaveCount(0);
    await expect(threadRow(page, similarTitle)).toBeVisible();
    await expect(threadRow(page, similarTitle).locator(".oc-badge-red")).toHaveCount(0);
    expect((await storedSettings(page)).ng?.ignoredThreads).toHaveLength(1);

    // 3) 設定の「無視したスレ」から解除する
    await page.goto("/settings?tab=ng");
    await expect(page.getByRole("heading", { name: "NG 設定" })).toBeVisible({ timeout: 20_000 });
    const ignoredItem = page.locator(".oc-history-item").filter({ hasText: title });
    await expect(ignoredItem).toBeVisible();
    await expect(ignoredItem).toContainText("追加");
    await ignoredItem.getByRole("button", { name: "解除" }).click();
    await expect(page.locator(".oc-history-item").filter({ hasText: title })).toHaveCount(0);
    expect((await storedSettings(page)).ng?.ignoredThreads).toHaveLength(0);

    await page.goto(`/b/${slug}`);
    await expect(threadRow(page, title)).toBeVisible({ timeout: 20_000 });
  });

  test("「完全に無視」では板とスレの末尾に NG で隠れた件数の案内が出る", async ({ page, request }) => {
    const word = `ignore-${Date.now()}`;
    await seedNgSettings(page, { mode: "ignore", words: [word] });
    const slug = await createBoard(request, { turnstile: "off" });
    const hiddenTitle = `rv 完全無視 ${Date.now()}`;
    await createThread(request, slug, { title: hiddenTitle, body: "隠れるスレ" });
    await createThread(request, slug, { title: `rv 表示される ${Date.now()}`, body: "残るスレ" });
    const ngThreadId = await createThread(request, slug, { title: `rv スレ内 ${Date.now()}`, body: "1げっと" });
    await postReply(request, ngThreadId, `このレスは NG ${word}`);

    // 板: スレを無視すると一覧から消え、末尾に件数が出る
    await page.goto(`/b/${slug}`);
    await expect(threadRow(page, hiddenTitle)).toBeVisible({ timeout: 20_000 });
    await threadRow(page, hiddenTitle).getByRole("button", { name: "無視" }).click();
    await expect(threadRow(page, hiddenTitle)).toHaveCount(0);
    const boardNote = page.locator(".oc-ng-note");
    await expect(boardNote).toContainText("NG で隠れている: 1 件");
    await boardNote.getByRole("link", { name: "設定で確認" }).click();
    await expect(page).toHaveURL(/\/settings\?tab=ng/);
    await expect(page.getByRole("heading", { name: "NG 設定" })).toBeVisible();

    // スレ: 完全に無視で出ないレスも、末尾に件数が出る
    await page.goto(`/b/${slug}/t/${ngThreadId}?r=all`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#p2")).toHaveCount(0);
    await expect(page.locator(".oc-ng-note")).toContainText("NG で隠れている: 1 件");
  });

  test("設定の NG タブは件数・追加日時つきで、種類ごとに「すべて解除」できる", async ({ page }) => {
    await page.goto("/settings?tab=ng");
    await expect(page.getByRole("heading", { name: "NG 設定" })).toBeVisible({ timeout: 20_000 });

    const first = `rv-all-${Date.now()}-1`;
    const second = `rv-all-${Date.now()}-2`;
    const input = page.getByPlaceholder(/荒らし/).first();
    await input.fill(first);
    await page.getByRole("button", { name: "追加" }).first().click();
    await input.fill(second);
    await page.getByRole("button", { name: "追加" }).first().click();

    const items = page.locator(".oc-ng-item").filter({ hasText: "rv-all-" });
    await expect(items).toHaveCount(2);
    await expect(items.first()).toContainText("追加 ");
    await expect(page.locator(".oc-label").filter({ hasText: "NG ワード（本文・部分一致）" })).toContainText("2 件");

    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "すべて解除（2 件）" }).first().click();
    await expect(page.locator(".oc-ng-item").filter({ hasText: "rv-all-" })).toHaveCount(0);
    expect((await storedSettings(page)).ng?.words).toEqual([]);
  });
});