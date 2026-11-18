// プラグイン投稿のホスト確認 + Turnstile の E2E（pc + mobile）。
//
// 既定の板（turnstile: "anonymous"）と "always" の板では、プラグイン中継の投稿は
// 毎回 Turnstile を検証される（R82-01）。プラグインは自前でトークンを取れないため、
// ホストが確認モーダルを出し、その中の TurnstileWidget で得たトークンを付けて投稿する。
//
// ここではテンプレート「サイコロ（レスに書き込む）」を未ログイン（端末所有）で導入し、
// ボタン → ホストのモーダル → 書き込み → 出目つきのレス、までを確認する。
// 「やめる」では 1 件も書き込まれないことも見る。

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { createBoard, stubTurnstile } from "../core/rv-core-helpers";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";
/** 公式テストキーの常時成功トークン（siteverify スタブも常に成功させる）。 */
const ALWAYS_OK_TOKEN = "1x00000000000000000000AA";

/** スレを作る。`always` の板はスレ立てにもトークンが要る（既存の core ヘルパは渡さない）。 */
async function createThread(request: APIRequestContext, slug: string, body: string): Promise<number> {
  const response = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: OWNER_COOKIE },
    data: { title: `プラグイン投稿 ${Date.now()}`, body, turnstileToken: ALWAYS_OK_TOKEN },
  });
  const envelope = await readEnvelope<{ threadId: number }>(response);
  if (response.status() !== 201 || !envelope || !envelope.ok) {
    throw new Error(`スレの作成に失敗しました: ${response.status()} ${await response.text()}`);
  }
  return envelope.data.threadId;
}

/** テンプレートからサイコロを作り、端末（未ログイン）に導入する。 */
async function installDiceAnonymously(page: Page, name: string): Promise<void> {
  await page.goto("/plugins/templates/");
  const card = page.locator("section[data-template='dice-button']");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "これで作る" }).click();
  await page.getByLabel("プラグイン名").fill(name);
  const saved = page.waitForResponse(
    (response) => response.request().method() === "POST" && /\/api\/v1\/plugins$/.test(new URL(response.url()).pathname),
  );
  const installed = page.waitForResponse(
    (response) => response.request().method() === "POST" && /\/install$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "自分用に導入して保存" }).click();
  expect((await saved).status()).toBe(201);
  expect((await installed).status()).toBe(201);
  await expect(page.getByText(/自分用に導入しました/)).toBeVisible({ timeout: 20_000 });
}

async function cleanup(page: Page, name: string): Promise<void> {
  const headers = { Origin: ALLOWED_ORIGIN };
  const list = await page.request.get(`${API_BASE}/v1/plugins?q=${encodeURIComponent(name)}&mine=true`, { headers });
  const body = (await list.json()) as { ok?: boolean; data?: { items: Array<{ id: string; name: string }> } };
  const id = body.ok ? body.data?.items.find((item) => item.name === name)?.id : undefined;
  if (!id) return;
  await page.request.post(`${API_BASE}/v1/plugins/${id}/uninstall`, { headers, data: { scope: "personal" } });
  await page.request.delete(`${API_BASE}/v1/plugins/${id}`, { headers });
}

for (const policy of ["anonymous", "always"] as const) {
  test.describe(`プラグイン投稿の Turnstile（板: ${policy}）`, () => {
    test(`未ログインで、ホストの確認からサイコロのレスを書き込める`, async ({ page, request }) => {
      test.setTimeout(240_000);
      await stubTurnstile(page);
      const name = unique("ts-dice").toLowerCase();
      const slug = await createBoard(request, { turnstile: policy });
      const threadId = await createThread(request, slug, "Turnstile のテスト");
      await installDiceAnonymously(page, name);

      try {
        await page.goto(`/b/${slug}/t/${threadId}`);
        await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
        const frame = page.frameLocator(
          `[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`,
        );
        const dice = frame.getByRole("button", { name: /🎲 1d6/ });
        await expect(dice).toBeVisible({ timeout: 20_000 });
        await dice.click();

        // ホスト（iframe の外）の確認モーダル。名前欄と本文を文字として出す。
        const modal = page.getByRole("dialog");
        await expect(modal).toBeVisible({ timeout: 20_000 });
        await expect(modal).toContainText(`プラグイン「${name}」が次の内容で書き込みます`);
        await expect(modal).toContainText("!1d6");
        await expect(modal).toContainText("（サイコロ）");

        const posted = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/posts",
        );
        // Bot 確認のトークンはスタブが発行する。押せるようになるまで待つ。
        const submit = modal.getByRole("button", { name: "書き込む" });
        await expect(submit).toBeEnabled({ timeout: 20_000 });
        await submit.click();
        expect((await posted).status()).toBe(201);
        await expect(modal).toHaveCount(0, { timeout: 20_000 });

        // 保存されたレスに、サーバーが振った出目が名前に付いている。
        await page.reload();
        const postName = page.locator("#p2 .oc-post-name");
        await expect(postName).toBeVisible({ timeout: 20_000 });
        expect((await postName.textContent()) ?? "").toMatch(/【1d6:[1-6]】$/);
        await expect(page.locator("#p2")).toContainText("（サイコロ）");
      } finally {
        await cleanup(page, name);
      }
    });
  });
}

test.describe("プラグイン投稿の確認（やめる）", () => {
  test("未ログインで「やめる」を押すと、何も書き込まれない", async ({ page, request }) => {
    test.setTimeout(240_000);
    await stubTurnstile(page);
    const name = unique("ts-dice-cancel").toLowerCase();
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug, "キャンセルのテスト");
    await installDiceAnonymously(page, name);

    try {
      await page.goto(`/b/${slug}/t/${threadId}`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      // スマホ幅（390px）でもモーダルが崩れないこと。
      await page.setViewportSize({ width: 390, height: 844 });
      let posts = 0;
      page.on("request", (requestEvent) => {
        if (requestEvent.method() === "POST" && new URL(requestEvent.url()).pathname === "/api/v1/posts") posts += 1;
      });

      const frame = page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
      await frame.getByRole("button", { name: /🎲 1d6/ }).click();
      const modal = page.getByRole("dialog");
      await expect(modal).toBeVisible({ timeout: 20_000 });

      // 画面内に収まり、本文が横にはみ出さない（長い文字列は折り返す）。
      const box = await modal.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
      const overflow = await modal
        .locator('[data-testid="plugin-confirm-body"]')
        .evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await expect(modal.getByRole("button", { name: "やめる" })).toBeVisible();
      await expect(modal.getByRole("button", { name: "書き込む" })).toBeVisible();

      await modal.getByRole("button", { name: "やめる" }).click();
      await expect(modal).toHaveCount(0, { timeout: 20_000 });
      await expect(frame.getByText(/書き込みがキャンセルされました/)).toBeVisible({ timeout: 20_000 });

      // スレを読み直してもレスは増えていない。
      await page.reload();
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("#p2")).toHaveCount(0);
      expect(posts).toBe(0);
    } finally {
      await cleanup(page, name);
    }
  });
});