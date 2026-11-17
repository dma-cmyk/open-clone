// ログイン時の端末の個人導入の引き継ぎ（レビュー 63 M1）の E2E。
//
// 匿名（端末）で「他人の公開プラグイン」を個人用に導入 → 同じブラウザで新規登録（ログイン）→
// スレでそのプラグインが見え続けること。互換 URL（/test/read.cgi/...）でも
// 板の slug が解決され `/plugins/active` が 1 回であること（レビュー 63 M2）。

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_SESSION = "e2e-owner-session-token";

function ownerHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` };
}

async function createBoardAndThread(request: APIRequestContext): Promise<{ slug: string; threadId: number }> {
  const slug = unique("dev-tr").toLowerCase();
  const board = await request.post(`${API_BASE}/v1/boards`, {
    headers: ownerHeaders(),
    data: { slug, name: `引き継ぎ板${slug.slice(-4)}`, category: "E2E", settings: { turnstile: "off" } },
  });
  expect(board.status(), await board.text()).toBe(201);
  const thread = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: ownerHeaders(),
    data: { title: `引き継ぎスレ ${slug}`, body: "端末の個人導入の引き継ぎ確認", turnstileToken: "1x00000000000000000000AA" },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const body = await readEnvelope<{ threadId: number }>(thread);
  if (!body || !body.ok) throw new Error("スレ作成に失敗しました");
  return { slug, threadId: body.data.threadId };
}

/** 所有者が公開プラグインを作る（他人のプラグインとして匿名端末から導入させる）。 */
async function createPublicPlugin(request: APIRequestContext, name: string): Promise<string> {
  const created = await request.post(`${API_BASE}/v1/plugins`, {
    headers: ownerHeaders(),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "引き継ぎ確認用の公開プラグイン",
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
        button.textContent = "PUB ${name}";
        ctx.root.appendChild(button);
        ctx.api.ui.resize(24);
      } } });`,
      visibility: "private",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await readEnvelope<{ id: string }>(created);
  if (!body || !body.ok) throw new Error("プラグイン作成に失敗しました");
  const published = await request.post(`${API_BASE}/v1/plugins/${body.data.id}/publish`, {
    headers: ownerHeaders(),
    data: { scopes: ["personal"], visibility: "public" },
  });
  expect(published.status(), await published.text()).toBe(200);
  return body.data.id;
}

async function registerInSameBrowser(page: Page, name: string): Promise<void> {
  const email = `${name}-${Date.now()}@example.com`;
  // ブラウザ自身の fetch で登録する（page.request は Secure な oc_did を送らないため、
  // 同じ端末として引き継ぎが走らない）。登録後は oc_sess Cookie もブラウザに入る。
  const status = await page.evaluate(
    async (data) => {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          // 登録の 5 回/日/IP を他 spec と取り合わない（E2E 専用 DB）。
          "x-real-ip": `198.51.100.${Math.floor(Math.random() * 250) + 2}`,
        },
        body: JSON.stringify(data),
      });
      return response.status;
    },
    { name: `${name}さん`, email, password: "p@ssw0rd123" },
  );
  expect(status).toBe(201);
}

async function cleanupPlugin(request: APIRequestContext, pluginId: string): Promise<void> {
  await request.post(`${API_BASE}/v1/plugins/${pluginId}/uninstall`, {
    headers: ownerHeaders(),
    data: { scope: "personal" },
  });
  await request.delete(`${API_BASE}/v1/plugins/${pluginId}`, { headers: ownerHeaders() });
}

/**
 * 利用者と同じ経路（/plugins/ の一覧 →「個人用に導入」）で入れる。
 * ブラウザ自身の fetch なので、その端末の oc_did（Secure Cookie）がそのまま使われる。
 */
async function installFromList(page: Page, name: string): Promise<void> {
  await page.goto("/plugins/");
  const row = page.locator("li").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const installed = page.waitForResponse(
    (response) => response.request().method() === "POST" && /\/install$/.test(new URL(response.url()).pathname),
  );
  await row.getByRole("button", { name: "個人用に導入" }).click();
  expect((await installed).status()).toBe(201);
}

/** ブラウザの Cookie で個人用導入を外す（page.request は Secure Cookie を送らないため）。 */
async function uninstallInBrowser(page: Page, pluginId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await fetch(`/api/v1/plugins/${id}/uninstall`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "personal" }),
    });
  }, pluginId);
}

function countActiveCalls(page: Page): { count: () => number } {
  let total = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/api/v1/plugins/active")) total += 1;
  });
  return { count: () => total };
}

test.describe("端末の個人導入の引き継ぎ（M1）", () => {
  test("匿名で入れた他人の公開プラグインが、ログイン後もスレで見える", async ({ page, request }) => {
    test.setTimeout(180_000);
    const name = unique("dev-pub").toLowerCase();
    const pluginId = await createPublicPlugin(request, name);
    const thread = await createBoardAndThread(request);

    try {
      // 1. 匿名ブラウザでスレを開いた後、利用者と同じ経路（一覧の「個人用に導入」）で入れる。
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      await installFromList(page, name);

      // 2. ログイン前（端末所有）でも見える。
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      const frame = page.frameLocator('iframe[title$="プラグイン"]').first();
      await expect(frame.getByRole("button", { name: `PUB ${name}`, exact: true })).toBeVisible({
        timeout: 20_000,
      });

      // 3. 同じブラウザ（同じ oc_did）で新規登録 = ログイン。引き継ぎは同期で走る。
      await registerInSameBrowser(page, name);

      // 4. ログイン後（アカウントの導入）でも同じスレで見える。
      await page.goto(`/b/${thread.slug}/t/${thread.threadId}?r=l50`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      const afterLogin = page.frameLocator('iframe[title$="プラグイン"]').first();
      await expect(afterLogin.getByRole("button", { name: `PUB ${name}`, exact: true })).toBeVisible({
        timeout: 20_000,
      });

      // /plugins/active もアカウントの個人導入として返す（ブラウザのセッションで確認）。
      const items = await page.evaluate(async () => {
        const response = await fetch("/api/v1/plugins/active", { credentials: "include" });
        const body = (await response.json()) as { data?: { items?: Array<{ pluginId: string; scopeRef: string }> } };
        return body.data?.items ?? [];
      });
      const item = items.find((entry) => entry.pluginId === pluginId);
      expect(item?.scopeRef ?? "").not.toMatch(/^device:/);
    } finally {
      // ログイン後のアカウント導入も外してから削除する（他の導入が残ると削除できない）。
      await uninstallInBrowser(page, pluginId).catch(() => undefined);
      await cleanupPlugin(request, pluginId);
    }
  });

  test("互換 URL でも板が解決され、/plugins/active は 1 回", async ({ page, request }) => {
    test.setTimeout(180_000);
    const name = unique("dev-compat").toLowerCase();
    const pluginId = await createPublicPlugin(request, name);
    const thread = await createBoardAndThread(request);
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3265");
    await page.context().addCookies([
      { name: "oc_sess", value: OWNER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);

    try {
      // 所有者（ログイン中）が、利用者と同じ経路（一覧の「個人用に導入」）で入れる。
      await installFromList(page, name);

      const active = countActiveCalls(page);
      await page.goto(`/test/read.cgi/${thread.slug}/${thread.threadId}/`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      await expect(page.frameLocator('iframe[title$="プラグイン"]').first().getByRole("button", {
        name: `PUB ${name}`,
        exact: true,
      })).toBeVisible({ timeout: 20_000 });
      // スレ側とサイドバーで条件が揃い、取得は 1 回。
      expect(active.count()).toBe(1);
    } finally {
      await uninstallInBrowser(page, pluginId).catch(() => undefined);
      await cleanupPlugin(request, pluginId);
    }
  });
});