// レビュー修正 B4/B5/B6/B14 の E2E（おーぷんクローン実利用レビュー修正）。
//
// 匿名（Cookie なし → 端末 Cookie のみ）で公式サンプル（0612 seed の spoiler）を使う:
//   閲覧 → 個人用に導入 → 実スレで効果（ネタバレ表示）→ 無効化（効果が消え導入は残る）
//   → 有効化（効果が戻る）→ アンインストール。
// あわせて削除（確認ダイアログ→一覧から消える）と停止中の表示を確認する。
//
// 0612 の seed は migrations apply で入るため、E2E DB には常に公式 spoiler がある。
// seed の spoiler が壊れている場合はテストが失敗する（フェイルファスト）。

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

/** API 応答を待つ（UI 押下後の確定用） */
function waitForPost(page: Page, path: RegExp) {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname),
  );
}

async function loginAsTestUser(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

interface SeedPlugin {
  id: string;
  name: string;
}

/** 0612 seed の公式 spoiler を API から引く（匿名可） */
async function findSpoiler(request: APIRequestContext): Promise<SeedPlugin> {
  const response = await request.get(apiUrl("/v1/plugins?q=spoiler"), {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  const body = await readEnvelope<{ items: SeedPlugin[] }>(response);
  if (!body || !body.ok) throw new Error(`公式 spoiler の検索に失敗: ${JSON.stringify(body)}`);
  const found = body.data.items.find((item) => item.name === "spoiler");
  if (!found) throw new Error("公式 spoiler が見つかりません（0612 seed が適用されているか確認してください）");
  return found;
}

test.describe("匿名ユーザーのプラグイン利用（B14）", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("匿名で閲覧→個人用導入→実スレで効果→無効化→有効化→アンインストール", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(120_000);

    // 0. ログインしていないことを確認（端末 Cookie も持たない状態）
    await page.goto("/plugins/");
    await expect(page.getByRole("heading", { level: 1, name: "プラグイン" })).toBeVisible();

    // 1. 公式 spoiler の詳細が見える（匿名閲覧）
    const spoiler = await findSpoiler(request);
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler.id)}`);
    await expect(page.getByRole("heading", { level: 1, name: "spoiler" })).toBeVisible();
    await expect(page.getByText("レス内の [spoiler]〜[/spoiler] をクリックで開くネタバレ表示にする")).toBeVisible();

    // 2. 実スレ用の板とスレを（テスト用アカウントで）作る。本文に [spoiler] を含める。
    const slug = unique("anon").toLowerCase();
    const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
      headers: userHeaders(),
      data: {
        slug,
        name: `匿名E2E板${slug.slice(-4)}`,
        category: "E2E",
        description: "匿名プラグ利用の E2E 検証用",
        settings: { turnstile: "off" },
      },
    });
    expect(boardResponse.status(), await boardResponse.text()).toBe(201);

    const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: userHeaders(),
      data: {
        title: `匿名プラグE2E ${slug}`,
        body: "1げっと\n[spoiler]これは秘密の内容[/spoiler]",
        turnstileToken: "1x00000000000000000000AA",
      },
    });
    expect(threadResponse.status(), await threadResponse.text()).toBe(201);
    const thread = await readEnvelope<{ threadId: number }>(threadResponse);
    if (!thread || !thread.ok) throw new Error("スレ作成の応答が不正です");

    // 3. 導入前: 実スレでは [spoiler] は生テキスト
    await page.goto(`/b/${encodeURIComponent(slug)}/t/${thread.data.threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#p1 .oc-plugin-render-spoiler")).toHaveCount(0);
    await expect(page.locator("#p1")).toContainText("[spoiler]");

    // 4. 匿名で個人用に導入（Cookie なし → API が端末 Cookie を発行）
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler.id)}`);
    const installed = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/install$/);
    await page.getByRole("button", { name: "個人用にインストール" }).click();
    expect((await installed).status()).toBe(201);
    await expect(page.getByText(/個人用にインストールしました/)).toBeVisible();
    // 導入状況に行が現れる（導入済み・enabled=1）
    await expect(page.getByText("個人用", { exact: true }).first()).toBeVisible();

    // 5. 実スレで効果を確認（ネタバレ表示）
    await page.goto(`/b/${encodeURIComponent(slug)}/t/${thread.data.threadId}`);
    await expect(page.locator("#p1 .oc-plugin-render-spoiler")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#p1 .oc-plugin-render-spoiler")).toContainText("これは秘密の内容");

    // 6. 無効化: 効果が消え、導入行は残る
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler.id)}`);
    const disabled = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/disable-install$/);
    await page.getByRole("button", { name: "無効化", exact: true }).click();
    expect((await disabled).status()).toBe(200);
    await expect(page.getByText(/無効化しました/)).toBeVisible();
    // 導入行はまだある（アンインストールされていない）
    await expect(page.getByText("個人用", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("無効", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: "test-results-rv-plugins/shots/b6-disabled-row-keeps-install-pc.png" });

    // 実スレでも効果が消える
    await page.goto(`/b/${encodeURIComponent(slug)}/t/${thread.data.threadId}`);
    await expect(page.locator("#p1 .oc-plugin-render-spoiler")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator("#p1")).toContainText("[spoiler]");

    // 7. 有効化: 効果が戻る
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler.id)}`);
    const enabled = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/enable-install$/);
    await page.getByRole("button", { name: "有効化", exact: true }).click();
    expect((await enabled).status()).toBe(200);
    await expect(page.getByText(/有効化しました/)).toBeVisible();

    await page.goto(`/b/${encodeURIComponent(slug)}/t/${thread.data.threadId}`);
    await expect(page.locator("#p1 .oc-plugin-render-spoiler")).toBeVisible({ timeout: 15_000 });

    // 8. アンインストール: 導入行が消える
    await page.goto(`/plugins/view/?id=${encodeURIComponent(spoiler.id)}`);
    const uninstalled = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/uninstall$/);
    await page.getByRole("button", { name: "アンインストール" }).click();
    expect((await uninstalled).status()).toBe(200);
    await expect(page.getByText(/アンインストールしました/)).toBeVisible();
    // 導入状況の「個人用」行は消える（公式 spoiler のインストール数が 0 に戻る）
    await expect(page.getByText("個人用", { exact: true })).toHaveCount(0);

    // 実スレでも効果が消える
    await page.goto(`/b/${encodeURIComponent(slug)}/t/${thread.data.threadId}`);
    await expect(page.locator("#p1 .oc-plugin-render-spoiler")).toHaveCount(0, { timeout: 15_000 });

    // 9. 権限昇格なし: 匿名は作成できない
    const anonCreate = await request.post(`${API_BASE}/v1/plugins`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      data: { manifest: { name: unique("anon-create") }, code: "register({});" },
    });
    expect(anonCreate.status()).toBe(401);

    // Cookie は端末 Cookie（oc_did）だけになっている
    const cookies = await context.cookies();
    const cookieNames = new Set(cookies.map((cookie) => cookie.name));
    expect(cookieNames.has("oc_sess")).toBe(false);
    expect(cookieNames.has("oc_did")).toBe(true);
  });
});

test.describe("削除と停止の表示（B4/B5）", () => {
  test("所有者の削除は確認ダイアログを通り、一覧から消える（停止にはならない）", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(120_000);
    await loginAsTestUser(context);

    // テスト用プラグインを作成・公開（personal のみなら即時公開）
    const name = unique("delete-e2e").slice(0, 41).toLowerCase();
    const createResponse = await request.post(`${API_BASE}/v1/plugins`, {
      headers: userHeaders(),
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "削除 E2E 用",
          scope: ["personal"],
          permissions: [],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: [],
          hooks: [],
        },
        code: "register({});",
        visibility: "public",
        changelog: "e2e",
      },
    });
    expect(createResponse.status(), await createResponse.text()).toBe(201);
    const created = await readEnvelope<{ id: string }>(createResponse);
    if (!created || !created.ok) throw new Error("作成に失敗");

    const publishResponse = await request.post(`${API_BASE}/v1/plugins/${created.data.id}/publish`, {
      headers: userHeaders(),
      data: { scopes: ["personal"], visibility: "public" },
    });
    expect(publishResponse.status()).toBe(200);

    // 削除ボタンを押すと確認ダイアログが出る（まだ消えていない）
    await page.goto(`/plugins/view/?id=${encodeURIComponent(created.data.id)}`);
    await page.getByRole("button", { name: /削除（レジストリから消す）/ }).click();
    const dialog = page.getByRole("alertdialog", { name: "プラグインの削除確認" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("元に戻すことはできません");
    await page.screenshot({ path: "test-results-rv-plugins/shots/b4-delete-confirm-dialog-pc.png" });

    // 「やめる」でキャンセルできる
    await dialog.getByRole("button", { name: "やめる" }).click();
    await expect(dialog).toBeHidden();
    // まだ存在する
    const stillThere = await request.get(apiUrl(`/v1/plugins?q=${encodeURIComponent(name)}`), {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const stillBody = await readEnvelope<{ items: SeedPlugin[] }>(stillThere);
    expect(stillBody?.ok && stillBody.data.items.some((item) => item.name === name)).toBe(true);

    // 「削除する」で実削除
    await page.getByRole("button", { name: /削除（レジストリから消す）/ }).click();
    await expect(dialog).toBeVisible();
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname.endsWith(`/v1/plugins/${created.data.id}`),
    );
    await dialog.getByRole("button", { name: "削除する" }).click();
    expect((await deleted).status()).toBe(200);
    // 一覧へ遷移する
    await expect(page).toHaveURL(/\/plugins(\/)?$/u, { timeout: 15_000 });

    // 一覧から消えている
    const afterDelete = await request.get(apiUrl(`/v1/plugins?q=${encodeURIComponent(name)}`), {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const afterBody = await readEnvelope<{ items: SeedPlugin[] }>(afterDelete);
    expect(afterBody?.ok && afterBody.data.items.some((item) => item.name === name)).toBe(false);

    // 詳細も 404
    const detailResponse = await request.get(apiUrl(`/v1/plugins/${created.data.id}`), {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(detailResponse.status()).toBe(404);
  });

  test("全体停止中の個人導入は「停止中（効果なし）」と理由を表示する", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(120_000);
    await loginAsTestUser(context);

    const spoiler = await findSpoiler(request);

    // 公式 spoiler は消せないので、テスト用プラグインを作って確認する
    const name = unique("stopped-e2e").slice(0, 41).toLowerCase();
    const createResponse = await request.post(`${API_BASE}/v1/plugins`, {
      headers: userHeaders(),
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "停止表示 E2E 用",
          scope: ["personal"],
          permissions: [],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: [],
          hooks: [],
          render: {
            post: [
              {
                pattern: "\\[e2e\\]([\\s\\S]*?)\\[\\/e2e\\]",
                flags: "g",
                template: "$1",
                kind: "spoiler",
              },
            ],
          },
        },
        code: "register({});",
        visibility: "public",
        changelog: "e2e",
      },
    });
    expect(createResponse.status(), await createResponse.text()).toBe(201);
    const created = await readEnvelope<{ id: string }>(createResponse);
    if (!created || !created.ok) throw new Error("作成に失敗");

    await request.post(`${API_BASE}/v1/plugins/${created.data.id}/publish`, {
      headers: userHeaders(),
      data: { scopes: ["personal"], visibility: "public" },
    });

    // 個人用に導入（テストユーザー）
    const installResponse = await request.post(`${API_BASE}/v1/plugins/${created.data.id}/install`, {
      headers: userHeaders(),
      data: { scope: "personal" },
    });
    expect(installResponse.status()).toBe(201);

    try {
      // 停止（キルスイッチ）
      const disableResponse = await request.post(`${API_BASE}/v1/plugins/${created.data.id}/disable`, {
        headers: userHeaders(),
        data: { reason: "E2E 停止確認" },
      });
      expect(disableResponse.status()).toBe(200);

      // 詳細ページ: 導入状況が「停止中（効果なし）」＋理由を表示
      await page.goto(`/plugins/view/?id=${encodeURIComponent(created.data.id)}`);
      await expect(page.getByText("停止中（効果なし）").first()).toBeVisible();
      await expect(
        page.getByText(/プラグイン全体が停止（キルスイッチ）中のため/).first(),
      ).toBeVisible();
      await page.screenshot({ path: "test-results-rv-plugins/shots/b5-stopped-reason-pc.png" });

      // 導入済みタブ（一覧）でも理由が出る
      await page.goto("/plugins/?tab=installed");
      await expect(page.getByText("停止中（効果なし）").first()).toBeVisible();
    } finally {
      // 後始末: 停止解除 → アンインストール → 削除
      await request.post(`${API_BASE}/v1/plugins/${created.data.id}/enable`, { headers: userHeaders() });
      await request.post(`${API_BASE}/v1/plugins/${created.data.id}/uninstall`, {
        headers: userHeaders(),
        data: { scope: "personal" },
      });
      await request.delete(`${API_BASE}/v1/plugins/${created.data.id}`, { headers: userHeaders() });
    }
  });
});
