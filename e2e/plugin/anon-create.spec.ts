// 匿名でのプラグイン作成（報告 40 設計・報告 41 続き）の E2E。
//
// Cookie だけの匿名ブラウザで:
//   テンプレート「キーワード装飾」→「自分用に導入して保存」→実スレで効果
//   →エディタで編集して新しい版→削除。
// 注意文の表示、板用・サイト全体を押せないこと、別ブラウザコンテキストから
// 見えないことも確認する。

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

async function seedBoardAndThread(request: APIRequestContext): Promise<{ slug: string; name: string; threadId: number }> {
  const slug = unique("anon-e2e").toLowerCase();
  const name = `匿名E2E板${slug.slice(-4)}`;
  const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      Cookie: `oc_sess=e2e-owner-session-token`,
    },
    data: {
      slug,
      name,
      category: "E2E",
      description: "匿名作成 E2E 用",
      settings: { turnstile: "off" },
    },
  });
  expect(boardResponse.status(), await boardResponse.text()).toBe(201);

  const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      Cookie: `oc_sess=e2e-owner-session-token`,
    },
    data: {
      title: `匿名作成スレ ${slug}`,
      body: "1げっと\n重要なお知らせ: これはテストです",
      turnstileToken: "1x00000000000000000000AA",
    },
  });
  expect(threadResponse.status(), await threadResponse.text()).toBe(201);
  const thread = await readEnvelope<{ threadId: number }>(threadResponse);
  if (!thread || !thread.ok) throw new Error("スレ作成の応答が不正です");
  return { slug, name, threadId: thread.data.threadId };
}

test.describe("匿名でのプラグイン作成（テンプレートから削除まで）", () => {
  test("テンプレート「キーワード装飾」→保存→実スレ効果→編集→新版→削除", async ({
    page,
    browser,
    request,
  }) => {
    test.setTimeout(180_000);

    // 1. Cookie なしの匿名ブラウザでテンプレート画面を開く
    const context = await browser.newContext();
    const anonPage = await context.newPage();

    await anonPage.goto("/plugins/templates/");
    // 注意文が表示される
    await expect(
      anonPage.getByText("ログインせずに保存したプラグインは、このブラウザでだけ編集できます"),
    ).toBeVisible();

    // 2. 「キーワード装飾」テンプレートを選ぶ（data-template 属性で直接指定）
    const templateCard = anonPage.locator("section[data-template='keyword-deco']");
    await expect(templateCard).toBeVisible();
    await templateCard.getByRole("button", { name: "これで作る" }).click();
    // 選択後のフォームが表示される（目立たせたい語のラベル）
    await expect(anonPage.getByText("目立たせたい語")).toBeVisible();

    // 名前を一意に変更（他の匿名 E2E と衝突しない）
    const pluginName = unique("kw").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 41);
    const nameInput = anonPage.getByLabel(/プラグイン名/);
    await nameInput.fill(pluginName);
    // 「目立たせたい語」は既定値「重要」を使う（実スレ本文に含める）

    // 3. プレビュー＋静的検査
    await anonPage.getByRole("button", { name: "プレビュー" }).click();
    await expect(anonPage.getByText("保存できます")).toBeVisible({ timeout: 15_000 });

    // 4. 「自分用に導入して保存」
    const saved = anonPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" && /\/api\/v1\/plugins$/.test(new URL(response.url()).pathname),
    );
    await anonPage.getByRole("button", { name: "自分用に導入して保存" }).click();
    const savedResponse = await saved;
    expect(savedResponse.status(), await savedResponse.text()).toBe(201);
    const savedBody = (await savedResponse.json()) as { ok?: boolean; data?: { id: string } };
    expect(savedBody.ok).toBe(true);
    const pluginId = savedBody.data!.id;
    await expect(anonPage.getByText(/自分用に導入しました/)).toBeVisible();

    // 5. 実スレで効果を確認（「重要」が装飾される）
    const { slug, threadId } = await seedBoardAndThread(request);
    await anonPage.goto(`/b/${slug}/t/${threadId}`);
    await expect(anonPage.locator("#p1")).toBeVisible({ timeout: 15_000 });
    // キーワード装飾の結果（oc-plugin-render-* クラス）が現れる
    await expect(anonPage.locator("#p1 [class*='oc-plugin-render']").first()).toBeVisible({
      timeout: 15_000,
    });

    // 6. エディタで編集して新しい版
    await anonPage.goto(`/plugins/new/?id=${encodeURIComponent(pluginId)}`);
    // 匿名向けの注意文
    await expect(
      anonPage.getByText("ログインせずに保存したプラグインは、このブラウザでだけ編集できます"),
    ).toBeVisible();
    await expect(anonPage.getByText(`「${pluginName}」の新バージョンを作成します`)).toBeVisible({
      timeout: 15_000,
    });
    // 板用・サイト全体のスコープが押せない（ネストされた label に exact で特定）
    const boardCheckbox = anonPage.getByRole("checkbox", { name: "板用", exact: true });
    await expect(boardCheckbox).toBeDisabled();
    const siteCheckbox = anonPage.getByRole("checkbox", { name: "サイト全体", exact: true });
    await expect(siteCheckbox).toBeDisabled();
    // net:fetch 等の禁止権限も押せない
    const netCheckbox = anonPage.getByRole("checkbox", { name: "net:fetch", exact: true });
    await expect(netCheckbox).toBeDisabled();

    // 新しい版を保存
    const versionSaved = anonPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith(`/v1/plugins/${pluginId}/versions`),
    );
    await anonPage.getByRole("button", { name: /新バージョンを保存/ }).click();
    const versionResponse = await versionSaved;
    expect(versionResponse.status(), await versionResponse.text()).toBe(201);

    // 7. 削除（確認ダイアログ）
    await anonPage.goto(`/plugins/view/?id=${encodeURIComponent(pluginId)}`);
    await anonPage.getByRole("button", { name: /削除（レジストリから消す）/ }).click();
    const dialog = anonPage.getByRole("alertdialog", { name: "プラグインの削除確認" });
    await expect(dialog).toBeVisible();
    const deleted = anonPage.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname.endsWith(`/v1/plugins/${pluginId}`),
    );
    await dialog.getByRole("button", { name: "削除する" }).click();
    expect((await deleted).status()).toBe(200);

    // 8. 別のブラウザコンテキストからは見えない（最初に作り直して確認）
    // 削除済みなので、新しくもう 1 つ作る（API で簡易に）
    const recreated = await request.post(`${API_BASE}/v1/plugins`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: "oc_did=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      data: {
        manifest: {
          name: `${pluginName}-b`,
          version: "1.0.0",
          summary: "別端末からの可視性確認",
          scope: ["personal"],
          permissions: [],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: [],
          hooks: [],
        },
        code: "register({});",
        visibility: "private",
      },
    });
    expect(recreated.status(), await recreated.text()).toBe(201);
    const recreatedBody = await readEnvelope<{ id: string }>(recreated);
    const otherPluginId = recreatedBody && recreatedBody.ok ? recreatedBody.data.id : "";

    // 元の匿名ブラウザからは 404
    const hidden = await anonPage.request.get(`${API_BASE}/v1/plugins/${otherPluginId}`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(hidden.status()).toBe(404);

    // 別端末の自分には見える
    const visible = await request.get(`${API_BASE}/v1/plugins/${otherPluginId}`, {
      headers: { Origin: ALLOWED_ORIGIN, Cookie: "oc_did=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    });
    expect(visible.status()).toBe(200);

    // 後始末
    await request.delete(`${API_BASE}/v1/plugins/${otherPluginId}`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: "oc_did=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    });
    await context.close();
  });

  test("板管理人・一般アカウントからは端末所有が 404", async ({ request }) => {
    test.setTimeout(60_000);
    // 匿名端末で作成
    const deviceCookie = "oc_did=dddddddddddddddddddddddddddddddd";
    const created = await request.post(`${API_BASE}/v1/plugins`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: deviceCookie },
      data: {
        manifest: {
          name: unique("hidden").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 41),
          version: "1.0.0",
          summary: "可視性確認",
          scope: ["personal"],
          permissions: [],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: [],
          hooks: [],
        },
        code: "register({});",
        visibility: "private",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdEnvelope = await readEnvelope<{ id: string }>(created);
    const pluginId = createdEnvelope && createdEnvelope.ok ? createdEnvelope.data.id : "";

    // 一般アカウントからは 404
    const userDetail = await request.get(`${API_BASE}/v1/plugins/${pluginId}`, {
      headers: { Origin: ALLOWED_ORIGIN, Cookie: `oc_sess=${USER_SESSION}` },
    });
    expect(userDetail.status()).toBe(404);

    // owner（サイト運営）からは見える
    const ownerDetail = await request.get(`${API_BASE}/v1/plugins/${pluginId}`, {
      headers: { Origin: ALLOWED_ORIGIN, Cookie: "oc_sess=e2e-owner-session-token" },
    });
    expect(ownerDetail.status()).toBe(200);

    // 後始末（owner が削除）
    await request.delete(`${API_BASE}/v1/plugins/${pluginId}`, {
      headers: { Origin: ALLOWED_ORIGIN, Cookie: "oc_sess=e2e-owner-session-token" },
    });
  });
});
