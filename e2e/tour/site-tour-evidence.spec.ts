// 証拠スクリーンショット（通常実行では skip）。
// 使い方: E2E_EVIDENCE=1 E2E_EVIDENCE_DIR=.../51_証拠 pnpm exec playwright test tour/site-tour-evidence.spec.ts --project=pc
// スマホ幅は pc プロジェクトのまま viewport を 360x740 にして撮る（実機幅の見え方を確認するため）。
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { unique } from "../helpers/ids";
import { hideNextDevOverlay } from "./dev-overlay";

const OUT_DIR = process.env.E2E_EVIDENCE_DIR ?? "";
test.skip(!process.env.E2E_EVIDENCE, "E2E_EVIDENCE=1 のときだけ実行する");

function shot(name: string): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, name);
}

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: "oc_sess=e2e-owner-session-token",
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

async function loginAsOwner(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3201");
  await context.addCookies([
    { name: "oc_sess", value: "e2e-owner-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("tourev").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `証拠用の板 ${slug.slice(-4)}`,
      category: "E2E",
      description: "サイトツアーの証拠用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThread(request: APIRequestContext, slug: string): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: "ツアーの証拠用スレ", body: "1げっと。スクリーンショット用です。" },
  });
  const body = (await response.json()) as { data?: { threadId?: number } };
  const threadId = body.data?.threadId;
  if (!threadId) throw new Error("スレ作成に失敗しました");
  return threadId;
}

/** 初回案内を閉じてから、指定の要素でツアーを開始する。 */
async function startFrom(page: Page, selector: string): Promise<void> {
  const intro = page.locator(".oc-tour-intro");
  if (await intro.count()) {
    await intro.getByRole("button", { name: "案内を閉じる" }).click({ force: true });
  }
  if (selector === "footer") {
    await page.locator(".oc-footer-tour").click({ force: true });
    return;
  }
  await page.locator(selector).click({ force: true });
}

async function capture(page: Page, name: string): Promise<void> {
  await page.locator(".oc-tour-tooltip").waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(name) });
}

test.describe("証拠画像", () => {
  test("トップ: ツアー（pc と 360px）", async ({ page }) => {
    await hideNextDevOverlay(page);
    await page.goto("/");
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    await expect(page.locator('[data-tour="home-boards"]')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("01_pc_intro_banner.png") });
    await startFrom(page, 'header [data-tour="site-tour"]');
    await capture(page, "02_pc_home_tour_step1.png");
    await page.locator(".oc-tour-tooltip").getByRole("button", { name: "次へ" }).click();
    await page.locator(".oc-tour-tooltip").getByRole("button", { name: "次へ" }).click();
    await capture(page, "03_pc_home_tour_boards.png");

    await page.setViewportSize({ width: 360, height: 740 });
    await page.reload();
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    await startFrom(page, "footer");
    await capture(page, "04_narrow360_home_tour.png");
  });

  test("板とスレ: ツアー（pc と 360px）", async ({ page, request, context }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug);

    await page.goto(`/b/${slug}`);
    await expect(page.locator(".oc-board-title")).toBeVisible({ timeout: 20_000 });
    await startFrom(page, 'header [data-tour="site-tour"]');
    await capture(page, "05_pc_board_tour.png");

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await startFrom(page, 'header [data-tour="site-tour"]');
    await capture(page, "06_pc_thread_tour_head.png");
    for (let i = 0; i < 5; i += 1) {
      await page.locator(".oc-tour-tooltip").getByRole("button", { name: "次へ" }).click();
    }
    await capture(page, "07_pc_thread_tour_form.png");

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await startFrom(page, "footer");
    await capture(page, "08_narrow360_thread_tour.png");
  });

  test("管理画面と板の管理: ツアー（pc）", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    await page.goto("/admin");
    await expect(page.locator(".oc-main").first()).toContainText("管理", { timeout: 20_000 });
    await startFrom(page, '[data-tour="admin-help"]');
    await capture(page, "09_pc_admin_tour.png");

    const slug = await createBoard(request);
    await page.goto(`/b/${slug}/manage`);
    await expect(page.locator(".oc-main").first()).toContainText("の板管理", { timeout: 20_000 });
    await startFrom(page, '[data-tour="manage-help"]');
    await capture(page, "10_pc_manage_tour.png");
  });
});