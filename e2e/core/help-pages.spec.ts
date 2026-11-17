// ヘルプページ（/help/ と /help/admin/）のE2E。
// 直リンク表示・目次と各アンカーへの移動を pc / mobile の両方で確認する（設計50の受け入れ）。
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

const HELP_SECTIONS = [
  "basics",
  "reading",
  "posting",
  "board",
  "tsubuyaki",
  "account",
  "plugins",
  "report",
  "admin",
  "faq",
  "tour",
] as const;

const ADMIN_SECTIONS = ["roles", "board-staff", "site-admin", "owner", "plugin-review", "plugin-reports", "ai", "security"] as const;

/**
 * スクリーンショットの出力先。既定は Playwright のテスト出力ディレクトリで、
 * 証拠を残したいときだけ E2E_EVIDENCE_DIR で指定する。
 */
function shotPath(info: TestInfo, name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR ?? info.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/** 該当節がビューポート内（上部付近）に来ているか。 */
async function sectionInView(page: Page, id: string): Promise<boolean> {
  return page.evaluate((sectionId) => {
    const element = document.getElementById(sectionId);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.top >= -4 && rect.top < window.innerHeight * 0.6;
  }, id);
}

test.describe("ヘルプ（/help/）", () => {
  test("直リンクで表示され、目次から各節へ移動できる", async ({ page }, info) => {
    await page.goto("/help/");
    await expect(page.getByText("ヘルプ（使い方）").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("掲示板の基本（板・スレ・レス）").first()).toBeVisible();

    // 目次のリンクを辿ると URL のハッシュが変わり、該当節が見出し座標ごと画面内へ移動する。
    for (const id of HELP_SECTIONS) {
      await page.locator(`nav[aria-label="ヘルプ目次"] a[href="#${id}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/help/?#${id}$`));
      await expect(page.locator(`section#${id}`)).toBeVisible();
      await expect.poll(() => sectionInView(page, id)).toBe(true);
    }

    // 節の先頭見出しが実際に表示されている（目次クリックでスクロールすること）。
    await page.locator('nav[aria-label="ヘルプ目次"] a[href="#posting"]').click();
    await expect.poll(() => sectionInView(page, "posting")).toBe(true);

    await page.screenshot({ path: shotPath(info, "help-after-pc.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: shotPath(info, "help-after-360.png"), fullPage: true });
  });

  test("アンカー付きの直リンクで該当節までスクロールする", async ({ page }, info) => {
    await page.goto("/help/#plugins");
    await expect(page.locator("section#plugins")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sectionInView(page, "plugins")).toBe(true);
    await page.screenshot({ path: shotPath(info, "help-after-anchor-pc.png") });

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/help/#faq");
    await expect(page.locator("section#faq")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sectionInView(page, "faq")).toBe(true);
    await page.screenshot({ path: shotPath(info, "help-after-anchor-360.png") });
  });

  test("ツアーの始め方節のボタンでトップへ移り、トップのツアーが始まる", async ({ page }) => {
    await page.goto("/help/#tour");
    await expect(page.locator("section#tour")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "トップページでツアーを始める" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("dialog", { name: "トップページの使い方" })).toBeVisible({ timeout: 10_000 });
  });

  test("一般ヘルプから管理者ヘルプへリンクしている", async ({ page }) => {
    await page.goto("/help/");
    const link = page.getByRole("link", { name: "管理者向けヘルプ" }).first();
    await expect(link).toBeVisible({ timeout: 20_000 });
    await expect(link).toHaveAttribute("href", "/help/admin/");
  });
});

test.describe("管理者ヘルプ（/help/admin/）", () => {
  test("直リンクで表示され、目次から各節へ移動できる", async ({ page }, info) => {
    await page.goto("/help/admin/");
    await expect(page.getByText("管理者・所有者向けヘルプ").first()).toBeVisible({ timeout: 20_000 });

    for (const id of ADMIN_SECTIONS) {
      await page.locator(`nav[aria-label="管理者ヘルプ目次"] a[href="#${id}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/help/admin/?#${id}$`));
      await expect(page.locator(`section#${id}`)).toBeVisible();
      await expect.poll(() => sectionInView(page, id)).toBe(true);
    }

    await page.locator('nav[aria-label="管理者ヘルプ目次"] a[href="#security"]').click();
    await expect.poll(() => sectionInView(page, "security")).toBe(true);

    await page.screenshot({ path: shotPath(info, "help-admin-after-pc.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: shotPath(info, "help-admin-after-360.png"), fullPage: true });
  });

  test("アンカー付きの直リンクで該当節までスクロールする（パスワード節）", async ({ page }, info) => {
    await page.goto("/help/admin/#security");
    await expect(page.locator("section#security")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sectionInView(page, "security")).toBe(true);
    await page.screenshot({ path: shotPath(info, "help-admin-after-security-pc.png") });

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/help/admin/#ai");
    await expect(page.locator("section#ai")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => sectionInView(page, "ai")).toBe(true);
    await page.screenshot({ path: shotPath(info, "help-admin-after-ai-360.png") });
  });

  test("見出しは意味付けされた要素で描画される（M01）", async ({ page }) => {
    await page.goto("/help/");
    await expect(page.locator("h1")).toHaveCount(1);
    for (const id of HELP_SECTIONS) {
      await expect(page.locator(`section#${id} > h2`)).toHaveCount(1);
    }
    await page.goto("/help/admin/");
    await expect(page.locator("h1")).toHaveCount(1);
    for (const id of ADMIN_SECTIONS) {
      await expect(page.locator(`section#${id} > h2`)).toHaveCount(1);
    }
  });
});
