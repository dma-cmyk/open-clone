// 31 の証拠スクリーンショット（通常実行では skip）。
// 使い方:
//   E2E_EVIDENCE=1 E2E_EVIDENCE_DIR=".../31_証拠" \
//     pnpm exec playwright test tour/site-tour-index-evidence.spec.ts --project=pc
// スマホ幅は pc プロジェクトのまま viewport を 360x740 にして撮る。
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
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

async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("tourevi").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `証拠用の板 ${slug.slice(-4)}`,
      category: "E2E",
      description: "ツアー一覧の証拠用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThread(request: APIRequestContext, slug: string): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: "一覧の証拠用スレ", body: "1げっと。ツアー一覧の証拠用です。" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { data?: { threadId?: number } };
  const threadId = body.data?.threadId;
  if (!threadId) throw new Error("スレ作成に失敗しました");
  return threadId;
}

async function addDeputy(request: APIRequestContext, slug: string): Promise<void> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/staff`), {
    headers: ownerHeaders(),
    data: { accountName: "trev-deputy", level: "deputy" },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** セッション Cookie 付きの独立した文脈（初回案内は出さない）。 */
async function openSession(browser: Browser, cookie?: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("oc.tour.intro.v1", "1");
    } catch {
      // 保存できない環境でも撮影は続ける
    }
  });
  if (cookie) {
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
    await context.addCookies([
      { name: "oc_sess", value: cookie, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
  }
  const page = await context.newPage();
  await hideNextDevOverlay(page);
  return page;
}

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot(name), fullPage: false });
}

/** `#tour` の節だけを撮る（一覧の行がすべて入る）。 */
async function captureSection(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.locator("section#tour").screenshot({ path: shot(name) });
}

test.describe("証拠画像", () => {
  test("ツアー一覧（pc と 360px）", async ({ browser, request }) => {
    const slug = await createBoard(request);
    await createThread(request, slug);
    const general = await openSession(browser);
    try {
      await general.goto("/help/#tour");
      await expect(general.locator('[data-tour="tour-list"]')).toBeVisible({ timeout: 20_000 });
      await expect(general.locator('[data-tour-page="board"] .oc-btn')).toBeEnabled({ timeout: 20_000 });
      await captureSection(general, "01_pc_tour_list.png");

      await general.setViewportSize({ width: 360, height: 740 });
      await general.goto("/help/#tour");
      await expect(general.locator('[data-tour="tour-list"]')).toBeVisible({ timeout: 20_000 });
      await expect(general.locator('[data-tour-page="board"] .oc-btn')).toBeEnabled({ timeout: 20_000 });
      await captureSection(general, "02_narrow360_tour_list.png");
    } finally {
      await general.context().close();
    }
  });

  test("権限別の行（板スタッフ・サイト所有者）", async ({ browser, request }) => {
    const slug = await createBoard(request);
    await createThread(request, slug);
    await addDeputy(request, slug);
    const deputy = await openSession(browser, "e2e-tour-deputy-session-token");
    try {
      await deputy.goto("/help/#tour");
      await expect(deputy.locator('[data-tour-page="manage"]')).toHaveCount(1, { timeout: 20_000 });
      await captureSection(deputy, "03_pc_tour_list_staff.png");
    } finally {
      await deputy.context().close();
    }

    const owner = await openSession(browser, "e2e-owner-session-token");
    try {
      await owner.goto("/help/#tour");
      await expect(owner.locator('[data-tour-page="admin"]')).toHaveCount(1, { timeout: 20_000 });
      await captureSection(owner, "04_pc_tour_list_owner.png");
    } finally {
      await owner.context().close();
    }
  });

  test("ツアー中の目次（pc と 360px）", async ({ browser, request }) => {
    await createBoard(request);
    const page = await openSession(browser);
    try {
      await page.goto("/");
      await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
      await expect(page.locator('[data-tour="home-boards"]')).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "使い方", exact: true }).click();
      await expect(page.locator(".oc-tour-tooltip")).toBeVisible({ timeout: 15_000 });
      await page.locator(".oc-tour-tooltip").getByRole("button", { name: "目次" }).click();
      await expect(page.locator("#oc-tour-toc")).toBeVisible();
      await capture(page, "05_pc_toc.png");

      // 目次から 3 番目へ飛んだところ
      await page.locator("#oc-tour-toc .oc-tour-toc-item").nth(2).click();
      await expect(page.locator(".oc-tour-tooltip")).toBeVisible();
      await capture(page, "06_pc_toc_jump_step3.png");

      // 360px
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto("/");
      await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
      await page.locator(".oc-footer-tour").click();
      await expect(page.locator(".oc-tour-tooltip")).toBeVisible({ timeout: 15_000 });
      await page.locator(".oc-tour-tooltip").getByRole("button", { name: "目次" }).click();
      await expect(page.locator("#oc-tour-toc")).toBeVisible();
      await capture(page, "07_narrow360_toc.png");

      // 目次の中をスクロールしたところ（長い一覧でも画面内に収まる）
      await page.locator("#oc-tour-toc .oc-tour-toc-item").last().scrollIntoViewIfNeeded();
      await capture(page, "08_narrow360_toc_scrolled.png");
    } finally {
      await page.context().close();
    }
  });
});