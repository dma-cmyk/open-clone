// 証拠スクリーンショット（E2E_EVIDENCE=1 のときだけ）。スレ下部のサイコロ・確認・
// 書き込まれたレス（出目つきの名前）・pc と 360px。E2E_EVIDENCE_DIR に PNG を書く（既定は /var/tmp）。

import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_SESSION = "e2e-owner-session-token";
const enabled = process.env.E2E_EVIDENCE === "1";
const outputDir = process.env.E2E_EVIDENCE_DIR ?? "/var/tmp";

function ownerHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` };
}

async function createThread(request: APIRequestContext): Promise<{ slug: string; threadId: number }> {
  const slug = unique("shot").toLowerCase();
  const board = await request.post(`${API_BASE}/v1/boards`, {
    headers: ownerHeaders(),
    data: { slug, name: `表示場所の証拠板${slug.slice(-4)}`, category: "E2E", settings: { turnstile: "off" } },
  });
  expect(board.status(), await board.text()).toBe(201);
  const thread = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: ownerHeaders(),
    data: { title: "サイコロの表示確認スレ", body: "各レスの下にサイコロが出ることを確認します", turnstileToken: "1x00000000000000000000AA" },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const body = await readEnvelope<{ threadId: number }>(thread);
  if (!body || !body.ok) throw new Error("スレ作成に失敗しました");
  await request.post(`${API_BASE}/v1/threads/${body.data.threadId}/posts`, {
    headers: { ...ownerHeaders(), Cookie: `oc_sess=${OWNER_SESSION}; oc_did=${"a".repeat(32)}` },
    data: { body: "2 つ目のレスです。ここにもサイコロが出ます。" },
  });
  return { slug, threadId: body.data.threadId };
}

async function login(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3265");
  await context.addCookies([
    { name: "oc_sess", value: OWNER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

test.describe("証拠スクリーンショット", () => {
  test.skip(!enabled, "E2E_EVIDENCE=1 のときだけ実行");

  test("スレ下部のサイコロ・確認・書き込まれたレス（pc と 360px）", async ({ page, context, request }) => {
    test.setTimeout(180_000);
    await login(context);
    const name = unique("shot-dice").toLowerCase();
    const thread = await createThread(request);

    await page.goto("/plugins/templates/");
    const card = page.locator("section[data-template='dice-button']");
    await card.getByRole("button", { name: "これで作る" }).click();
    await page.getByLabel("プラグイン名").fill(name);
    await page.getByRole("button", { name: "プレビュー" }).click();
    await expect(page.getByText("保存できます")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "自分用に導入して保存" }).click();
    await expect(page.getByText(/自分用に導入しました/)).toBeVisible({ timeout: 20_000 });

    try {
      // PC
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      const slot = page.locator('[data-plugin-slot="thread-bottom"]');
      await expect(slot).toBeVisible({ timeout: 20_000 });
      const frame = page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
      await expect(frame.getByRole("button", { name: /🎲 1d6/ })).toBeVisible({ timeout: 20_000 });
      await slot.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${outputDir}/${test.info().project.name}_pc_thread_bottom_dice.png` });

      await frame.getByRole("button", { name: /🎲 1d6/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${outputDir}/${test.info().project.name}_pc_thread_bottom_dice_confirm.png` });

      const posted = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/posts",
      );
      await dialog.getByRole("button", { name: "書き込む" }).click();
      expect((await posted).status()).toBe(201);
      await expect(dialog).toHaveCount(0, { timeout: 20_000 });
      await page.reload();
      await expect(page.locator(".oc-post-name").filter({ hasText: "【1d6:" })).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${outputDir}/${test.info().project.name}_pc_thread_bottom_dice_posted.png` });

      // 360px
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      const narrowSlot = page.locator('[data-plugin-slot="thread-bottom"]');
      await expect(narrowSlot).toBeVisible({ timeout: 20_000 });
      const narrowFrame = page.frameLocator(
        `[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`,
      );
      await expect(narrowFrame.getByRole("button", { name: /🎲 1d6/ })).toBeVisible({ timeout: 20_000 });
      await narrowSlot.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${outputDir}/${test.info().project.name}_narrow360_thread_bottom_dice.png` });
    } finally {
      const list = await request.get(`${API_BASE}/v1/plugins?q=${encodeURIComponent(name)}&mine=true`, {
        headers: ownerHeaders(),
      });
      const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(list);
      const id = body?.ok ? body.data.items.find((item) => item.name === name)?.id : undefined;
      if (id) {
        await request.post(`${API_BASE}/v1/plugins/${id}/uninstall`, { headers: ownerHeaders(), data: { scope: "personal" } });
        await request.delete(`${API_BASE}/v1/plugins/${id}`, { headers: ownerHeaders() });
      }
    }
  });

  test("引用元のスレタイ表示（pc と 360px）", async ({ page, request }) => {
    test.setTimeout(180_000);
    const slug = unique("shot-quote").toLowerCase();
    const board = await request.post(`${API_BASE}/v1/boards`, {
      headers: ownerHeaders(),
      data: { slug, name: `引用元の証拠板${slug.slice(-4)}`, category: "E2E", settings: { turnstile: "off" } },
    });
    expect(board.status(), await board.text()).toBe(201);
    const thread = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: ownerHeaders(),
      data: { title: "引用元になるスレ（長いスレタイの表示確認用）", body: "元スレの本文", turnstileToken: "1x00000000000000000000AA" },
    });
    const body = await readEnvelope<{ threadId: number }>(thread);
    if (!body || !body.ok) throw new Error("スレ作成に失敗しました");

    for (const [label, width, height] of [
      ["pc", 1280, 900],
      ["narrow360", 360, 740],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/b/${slug}/?quote=${body.data.threadId}`);
      const collapseBar = page.locator(".oc-form-openbar").first();
      const quoteRow = page.locator(`[data-quote-thread="${body.data.threadId}"]`);
      for (let attempt = 0; attempt < 5 && !(await quoteRow.isVisible().catch(() => false)); attempt += 1) {
        if (await collapseBar.isVisible().catch(() => false)) await collapseBar.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
      await expect(quoteRow).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: `${outputDir}/${test.info().project.name}_${label}_quote_card.png`, fullPage: false });
    }
  });
});