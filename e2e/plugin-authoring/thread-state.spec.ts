// スレごとの共有値テンプレート（tally / choice / entries）の E2E。
// 3 テンプレートを UI から作り、板スコープへ導入し、2 人（ログイン + 未ログインの別文脈）で
// 互いの操作が反映されることを確かめる。entries は HTML を文字として表示することも見る。
//
// 板・スレの作成だけ API で前準備する（プラグイン作成の操作は UI から行う）。

import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, WEB_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";

function userHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, Cookie: `oc_sess=${USER_SESSION}`, "content-type": "application/json" };
}

async function loginAsTestUser(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(WEB_BASE);
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

function waitForPost(page: Page, path: RegExp) {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname),
  );
}

/** プラグインが効く板・スレを 1 本作る（UI 操作の対象ではない）。 */
async function createThread(request: APIRequestContext): Promise<{ slug: string; boardId: number; threadId: number }> {
  const slug = unique("thstate").toLowerCase();
  const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
    headers: userHeaders(),
    data: {
      slug,
      name: `共有値検証板${slug.slice(-4)}`,
      category: "E2E",
      description: "スレごとの共有値の検証用",
      settings: { turnstile: "off" },
    },
  });
  expect(boardResponse.status(), await boardResponse.text()).toBe(201);
  const board = await readEnvelope<{ board: { id: number } }>(boardResponse);
  if (!board || !board.ok) throw new Error("板作成の応答が不正です");

  const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: userHeaders(),
    data: { title: `共有値のスレ ${slug}`, body: "1げっと", turnstileToken: "1x00000000000000000000AA" },
  });
  expect(threadResponse.status(), await threadResponse.text()).toBe(201);
  const thread = await readEnvelope<{ threadId: number }>(threadResponse);
  if (!thread || !thread.ok) throw new Error("スレ作成の応答が不正です");
  return { slug, boardId: board.data.board.id, threadId: thread.data.threadId };
}

async function findPluginId(request: APIRequestContext, name: string): Promise<string | null> {
  const response = await request.get(`${API_BASE}/v1/plugins?mine=1&q=${encodeURIComponent(name)}`, {
    headers: userHeaders(),
  });
  const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(response);
  if (!body || !body.ok) return null;
  return body.data.items.find((item) => item.name === name)?.id ?? null;
}

async function installToBoard(request: APIRequestContext, pluginId: string, boardId: number): Promise<void> {
  // 個人用導入を外してから板へ導入する（/active が二重になり、スロットが 2 つ出るのを避ける）。
  const uninstall = await request.post(`${API_BASE}/v1/plugins/${pluginId}/uninstall`, {
    headers: userHeaders(),
    data: { scope: "personal" },
  });
  expect(uninstall.status(), await uninstall.text()).toBe(200);

  // 板公開は審査不要（site を含めない）。承認済み版にしてから板へ導入する。
  const published = await request.post(`${API_BASE}/v1/plugins/${pluginId}/publish`, {
    headers: userHeaders(),
    data: { scopes: ["personal", "board"], visibility: "unlisted" },
  });
  expect(published.status(), await published.text()).toBe(200);

  const installed = await request.post(`${API_BASE}/v1/plugins/${pluginId}/install`, {
    headers: userHeaders(),
    data: { scope: "board", boardId },
  });
  expect(installed.status(), await installed.text()).toBe(201);
}

async function cleanupPlugin(request: APIRequestContext, name: string, boardId: number): Promise<void> {
  const pluginId = await findPluginId(request, name);
  if (!pluginId) return;
  await request.post(`${API_BASE}/v1/plugins/${pluginId}/uninstall`, {
    headers: userHeaders(),
    data: { scope: "board", boardId },
  });
  await request.delete(`${API_BASE}/v1/plugins/${pluginId}`, { headers: userHeaders() });
}

/** テンプレートから作り、ほかの文脈からも見えるよう板スコープへ導入する。 */
async function createAndInstall(
  page: Page,
  request: APIRequestContext,
  input: { templateId: string; label: string; name: string; boardId: number },
): Promise<void> {
  await page.goto("/plugins/templates/");
  const card = page.locator(`[data-template="${input.templateId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "これで作る" }).click();
  await expect(page.getByText(`設定: ${input.label}`, { exact: true })).toBeVisible();
  await page.getByLabel("プラグイン名").fill(input.name);

  const created = waitForPost(page, /\/api\/v1\/plugins$/);
  const installed = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/install$/);
  await page.getByRole("button", { name: "自分用に導入して保存" }).click();
  expect((await created).status()).toBe(201);
  expect((await installed).status()).toBe(201);
  await expect(page.getByText("できました", { exact: true })).toBeVisible();

  const pluginId = await findPluginId(request, input.name);
  if (!pluginId) throw new Error(`プラグイン ${input.name} が見つかりません`);
  await installToBoard(request, pluginId, input.boardId);
}

async function openThread(page: Page, slug: string, threadId: number): Promise<void> {
  await page.goto(`${WEB_BASE}/b/${slug}/t/${threadId}`);
}

/** 未ログインの別文脈を作る（Cookie を共有しない）。 */
async function openAnonymous(browser: Browser, slug: string, threadId: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openThread(page, slug, threadId);
  return { context, page };
}

test.describe("手で編集する経路でも threadState を保つ", () => {
  test.beforeEach(async ({ context }) => {
    await loginAsTestUser(context);
  });

  /** テンプレート →「コードを見る・手で編集する」→ 保存 → 個人用に導入。 */
  async function saveFromEditor(
    page: Page,
    request: APIRequestContext,
    input: { templateId: string; label: string; name: string },
  ): Promise<string> {
    await page.goto("/plugins/templates/");
    const card = page.locator(`[data-template="${input.templateId}"]`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "これで作る" }).click();
    await expect(page.getByText(`設定: ${input.label}`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "コードを見る・手で編集する" }).click();
    await expect(page).toHaveURL(/\/plugins\/new\/?\?from=template/);
    // 下書きの読み込み（mount 後の effect）が終わってから名前を変える。
    // 先に変えると、後から走る effect がテンプレート既定名で上書きしてしまう。
    await expect(page.getByText("テンプレートの内容を読み込みました", { exact: false })).toBeVisible();

    await page.getByLabel("名前（slug・変更不可）").fill(input.name);
    const saved = waitForPost(page, /\/api\/v1\/plugins$/);
    await page.getByRole("button", { name: "保存（下書き）" }).click();
    // threadState が落ちると manifest 検査で 400 になる（M2）。
    expect((await saved).status()).toBe(201);
    await expect(page.getByText(/保存しました/)).toBeVisible();

    const pluginId = await findPluginId(request, input.name);
    if (!pluginId) throw new Error(`プラグイン ${input.name} が見つかりません`);
    const installed = await request.post(`${API_BASE}/v1/plugins/${pluginId}/install`, {
      headers: userHeaders(),
      data: { scope: "personal" },
    });
    expect(installed.status(), await installed.text()).toBe(201);
    return pluginId;
  }

  test("人数カウンタ: 手で編集して保存しても動く", async ({ page, context, request }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request);
    const name = unique("tally-edit");

    try {
      await saveFromEditor(page, request, {
        templateId: "tally",
        label: "人数カウンタ（参加・いいね）",
        name,
      });
      await openThread(page, thread.slug, thread.threadId);
      const frame = page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      await expect(frame.getByRole("button", { name: /参加する/ })).toBeVisible({ timeout: 15_000 });
      await frame.getByRole("button", { name: /参加する/ }).click();
      await expect(frame.getByText("1 人")).toBeVisible();
    } finally {
      const pluginId = await findPluginId(request, name);
      if (pluginId) {
        await request.post(`${API_BASE}/v1/plugins/${pluginId}/uninstall`, {
          headers: userHeaders(),
          data: { scope: "personal" },
        });
      }
      await cleanupPlugin(request, name, thread.boardId);
    }
  });

  test("アンケート: 手で編集して保存しても動く", async ({ page, context, request }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request);
    const name = unique("choice-edit");

    try {
      await saveFromEditor(page, request, {
        templateId: "choice",
        label: "スレのアンケート",
        name,
      });
      await openThread(page, thread.slug, thread.threadId);
      const frame = page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      await expect(frame.getByText("どれが好き？", { exact: true })).toBeVisible({ timeout: 15_000 });
      await frame.getByRole("button", { name: "はい（0）" }).click();
      await expect(frame.getByRole("button", { name: "はい（1）" })).toBeVisible();
    } finally {
      const pluginId = await findPluginId(request, name);
      if (pluginId) {
        await request.post(`${API_BASE}/v1/plugins/${pluginId}/uninstall`, {
          headers: userHeaders(),
          data: { scope: "personal" },
        });
      }
      await cleanupPlugin(request, name, thread.boardId);
    }
  });

  test("一言リスト: 手で編集して保存しても動く", async ({ page, context, request }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request);
    const name = unique("entries-edit");

    try {
      await saveFromEditor(page, request, {
        templateId: "entries",
        label: "参加表明・一言リスト",
        name,
      });
      await openThread(page, thread.slug, thread.threadId);
      const frame = page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
      const input = frame.locator('input[type="text"]');
      await expect(input).toBeVisible({ timeout: 15_000 });
      await input.fill("手書き経路の書き込み");
      await frame.getByRole("button", { name: /ひとこと書く/ }).click();
      await expect(frame.getByText("手書き経路の書き込み")).toBeVisible();
    } finally {
      const pluginId = await findPluginId(request, name);
      if (pluginId) {
        await request.post(`${API_BASE}/v1/plugins/${pluginId}/uninstall`, {
          headers: userHeaders(),
          data: { scope: "personal" },
        });
      }
      await cleanupPlugin(request, name, thread.boardId);
    }
  });
});

test.describe("スレごとの共有値テンプレート", () => {
  test.beforeEach(async ({ context }) => {
    await loginAsTestUser(context);
  });

  test("人数カウンタ: 2 人の押下が同じスレで反映される", async ({ page, context, browser, request }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request);
    const name = unique("tally-tpl");
    let anon: { context: BrowserContext; page: Page } | null = null;

    try {
      await createAndInstall(page, request, {
        templateId: "tally",
        label: "人数カウンタ（参加・いいね）",
        name,
        boardId: thread.boardId,
      });

      await openThread(page, thread.slug, thread.threadId);
      const frame = page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      const join = frame.getByRole("button", { name: /参加する/ });
      await expect(join).toBeVisible({ timeout: 15_000 });
      await join.click();
      await expect(frame.getByRole("button", { name: /参加済み/ })).toBeVisible();
      await expect(frame.getByText("1 人")).toBeVisible();

      anon = await openAnonymous(browser, thread.slug, thread.threadId);
      const anonFrame = anon.page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      await expect(anonFrame.getByText("1 人")).toBeVisible({ timeout: 15_000 });
      await anonFrame.getByRole("button", { name: /参加する/ }).click();
      await expect(anonFrame.getByText("2 人")).toBeVisible();

      await page.reload();
      const reloaded = page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      await expect(reloaded.getByText("2 人")).toBeVisible({ timeout: 15_000 });
      await expect(reloaded.getByRole("button", { name: /参加済み/ })).toBeVisible();
    } finally {
      await anon?.context.close();
      await cleanupPlugin(request, name, thread.boardId);
    }
  });

  test("アンケート: ログインの投票が未ログインの画面にも集計として出る", async ({ page, context, browser, request }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request);
    const name = unique("choice-tpl");
    let anon: { context: BrowserContext; page: Page } | null = null;

    try {
      await createAndInstall(page, request, {
        templateId: "choice",
        label: "スレのアンケート",
        name,
        boardId: thread.boardId,
      });

      await openThread(page, thread.slug, thread.threadId);
      const frame = page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      await expect(frame.getByText("どれが好き？", { exact: true })).toBeVisible({ timeout: 15_000 });
      await frame.getByRole("button", { name: "はい（0）" }).click();
      await expect(frame.getByRole("button", { name: "はい（1）" })).toBeVisible();
      await expect(frame.getByText(/合計 1 票/)).toBeVisible();

      anon = await openAnonymous(browser, thread.slug, thread.threadId);
      const anonFrame = anon.page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      await expect(anonFrame.getByRole("button", { name: "はい（1）" })).toBeVisible({ timeout: 15_000 });
      await expect(anonFrame.getByText(/合計 1 票/)).toBeVisible();

      // 取り消しも相手に反映される
      await frame.getByRole("button", { name: "はい（1）" }).click();
      await expect(frame.getByRole("button", { name: "はい（0）" })).toBeVisible();
      await anon.page.reload();
      const anonReloaded = anon.page.frameLocator(`[data-plugin-slot="thread-top"] iframe[title="${name} プラグイン"]`);
      await expect(anonReloaded.getByRole("button", { name: "はい（0）" })).toBeVisible({ timeout: 15_000 });
    } finally {
      await anon?.context.close();
      await cleanupPlugin(request, name, thread.boardId);
    }
  });

  test("一言リスト: 互いの書き込みが見え、HTML は文字として表示される", async ({ page, context, browser, request }) => {
    await loginAsTestUser(context);
    const thread = await createThread(request);
    const name = unique("entries-tpl");
    const xss = '<img src=x onerror="window.__ocPwned=1">';
    let anon: { context: BrowserContext; page: Page } | null = null;

    try {
      await createAndInstall(page, request, {
        templateId: "entries",
        label: "参加表明・一言リスト",
        name,
        boardId: thread.boardId,
      });

      await openThread(page, thread.slug, thread.threadId);
      const frame = page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
      const input = frame.locator('input[type="text"]');
      await expect(input).toBeVisible({ timeout: 15_000 });
      await input.fill("ログイン側の書き込み");
      await frame.getByRole("button", { name: /ひとこと書く/ }).click();
      await expect(frame.getByText("ログイン側の書き込み")).toBeVisible();

      anon = await openAnonymous(browser, thread.slug, thread.threadId);
      const anonFrame = anon.page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
      await expect(anonFrame.getByText("ログイン側の書き込み")).toBeVisible({ timeout: 15_000 });

      const anonInput = anonFrame.locator('input[type="text"]');
      await anonInput.fill(xss);
      await anonFrame.getByRole("button", { name: /ひとこと書く/ }).click();
      await expect(anonFrame.getByText(xss, { exact: true })).toBeVisible();

      await page.reload();
      const reloaded = page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
      await expect(reloaded.getByText(xss, { exact: true })).toBeVisible({ timeout: 15_000 });
      // textContent 表示なので img 要素にならない（onerror も動かない）
      await expect(reloaded.locator("img")).toHaveCount(0);
      const pwned = await reloaded.locator("body").evaluate(() => Reflect.get(window, "__ocPwned") ?? null);
      expect(pwned).toBeNull();
    } finally {
      await anon?.context.close();
      await cleanupPlugin(request, name, thread.boardId);
    }
  });
});