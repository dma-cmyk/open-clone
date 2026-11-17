// プラグインの表示場所（スロット）の E2E。
//
// 設計 60 の直し方 4:
//  - テンプレート「サイコロ／占いボタン」を「各レスの下」（thread-post-footer）と
//    「スレ下部に 1 つ」（thread-bottom）で個人用に導入 → スレでボタンが出る → 押すと結果が出る
//  - ログインなし（端末所有）とログインありの両方
//  - 1000 レスのスレでも iframe は画面に近いレスだけ / `/plugins/active` はページで 1 回
//  - 未設置だった post-form-extra・thread-nav・board-sidebar に実際に出る

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_SESSION = "e2e-owner-session-token";

function ownerHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` };
}

async function login(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3265");
  await context.addCookies([
    { name: "oc_sess", value: OWNER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function createThread(
  request: APIRequestContext,
  options: { posts?: number } = {},
): Promise<{ slug: string; threadId: number; title: string }> {
  const slug = unique("slots").toLowerCase();
  const title = `表示場所スレ ${slug}`;
  const board = await request.post(`${API_BASE}/v1/boards`, {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `表示場所板${slug.slice(-4)}`,
      category: "E2E",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(board.status(), await board.text()).toBe(201);
  const thread = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: ownerHeaders(),
    data: {
      title,
      body: "サイコロの表示場所を確認するスレです",
      turnstileToken: "1x00000000000000000000AA",
    },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const envelope = await readEnvelope<{ threadId: number }>(thread);
  if (!envelope || !envelope.ok) throw new Error("スレ作成に失敗しました");

  const posts = options.posts ?? 0;
  // 連投のレート制限は端末単位。端末 Cookie を毎回変えて作る（E2E 専用 DB・本番の制限は不変）。
  const batch = 10;
  for (let start = 0; start < posts; start += batch) {
    const results = await Promise.all(
      Array.from({ length: Math.min(batch, posts - start) }, (_unused, offset) => {
        const deviceId = Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
        return request.post(`${API_BASE}/v1/threads/${envelope.data.threadId}/posts`, {
          headers: {
            Origin: ALLOWED_ORIGIN,
            "content-type": "application/json",
            Cookie: `oc_sess=${OWNER_SESSION}; oc_did=${deviceId}`,
          },
          data: { body: `性能確認用のレス ${start + offset + 1}` },
        });
      }),
    );
    for (const result of results) expect(result.status(), await result.text()).toBe(201);
  }
  return { slug, threadId: envelope.data.threadId, title };
}

async function postIds(request: APIRequestContext, threadId: number): Promise<number[]> {
  const response = await request.get(`${API_BASE}/v1/threads/${threadId}?r=1-1000`, {
    headers: { Origin: ALLOWED_ORIGIN, Cookie: `oc_sess=${OWNER_SESSION}` },
  });
  const body = await readEnvelope<{ posts: Array<{ id: number; num: number }> }>(response);
  if (!body || !body.ok) throw new Error("スレ取得に失敗しました");
  return body.data.posts.map((post) => post.id);
}

/** テンプレートからサイコロを作り、表示場所を選んで個人用に導入する。 */
async function installDiceFromTemplate(page: Page, name: string, slotLabel?: string): Promise<void> {
  await page.goto("/plugins/templates/");
  const card = page.locator("section[data-template='dice-button']");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "これで作る" }).click();
  await expect(page.getByLabel("プラグイン名")).toBeVisible();
  await page.getByLabel("プラグイン名").fill(name);
  if (slotLabel) await page.getByLabel("表示場所").selectOption({ label: slotLabel });
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

/**
 * テストで作ったプラグインを片付ける。
 * 匿名（端末所有）はブラウザの Cookie が持ち主なので page.request を使う。
 */
async function cleanupInstall(
  request: APIRequestContext,
  name: string,
  cookie: string | undefined,
): Promise<void> {
  const headers: Record<string, string> = { Origin: ALLOWED_ORIGIN };
  if (cookie) headers.Cookie = cookie;
  const list = await request.get(`${API_BASE}/v1/plugins?q=${encodeURIComponent(name)}&mine=true`, { headers });
  const body = await readEnvelope<{ items: Array<{ id: string; name: string }> }>(list);
  const id = body?.ok ? body.data.items.find((item) => item.name === name)?.id : undefined;
  if (!id) return;
  await request.post(`${API_BASE}/v1/plugins/${id}/uninstall`, { headers, data: { scope: "personal" } });
  await request.delete(`${API_BASE}/v1/plugins/${id}`, { headers });
}

/** スレ画面を開いてから、`/api/v1/plugins/active` の呼び出し回数を数える。 */
function countActiveCalls(page: Page): { count: () => number } {
  let total = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/v1/plugins/active")) total += 1;
  });
  return { count: () => total };
}

test.describe("プラグインの表示場所", () => {
  test("各レスの下: ログインなしでもサイコロがレスごとに出て振れる", async ({ page, request }) => {
    test.setTimeout(180_000);
    const name = unique("slot-anon").toLowerCase();
    const thread = await createThread(request);
    await installDiceFromTemplate(page, name);
    try {
      const active = countActiveCalls(page);
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-plugin-slot="post-actions"]').first()).toBeVisible({ timeout: 20_000 });

      const frame = page.frameLocator('iframe[title$="プラグイン"]').first();
      const dice = frame.getByRole("button", { name: /🎲 1d6/ });
      await expect(dice).toBeVisible({ timeout: 20_000 });
      await dice.click();
      await expect(frame.getByText(/→ \d+/)).toBeVisible();

      // 取得はページで 1 回（レスごとに /plugins/active を呼ばない）。
      expect(active.count()).toBe(1);
    } finally {
      await cleanupInstall(page.request, name, undefined);
    }
  });

  test("スレ下部に 1 つ: ログインありで 1 個だけ出て、各レスの下には出ない", async ({ page, context, request }) => {
    test.setTimeout(180_000);
    await login(context);
    const name = unique("slot-bottom").toLowerCase();
    const thread = await createThread(request);
    await installDiceFromTemplate(page, name, "スレ下部に 1 つ");
    try {
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      const bottom = page.locator('[data-plugin-slot="thread-bottom"]');
      await expect(bottom).toBeVisible({ timeout: 20_000 });
      await expect(bottom.locator('iframe[title$="プラグイン"]')).toHaveCount(1);
      // 宣言していないスロットには DOM を作らない。
      await expect(page.locator('[data-plugin-slot="post-actions"]')).toHaveCount(0);

      const frame = page.frameLocator('[data-plugin-slot="thread-bottom"] iframe').first();
      await frame.getByRole("button", { name: /🎲 1d6/ }).click();
      await expect(frame.getByText(/→ \d+/)).toBeVisible();
    } finally {
      await cleanupInstall(request, name, `oc_sess=${OWNER_SESSION}`);
    }
  });

  test("post-form-extra・thread-nav・board-sidebar に導入したプラグインが出る", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(180_000);
    await login(context);
    const name = unique("slot-three").toLowerCase();
    const thread = await createThread(request);
    const code = `register({ slots: {
      "post-form-after": function (ctx) { ctx.root.textContent = "SLOT:post-form-after"; ctx.api.ui.resize(20); },
      "thread-nav": function (ctx) { ctx.root.textContent = "SLOT:thread-nav"; ctx.api.ui.resize(20); },
      "sidebar": function (ctx) { ctx.root.textContent = "SLOT:sidebar"; ctx.api.ui.resize(20); }
    } });`;
    const created = await request.post(`${API_BASE}/v1/plugins`, {
      headers: ownerHeaders(),
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "表示場所の確認",
          scope: ["personal"],
          permissions: ["ui:slot"],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: ["post-form-after", "thread-nav", "sidebar"],
          hooks: [],
        },
        code,
        visibility: "private",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdBody = await readEnvelope<{ id: string }>(created);
    if (!createdBody || !createdBody.ok) throw new Error("プラグイン作成に失敗しました");
    const installed = await request.post(`${API_BASE}/v1/plugins/${createdBody.data.id}/install`, {
      headers: ownerHeaders(),
      data: { scope: "personal" },
    });
    expect(installed.status(), await installed.text()).toBe(201);

    try {
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      const extra = page.locator('[data-plugin-slot="post-form-extra"]');
      const nav = page.locator('[data-plugin-slot="thread-nav"]');
      const sidebar = page.locator('[data-plugin-slot="board-sidebar"]');
      await expect(extra).toHaveCount(1);
      await expect(nav).toHaveCount(1);
      await expect(sidebar).toHaveCount(1);
      // PC ではサイドバーが見えている（モバイルは CSS で非表示なので DOM の存在だけ見る）。
      if (test.info().project.name !== "mobile") {
        await expect(sidebar).toBeVisible();
      }
      await expect(
        page.frameLocator('[data-plugin-slot="thread-nav"] iframe').first().getByText("SLOT:thread-nav", { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
    } finally {
      await cleanupInstall(request, name, `oc_sess=${OWNER_SESSION}`);
    }
  });

  test("1000 レス: iframe は画面に近いレスだけ / 取得は 1 回", async ({ page, context, request }) => {
    test.setTimeout(300_000);
    await login(context);
    const name = unique("slot-many").toLowerCase();
    const thread = await createThread(request, { posts: 999 });
    const ids = await postIds(request, thread.threadId);
    expect(ids.length).toBe(1000);

    const created = await request.post(`${API_BASE}/v1/plugins`, {
      headers: ownerHeaders(),
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "レスごとの表示",
          scope: ["personal"],
          permissions: ["ui:slot"],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: ["thread-post-footer"],
          hooks: [],
        },
        code: `register({ slots: { "thread-post-footer": function (ctx) {
          var button = document.createElement("button");
          button.type = "button";
          button.textContent = "🎲 " + ctx.data.post.id;
          ctx.root.appendChild(button);
          ctx.api.ui.resize(24);
        } } });`,
        visibility: "private",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdBody = await readEnvelope<{ id: string }>(created);
    if (!createdBody || !createdBody.ok) throw new Error("プラグイン作成に失敗しました");
    const installed = await request.post(`${API_BASE}/v1/plugins/${createdBody.data.id}/install`, {
      headers: ownerHeaders(),
      data: { scope: "personal" },
    });
    expect(installed.status(), await installed.text()).toBe(201);

    try {
      const active = countActiveCalls(page);
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=1-1000`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 30_000 });
      // 全レス分の監視点はあるが、iframe は画面に近いものだけ。
      await expect(page.locator("[data-plugin-post-id]")).toHaveCount(1000, { timeout: 30_000 });
      await expect(page.locator(`[data-plugin-post-id="${ids[0]}"] iframe`)).toHaveCount(1, {
        timeout: 20_000,
      });
      await expect(page.locator(`[data-plugin-post-id="${ids[999]}"] iframe`)).toHaveCount(0);
      const loaded = await page.locator('iframe[title$="プラグイン"]').count();
      expect(loaded).toBeLessThan(100);
      expect(active.count()).toBe(1);

      // 末尾までスクロールすると、その近くのレスだけ起動する。
      await page.locator("#p1000").scrollIntoViewIfNeeded();
      await expect(page.locator(`[data-plugin-post-id="${ids[999]}"] iframe`)).toHaveCount(1, {
        timeout: 20_000,
      });
      const afterScroll = await page.locator('iframe[title$="プラグイン"]').count();
      expect(afterScroll).toBeLessThan(200);
      expect(active.count()).toBe(1);
    } finally {
      await cleanupInstall(request, name, `oc_sess=${OWNER_SESSION}`);
    }
  });
});