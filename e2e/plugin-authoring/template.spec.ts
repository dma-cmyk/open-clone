// テンプレートから作る（① コードを書かない経路）の E2E。
// 非技術者がする操作（テンプレートを選ぶ・入力する・ボタンを押す）だけで、
// 「ネタバレ伏せ」（render 系）と「サイコロ」（slot 系）が自分用プラグインとしてスレ画面で動くことを見る。
//
// 板・スレの作成だけは API で前準備する（プラグイン作成の操作はすべて UI から行う）。

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

async function loginAsTestUser(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

function waitForPost(page: Page, path: RegExp) {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname),
  );
}

/** プラグインが効くスレを 1 本作る（板は API 経由。UI 操作の対象ではない）。 */
async function createThread(
  request: APIRequestContext,
  body: string,
): Promise<{ slug: string; threadId: number; title: string }> {
  const slug = unique("tpl").toLowerCase();
  const board = await request.post(`${API_BASE}/v1/boards`, {
    headers: userHeaders(),
    data: {
      slug,
      name: `テンプレート検証板${slug.slice(-4)}`,
      category: "E2E",
      description: "テンプレートから作る E2E の検証用",
      settings: { turnstile: "off" },
    },
  });
  expect(board.status(), await board.text()).toBe(201);

  const title = `テンプレート検証スレ ${slug}`;
  const thread = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: userHeaders(),
    data: { title, body, turnstileToken: "1x00000000000000000000AA" },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const envelope = await readEnvelope<{ threadId: number }>(thread);
  if (!envelope || !envelope.ok) throw new Error("スレ作成の応答が不正です");
  return { slug, threadId: envelope.data.threadId, title };
}

async function findPluginId(request: APIRequestContext, name: string): Promise<string | null> {
  const response = await request.get(`${API_BASE}/v1/plugins?q=${encodeURIComponent(name)}`, {
    headers: { Origin: ALLOWED_ORIGIN, Cookie: `oc_sess=${USER_SESSION}` },
  });
  const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(response);
  if (!body || !body.ok) return null;
  return body.data.items.find((item) => item.name === name)?.id ?? null;
}

/** テストの後始末（導入解除 → 削除）。後続 spec の描画・スロットに残さない。 */
async function cleanupPlugin(request: APIRequestContext, name: string): Promise<void> {
  const id = await findPluginId(request, name);
  if (!id) return;
  await request.post(`${API_BASE}/v1/plugins/${id}/uninstall`, {
    headers: userHeaders(),
    data: { scope: "personal" },
  });
  await request.delete(`${API_BASE}/v1/plugins/${id}`, { headers: userHeaders() });
}

/** テンプレート一覧から 1 件選び、入力フォームを開く。 */
async function openTemplate(page: Page, templateId: string, label: string): Promise<void> {
  await page.goto("/plugins/templates/");
  const card = page.locator(`[data-template="${templateId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "これで作る" }).click();
  await expect(page.getByText(`設定: ${label}`, { exact: true })).toBeVisible();
}

test.describe("テンプレートから作る", () => {
  test.beforeEach(async ({ context }) => {
    await loginAsTestUser(context);
  });

  test("ネタバレ伏せ: 選ぶ→入力→プレビュー→保存だけで、スレ画面で黒塗りになる", async ({
    page,
    context,
    request,
  }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request, "1げっと\n[sp]主人公は実は生きていた[/sp]\nネタバレなしの雑談");
    const name = unique("spoiler-tpl");

    try {
      await openTemplate(page, "spoiler", "ネタバレ伏せ");

      // 入力（既定値のままでもよいが、名前は衝突しない一意なものにする）
      await page.getByLabel("プラグイン名").fill(name);
      await expect(page.getByLabel("開始タグ")).toHaveValue("[sp]");

      // プレビュー = 生成 + 静的検査。render 系は Worker 経由でサンプルが変換される。
      const checked = waitForPost(page, /\/api\/v1\/plugins\/preview-check$/);
      await page.getByRole("button", { name: "プレビュー" }).click();
      expect((await checked).status()).toBe(200);
      await expect(page.locator('[data-sample="hit"] .oc-plugin-render-spoiler')).toBeVisible();
      await expect(page.locator('[data-sample="long"]')).toContainText("2,048");
      await expect(page.getByText("保存できます")).toBeVisible();

      // 保存 = 既存の POST /v1/plugins → POST /install（personal）
      const created = waitForPost(page, /\/api\/v1\/plugins$/);
      const installed = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/install$/);
      await page.getByRole("button", { name: "自分用に導入して保存" }).click();
      expect((await created).status()).toBe(201);
      expect((await installed).status()).toBe(201);
      await expect(page.getByText("できました", { exact: true })).toBeVisible();
      await expect(page.getByText("自分用に導入しました").first()).toBeVisible();

      // スレ画面（同じ Worker 実行経路）で黒塗りになる
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}`);
      await expect(page.locator(".oc-plugin-render-spoiler").first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanupPlugin(request, name);
    }
  });

  test("サイコロ: フォームだけで保存・導入でき、スレのレス下にボタンが出て振れる", async ({
    page,
    context,
    request,
  }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request, "サイコロのテスト");
    const name = unique("dice-tpl");

    try {
      await openTemplate(page, "dice-button", "サイコロ／占いボタン");
      await page.getByLabel("プラグイン名").fill(name);
      await page.getByLabel("面の数").fill("6");

      const checked = waitForPost(page, /\/api\/v1\/plugins\/preview-check$/);
      await page.getByRole("button", { name: "プレビュー" }).click();
      expect((await checked).status()).toBe(200);
      await expect(page.locator('iframe[title="プラグイン プレビュー"]')).toHaveCount(1);
      await expect(page.locator('iframe[title="プラグイン プレビュー"]')).toHaveAttribute("sandbox", "allow-scripts");
      await expect(page.getByText("保存できます")).toBeVisible();

      const created = waitForPost(page, /\/api\/v1\/plugins$/);
      const installed = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/install$/);
      await page.getByRole("button", { name: "自分用に導入して保存" }).click();
      expect((await created).status()).toBe(201);
      expect((await installed).status()).toBe(201);
      await expect(page.getByText("できました", { exact: true })).toBeVisible();

      // スレ画面: thread-post-footer → post-actions に sandbox iframe でボタンが出る
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}`);
      await expect(page.locator('[data-plugin-slot="post-actions"]').first()).toBeVisible({ timeout: 15_000 });
      const frame = page.frameLocator('iframe[title$="プラグイン"]').first();
      const diceButton = frame.getByRole("button", { name: /🎲 1d6/ });
      await expect(diceButton).toBeVisible({ timeout: 15_000 });
      await diceButton.click();
      await expect(frame.getByText(/→ \d+/)).toBeVisible();
    } finally {
      await cleanupPlugin(request, name);
    }
  });

  test("名前が衝突したら 27 §6.2 の文言を出す（保存はされない）", async ({ page, context, request }) => {
    await loginAsTestUser(context);
    const name = unique("dup-tpl");

    try {
      // 1 回目は成功させる
      await openTemplate(page, "spoiler", "ネタバレ伏せ");
      await page.getByLabel("プラグイン名").fill(name);
      const created = waitForPost(page, /\/api\/v1\/plugins$/);
      await page.getByRole("button", { name: "自分用に導入して保存" }).click();
      expect((await created).status()).toBe(201);
      await expect(page.getByText("できました", { exact: true })).toBeVisible();

      // 2 回目は同じ名前で保存 → 409
      await openTemplate(page, "spoiler", "ネタバレ伏せ");
      await page.getByLabel("プラグイン名").fill(name);
      const conflict = waitForPost(page, /\/api\/v1\/plugins$/);
      await page.getByRole("button", { name: "自分用に導入して保存" }).click();
      expect((await conflict).status()).toBe(409);
      await expect(
        page.getByText("その名前はすでに使われています。別の名前にしてください"),
      ).toBeVisible();
    } finally {
      await cleanupPlugin(request, name);
    }
  });
});