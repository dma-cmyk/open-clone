// WP3 プラグインのライフサイクル E2E。
// Web エディタで作成→プレビュー→保存→公開申請→審査承認→導入→スレ表示反映→更新→停止 を実スタックで検証する。

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

/**
 * 操作ボタン押下後に発火する API 応答を待つ。
 * トースト/通知の表示待ちは、表示直前に一瞬消える・文言が被る等でフレークしやすいので、
 * サーバが受理した事実（応答）を基準にする（トースト待ちの安定化）。
 */
function waitForPost(page: Page, path: RegExp) {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && path.test(new URL(response.url()).pathname),
  );
}

interface PluginSummary {
  id: string;
  name: string;
  latestVersion: string | null;
  status: string;
}

async function findPlugin(request: APIRequestContext, name: string): Promise<PluginSummary> {
  const response = await request.get(apiUrl(`/v1/plugins?q=${encodeURIComponent(name)}`), {
    headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE },
  });
  const body = await readEnvelope<{ items: PluginSummary[] }>(response);
  if (!body || !body.ok) throw new Error(`プラグイン検索に失敗: ${JSON.stringify(body)}`);
  const found = body.data.items.find((item) => item.name === name);
  if (!found) throw new Error(`プラグイン ${name} が見つかりません`);
  return found;
}

test.describe("プラグインのライフサイクル（Web エディタ）", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: "localhost", path: "/" },
    ]);
  });

  test("作成→プレビュー→保存→公開申請→承認→導入→スレ表示反映→更新→停止", async ({ page, request }) => {
    const name = unique("spoiler");

    // 1. エディタでサンプルを読み込み、名前を変えてプレビュー実行
    await page.goto("/plugins/new/");
    await page.locator("select").first().selectOption("spoiler");
    await page.getByLabel("名前（slug・変更不可）").fill(name);
    await page.getByRole("button", { name: "プレビュー実行" }).click();

    const previewFrame = page.locator('iframe[title="プラグイン プレビュー"]');
    await expect(previewFrame).toHaveCount(1);
    await expect(previewFrame).toHaveAttribute("sandbox", "allow-scripts");

    // 2. 保存（下書き）— 保存 API の応答を待ってから通知を確認する
    const saved = waitForPost(page, /\/api\/v1\/plugins$/);
    await page.getByRole("button", { name: "保存（下書き）" }).click();
    expect((await saved).status()).toBe(201);
    await expect(page.getByText(/保存しました/)).toBeVisible();

    // 3. 公開申請（site を含むため審査キューへ）
    const published = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/publish$/);
    await page.getByRole("button", { name: "公開申請" }).click();
    expect((await published).status()).toBe(200);
    await expect(page.getByText(/公開申請を受け付けました/)).toBeVisible();

    // 4. 審査キューで承認 — 応答で確定させてから通知を確認する
    await page.goto("/plugins/review/");
    const reviewCard = page.locator("section", { hasText: name }).first();
    await expect(reviewCard).toBeVisible();
    const reviewed = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/review$/);
    await reviewCard.getByRole("button", { name: "承認" }).click();
    expect((await reviewed).status()).toBe(200);
    await expect(page.getByText(/承認しました/)).toBeVisible();

    // 5. レジストリ検索に出る
    const plugin = await findPlugin(request, name);
    expect(plugin.status).toBe("published");

    await page.goto(`/plugins/?q=${encodeURIComponent(name)}`);
    await expect(page.getByRole("link", { name, exact: true })).toBeVisible();

    // 6. 個人用にインストール
    await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);
    const installed = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/install$/);
    await page.getByRole("button", { name: "個人用にインストール" }).click();
    expect((await installed).status()).toBe(201);
    await expect(page.getByText(/個人用にインストールしました/)).toBeVisible();

    // 7. スレ表示デモに反映（宣言的レンダー規則で [spoiler] が変換される）
    await page.goto("/plugins/demo/");
    await expect(page.locator(".oc-plugin-render-spoiler").first()).toBeVisible();

    // 8. 新バージョンを追加して公開（personal のみ → 即時公開）
    const versionResponse = await request.post(apiUrl(`/v1/plugins/${plugin.id}/versions`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: {
        version: "1.1.0",
        code: "register({});",
        manifest: {
          name,
          version: "1.1.0",
          summary: "E2E 更新版",
          scope: ["personal", "board", "site"],
          permissions: [],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: [],
          hooks: [],
          render: {
            post: [
              {
                pattern: "\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]",
                flags: "g",
                template: "$1",
                kind: "spoiler",
              },
            ],
          },
        },
      },
    });
    expect(versionResponse.status()).toBe(201);

    const publishResponse = await request.post(apiUrl(`/v1/plugins/${plugin.id}/publish`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: { scopes: ["personal"], visibility: "public" },
    });
    expect(publishResponse.status()).toBe(200);

    // 9. UI から更新
    await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);
    const updated = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/update$/);
    await page.getByRole("button", { name: "更新", exact: true }).first().click();
    expect((await updated).status()).toBe(200);
    await expect(page.getByText(/に更新しました/)).toBeVisible();

    // 10. 停止（キルスイッチ）→ デモから消える
    const disabled = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/disable$/);
    await page.getByRole("button", { name: "停止（キルスイッチ）" }).click();
    expect((await disabled).status()).toBe(200);
    await expect(page.getByText(/停止しました/)).toBeVisible();

    await page.goto("/plugins/demo/");
    await expect(page.locator(".oc-plugin-render-spoiler")).toHaveCount(0);
  });
});