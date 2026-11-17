// 証拠スクリーンショット（通常実行では skip）。
// 使い方: E2E_EVIDENCE=1 E2E_EVIDENCE_DIR=.../41_証拠 pnpm exec playwright test tour/site-tour-plugin-evidence.spec.ts --project=pc
// 360px は pc プロジェクトのまま viewport を 360x740 にして撮る。
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
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
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3255");
  await context.addCookies([
    { name: "oc_sess", value: "e2e-owner-session-token", domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("pev").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `証拠用プラグイン板 ${slug.slice(-4)}`,
      category: "E2E",
      description: "プラグインツアーの証拠用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function officialPluginId(request: APIRequestContext): Promise<string> {
  const response = await request.get(apiUrl("/v1/plugins?limit=50"), { headers: { Origin: ALLOWED_ORIGIN } });
  const body = await readEnvelope<{ items: Array<{ id: string; ownership: string }> }>(response);
  if (!body || !body.ok) throw new Error("プラグイン一覧の取得に失敗しました");
  const official = body.data.items.find((item) => item.ownership === "official");
  if (!official) throw new Error("公式プラグインの seed がありません");
  return official.id;
}

async function start(page: Page): Promise<void> {
  const intro = page.locator(".oc-tour-intro");
  if (await intro.count()) await intro.getByRole("button", { name: "案内を閉じる" }).click({ force: true });
  const header = page.locator('header [data-tour="site-tour"]');
  if (await header.isVisible()) await header.click();
  else await page.locator(".oc-footer-tour").click();
}

async function capture(page: Page, name: string): Promise<void> {
  await page.locator(".oc-tour-tooltip").waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot(name) });
}

test.describe("プラグイン画面の証拠画像", () => {
  test("pc: 各ツアーの代表手順", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    const officialId = await officialPluginId(request);

    await page.goto("/plugins/");
    await expect(page.locator('[data-tour="plugins-actions"]')).toBeVisible({ timeout: 20_000 });
    await start(page);
    await capture(page, "01_pc_plugins_list.png");

    await page.goto("/plugins/new/");
    await expect(page.locator('[data-tour="plugin-editor-anon-note"]')).toBeVisible({ timeout: 20_000 });
    await start(page);
    await capture(page, "02_pc_plugin_editor.png");

    await page.goto("/plugins/templates/");
    await expect(page.locator('[data-tour="plugin-templates-pick"]')).toBeVisible({ timeout: 20_000 });
    await start(page);
    await capture(page, "03_pc_plugin_templates.png");

    await page.goto(`/plugins/view/?id=${encodeURIComponent(officialId)}`);
    await expect(page.locator('[data-tour="plugin-detail-basic"]')).toBeVisible({ timeout: 20_000 });
    await start(page);
    await capture(page, "04_pc_plugin_detail.png");

    await page.goto(`/plugins/board/?slug=${slug}`);
    await expect(page.locator('[data-tour="plugins-board-target"]')).toContainText(slug, { timeout: 20_000 });
    await start(page);
    await capture(page, "05_pc_plugins_board.png");

    await page.goto("/plugins/review/");
    await expect(page.locator('[data-tour="plugins-review-filters"]')).toBeVisible({ timeout: 20_000 });
    await start(page);
    await capture(page, "06_pc_plugins_review.png");

    await page.goto("/account/plugin-tokens/");
    await expect(page.locator('[data-tour="plugin-tokens-issue"]')).toBeVisible({ timeout: 20_000 });
    await start(page);
    await capture(page, "07_pc_plugin_tokens.png");
  });

  test("360px: 各ツアーの最初の手順", async ({ page, context, request }) => {
    await hideNextDevOverlay(page);
    await loginAsOwner(context);
    const slug = await createBoard(request);
    const officialId = await officialPluginId(request);

    await page.setViewportSize({ width: 360, height: 740 });
    const cases: Array<{ path: string; selector: string; name: string }> = [
      { path: "/plugins/", selector: '[data-tour="plugins-actions"]', name: "08_narrow360_plugins_list.png" },
      { path: "/plugins/new/", selector: '[data-tour="plugin-editor-anon-note"]', name: "09_narrow360_plugin_editor.png" },
      { path: "/plugins/templates/", selector: '[data-tour="plugin-templates-pick"]', name: "10_narrow360_plugin_templates.png" },
      {
        path: `/plugins/view/?id=${encodeURIComponent(officialId)}`,
        selector: '[data-tour="plugin-detail-basic"]',
        name: "11_narrow360_plugin_detail.png",
      },
      { path: `/plugins/board/?slug=${slug}`, selector: '[data-tour="plugins-board-target"]', name: "12_narrow360_plugins_board.png" },
      { path: "/plugins/review/", selector: '[data-tour="plugins-review-filters"]', name: "13_narrow360_plugins_review.png" },
      { path: "/account/plugin-tokens/", selector: '[data-tour="plugin-tokens-issue"]', name: "14_narrow360_plugin_tokens.png" },
    ];
    for (const item of cases) {
      await page.goto(item.path);
      await expect(page.locator(item.selector)).toBeVisible({ timeout: 20_000 });
      await start(page);
      await capture(page, item.name);
      await page.keyboard.press("Escape");
      await expect(page.locator(".oc-tour-tooltip")).toHaveCount(0);
    }
  });
});