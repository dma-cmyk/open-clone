// AI ペットの置き場所の e2e。
//  - 390px と PC(1280px) で、右下のボタンが既存のボタン（投稿の送信ボタンなど）を隠していないことを
//    画素の当たり判定（elementFromPoint）で確かめ、画面写真を残す（E2E_EVIDENCE_DIR があれば保存）。
//  - サイトツアー中はボタンを出さない。
//
// 390px と PC は同じ試験の中で viewport を変えて測るので、mobile プロジェクトでは省く。

import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { configurePet, installRelayStub, openPet, seedBoardAndThread, sendPetMessage } from "./helpers";

const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return;
  await page.screenshot({ path: path.join(EVIDENCE_DIR, name), fullPage: false });
}

/** その要素の中心が一番上にあり、ほかの要素に覆われていないか。 */
async function isOnTop(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return top !== null && (top === element || element.contains(top));
  });
}

async function overlaps(page: Page, a: string, b: string): Promise<boolean> {
  const first = await page.locator(a).first().boundingBox();
  const second = await page.locator(b).first().boundingBox();
  if (!first || !second) return false;
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

async function setupConversation(page: Page, request: APIRequestContext, label: string) {
  const { slug, threadId } = await seedBoardAndThread(request);
  await installRelayStub(page);
  await page.goto(`/b/${slug}/t/${threadId}`);
  await expect(page.getByTestId("pet-launcher")).toBeVisible();
  await openPet(page);
  await configurePet(page, { model: "test-model", apiKey: "sk-test" });
  await sendPetMessage(page, "ペット、使い方を教えて");
  await expect(page.getByText("了解: ペット、使い方を教えて", { exact: false })).toBeVisible();
  await page.getByTestId("pet-close").click();
  await shot(page, `${label}-thread.png`);
}

test.describe("AI ペットの置き場所", () => {
  test.skip(({ isMobile }) => isMobile, "390px と PC を同じ試験で測るため pc プロジェクトだけで実行する");

  test("390px: 既存のボタンを隠さず、パネルは全画面", async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setupConversation(page, request, "390");

    // 右下のボタン（52px）が投稿の送信ボタンに重ならない。
    // 390px では投稿欄が「書き込む」バーに畳まれているので、まずそのバーを確かめてから開く。
    const openBar = page.locator(".oc-form-openbar");
    await page.locator("#post-form-anchor").scrollIntoViewIfNeeded();
    await expect(openBar).toBeVisible();
    expect(await isOnTop(page, ".oc-form-openbar")).toBe(true);
    await openBar.click();
    const submit = ".oc-form-submit";
    await page.locator(submit).scrollIntoViewIfNeeded();
    await expect(page.locator(submit)).toBeVisible();
    expect(await overlaps(page, "[data-testid='pet-launcher']", submit)).toBe(false);
    expect(await isOnTop(page, submit)).toBe(true);
    // ヘッダーの操作も隠していない（390px では検索欄は元から非表示なので、ナビとヘルプを見る）。
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect(page.locator(".oc-logo")).toBeInViewport();
    expect(await isOnTop(page, ".oc-header-nav a[href='/settings']")).toBe(true);
    expect(await isOnTop(page, "[data-tour='site-help']")).toBe(true);

    // パネルは全画面。
    await page.getByTestId("pet-launcher").click();
    const panel = page.getByTestId("pet-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(370);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(800);
    await page.getByTestId("pet-open-settings").click();
    await shot(page, "390-settings.png");
    await page.getByTestId("pet-open-settings").click();
    await shot(page, "390-panel.png");
  });

  test("PC(1280px): 既存のボタンを隠さず、パネルは右下 380 幅", async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await setupConversation(page, request, "pc");

    const submit = ".oc-form-submit";
    await page.locator(submit).scrollIntoViewIfNeeded();
    await expect(page.locator(submit)).toBeVisible();
    expect(await overlaps(page, "[data-testid='pet-launcher']", submit)).toBe(false);
    expect(await isOnTop(page, submit)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await isOnTop(page, ".oc-header-nav a[href='/settings']")).toBe(true);

    await page.getByTestId("pet-launcher").click();
    const panel = page.getByTestId("pet-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(380);
    await page.getByTestId("pet-open-settings").click();
    await shot(page, "pc-settings.png");
    await page.getByTestId("pet-open-settings").click();
    await shot(page, "pc-panel.png");
  });

  test("サイトツアー中はボタンを出さない", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("pet-launcher")).toBeVisible();
    await page.getByRole("button", { name: "使い方", exact: true }).click();
    await expect(page.getByTestId("pet-launcher")).toHaveCount(0);
    // ツアーを終えると戻る。
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pet-launcher")).toBeVisible();
  });

  test("プラグインのエディタでも保存の操作を隠さない（390px と PC）", async ({ page }) => {
    const save = "[data-tour='plugin-editor-actions'] .oc-btn-primary";
    for (const viewport of [
      { width: 390, height: 844, label: "390" },
      { width: 1280, height: 900, label: "pc" },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/plugins/new/");
      await expect(page.getByTestId("pet-launcher")).toBeVisible();
      await page.locator(save).scrollIntoViewIfNeeded();
      await expect(page.locator(save)).toBeVisible();
      expect(await overlaps(page, "[data-testid='pet-launcher']", save)).toBe(false);
      expect(await isOnTop(page, save)).toBe(true);
      await shot(page, `${viewport.label}-plugin-editor.png`);
    }
  });
});