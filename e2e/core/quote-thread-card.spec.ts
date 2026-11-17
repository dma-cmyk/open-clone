// 引用スレの元スレ表示（設計 70）の E2E。
//
// スレの「引用して新スレ」→ スレ立てフォームの「引用元」にスレタイ・板名・レス数が出る
// → リンクで元スレへ行ける →「引用をやめる」で引用なしに戻り、立てたスレに引用元カードが付かない。
// 削除済みの元スレではスレタイを出さない。

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

function ownerHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: "oc_sess=e2e-owner-session-token" };
}

async function createBoard(request: APIRequestContext): Promise<{ slug: string; name: string }> {
  const slug = unique("quote-card").toLowerCase();
  const name = `引用元表示板${slug.slice(-4)}`;
  const response = await request.post(`${API_BASE}/v1/boards`, {
    headers: ownerHeaders(),
    data: { slug, name, category: "E2E", settings: { turnstile: "off", cooldownSeconds: 0 } },
  });
  expect(response.status(), await response.text()).toBe(201);
  return { slug, name };
}

async function createThread(request: APIRequestContext, slug: string, title: string): Promise<number> {
  const response = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: ownerHeaders(),
    data: { title, body: `${title} の本文`, turnstileToken: "1x00000000000000000000AA" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = await readEnvelope<{ threadId: number }>(response);
  if (!body || !body.ok) throw new Error("スレ作成に失敗しました");
  return body.data.threadId;
}

/** モバイルでは投稿欄が畳まれているので開く（ツアーの回帰テストと同じ手順）。 */
async function expandForm(page: Page, buttonName: RegExp): Promise<void> {
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: buttonName }) }).first();
  const field = form.locator("textarea").first();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await field.waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      const bar = page.locator(".oc-form-openbar").first();
      if ((await bar.count()) > 0) await bar.click({ timeout: 2_000 }).catch(() => undefined);
      continue;
    }
    await page.waitForTimeout(500);
    if (await field.isVisible()) return;
  }
  await expect(field).toBeVisible();
}

test.describe("引用スレの元スレ表示", () => {
  test("フォームに元スレのスレタイ・板名が出て、リンクで移動でき、引用をやめられる", async ({ page, request }) => {
    test.setTimeout(180_000);
    const board = await createBoard(request);
    const sourceTitle = `引用元のスレタイ ${Date.now()}`;
    const sourceId = await createThread(request, board.slug, sourceTitle);

    await page.goto(`/b/${board.slug}/t/${sourceId}?r=l50`);
    await page.getByRole("button", { name: /引用して新スレ/ }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${board.slug}/\\?quote=${sourceId}`), { timeout: 15_000 });
    await expandForm(page, /スレを立てる/);

    const badge = page.locator(`[data-quote-thread="${sourceId}"]`);
    await expect(badge).toBeVisible({ timeout: 15_000 });
    // スレ ID だけでなく、スレタイと板名・レス数が出る。
    await expect(badge.getByRole("link", { name: sourceTitle })).toBeVisible({ timeout: 15_000 });
    await expect(badge).toContainText(board.name);
    await expect(badge).toContainText("1レス");
    await expect(badge.getByRole("link", { name: sourceTitle })).toHaveAttribute(
      "href",
      new RegExp(`/b/${board.slug}/t/${sourceId}$`),
    );

    // リンクは元スレへ移動する（通常のリンク）。
    await badge.getByRole("link", { name: sourceTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${board.slug}/t/${sourceId}`), { timeout: 15_000 });

    // 引用をやめる → ?quote= が外れ、引用元の表示も消える。
    await page.goto(`/b/${board.slug}/?quote=${sourceId}`);
    await expandForm(page, /スレを立てる/);
    await expect(page.locator(`[data-quote-thread="${sourceId}"]`)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "引用をやめる" }).click();
    await expect(page).not.toHaveURL(/quote=/, { timeout: 15_000 });
    await expect(page.locator(`[data-quote-thread="${sourceId}"]`)).toHaveCount(0);

    // 引用なしで立てたスレには引用元カードが付かない。
    await expandForm(page, /スレを立てる/);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: /スレを立てる/ }) }).first();
    await form.getByLabel(/スレタイ/).fill(`引用なしのスレ ${Date.now()}`);
    await form.locator("textarea").first().fill("引用なしの本文");
    await form.getByRole("button", { name: /スレを立てる/ }).click();
    await expect(page).toHaveURL(/\/b\/[^/]+\/t\/\d+/, { timeout: 20_000 });
    await expect(page.locator(".oc-quote-card")).toHaveCount(0);
  });

  test("削除済みの元スレではスレタイを出さない", async ({ page, request }) => {
    test.setTimeout(180_000);
    const board = await createBoard(request);
    const sourceTitle = `削除されるスレ ${Date.now()}`;
    const sourceId = await createThread(request, board.slug, sourceTitle);
    const deleted = await request.delete(`${API_BASE}/v1/threads/${sourceId}`, { headers: ownerHeaders() });
    expect(deleted.status(), await deleted.text()).toBe(200);

    await page.goto(`/b/${board.slug}/?quote=${sourceId}`);
    await expandForm(page, /スレを立てる/);
    const badge = page.locator(`[data-quote-thread="${sourceId}"]`);
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toContainText(`引用元のスレを表示できません（ID: ${sourceId}）`, { timeout: 15_000 });
    await expect(badge).not.toContainText(sourceTitle);
  });
});