// プラグインの通報を見る（設計 87）の E2E。
// 一般利用者が通報 → サイト運営が管理画面「通報」のプラグインタブで見る →
// プラグイン詳細で中身を見る → 対応済みにする → 一覧から消える。
// 作者は中身を見られるが対応はできず、通報者 ID も出ない。
//
// スクリーンショットは E2E_OUTPUT_DIR（既定 test-results）配下の plugin-reports-shots に出す。
// pc は 1142px、mobile は 360px で撮る（報告 88 の証拠に使う）。
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, apiUrl, readEnvelope } from "../helpers/api";
import { fakeDeviceId, unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";
const OWNER_SESSION = "e2e-owner-session-token";

function sessionHeaders(session: string): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${session}`,
  };
}

function waitForPost(page: Page, pattern: RegExp) {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && pattern.test(new URL(response.url()).pathname),
  );
}

async function addSession(page: Page, session: string): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await page.context().addCookies([
    { name: "oc_sess", value: session, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

interface CreatedPlugin {
  id: string;
  name: string;
}

/** 作者（test-user）で個人用の公開プラグインを 1 つ作る。 */
async function createPublishedPlugin(request: APIRequestContext, prefix: string): Promise<CreatedPlugin> {
  const name = unique(prefix).toLowerCase();
  const created = await request.post(`${API_BASE}/v1/plugins`, {
    headers: sessionHeaders(USER_SESSION),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: `${name} の E2E 用プラグイン`,
        description: "通報の E2E 用",
        scope: ["personal"],
        permissions: ["ui:slot"],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: ["thread-post-inline"],
        hooks: [],
      },
      code: "register({});",
      visibility: "private",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await readEnvelope<CreatedPlugin>(created);
  if (!body || !body.ok) throw new Error(`プラグイン作成に失敗: ${JSON.stringify(body)}`);

  const published = await request.post(`${API_BASE}/v1/plugins/${body.data.id}/publish`, {
    headers: sessionHeaders(USER_SESSION),
    data: { scopes: ["personal"], visibility: "public" },
  });
  expect(published.status(), await published.text()).toBe(200);
  return body.data;
}

/** 匿名端末から通報する（API 直。UI からの通報は別テストで確認する）。 */
async function reportFromDevice(
  request: APIRequestContext,
  pluginId: string,
  detail: string,
): Promise<void> {
  const response = await request.post(`${API_BASE}/v1/plugins/${pluginId}/report`, {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      Cookie: `oc_did=${fakeDeviceId()}`,
    },
    data: { reason: "broken", detail },
  });
  expect(response.status(), await response.text()).toBe(201);
}

/** 実行環境（pc / mobile プロジェクト）に合わせた証拠用ビューポート。 */
async function resizeForProject(page: Page, projectName: string): Promise<void> {
  await page.setViewportSize(
    projectName === "mobile" ? { width: 360, height: 740 } : { width: 1142, height: 900 },
  );
}

function shotPath(name: string, projectName: string): string {
  const dir = path.join(process.env.E2E_OUTPUT_DIR ?? "test-results", "plugin-reports-shots");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${projectName}.png`);
}

/** 管理画面「通報」のプラグインタブを開き、一覧 API の応答まで待つ。 */
async function openPluginTab(page: Page): Promise<void> {
  const listed = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      /\/api\/v1\/admin\/plugin-reports$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "プラグイン", exact: true }).click();
  await listed;
}

test.describe("プラグインの通報を見る", () => {
  test("一般利用者が通報→運営が一覧から開いて中身を確認→対応済み→一覧から消える", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const plugin = await createPublishedPlugin(request, "plugrep");
    const detailText = `E2E 通報の詳細 ${plugin.name}`;

    // viewer 側（通報する一般利用者）はこのページの context をそのまま使う（セッションなし）。
    await resizeForProject(page, testInfo.project.name);
    await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);
    await expect(page.getByRole("heading", { level: 1, name: plugin.name })).toBeVisible();
    await expect(page.getByText("通報 0", { exact: true })).toBeVisible();

    // 1. 一般利用者が通報 → 件数バッジが再読み込みなしで取り直される（設計 4）。
    await page.getByLabel("理由").selectOption("broken");
    await page.getByLabel("詳細（任意）").fill(detailText);
    const reported = waitForPost(page, /\/api\/v1\/plugins\/[^/]+\/report$/);
    await page.getByRole("button", { name: "通報する" }).click();
    expect((await reported).status()).toBe(201);
    await expect(page.getByText(/通報しました。運営が確認します/)).toBeVisible();
    await expect(page.getByText("通報 1", { exact: true })).toBeVisible();
    // 通報しただけの利用者には通報一覧を出さない。
    await expect(page.getByText("通報の一覧")).toHaveCount(0);

    // 2. サイト運営は管理画面「通報」のプラグインタブで見る。
    await addSession(page, OWNER_SESSION);
    await page.goto("/admin/reports/");
    await openPluginTab(page);
    const row = page.locator(".oc-surface", { hasText: plugin.name }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("未対応 1")).toBeVisible();
    await expect(row.getByText("作者: test-user")).toBeVisible();
    await expect(row.getByText("動作しない 1")).toBeVisible();
    await expect(row.getByText(/最新の通報/)).toBeVisible();
    await page.screenshot({ path: shotPath("admin-plugin-reports", testInfo.project.name) });

    // 3. 詳細で中身（理由・詳細文・通報者）を見る。
    await row.getByRole("link", { name: "通報の中身を見る" }).click();
    await expect(page.getByRole("heading", { level: 1, name: plugin.name })).toBeVisible();
    await expect(page.getByText("通報の一覧", { exact: true })).toBeVisible();
    await expect(page.getByText(detailText)).toBeVisible();
    await expect(page.getByText(/通報者: 端末 /)).toBeVisible();
    await expect(page.getByText("未対応 1 件")).toBeVisible();
    await page
      .getByText("通報の一覧", { exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: shotPath("plugin-report-detail-admin", testInfo.project.name) });

    // 4. 対応済みにする（メモ付き）。
    await page.getByLabel("対応メモ（任意・監査ログに残ります）").fill("E2E で確認済み");
    const handled = waitForPost(page, /\/api\/v1\/plugins\/reports\/[^/]+\/handle$/);
    await page.getByRole("button", { name: "対応済み", exact: true }).click();
    expect((await handled).status()).toBe(200);
    await expect(page.getByText(/対応済みにしました（未対応 0 件）/)).toBeVisible();
    await expect(page.getByText("未対応 0 件", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "対応済み", exact: true })).toHaveCount(0);

    // 5. 管理画面の既定一覧から消える（対応済みも表示では残る）。
    //    他のテストが作った未対応の通報と混ざらないよう、このプラグインの行だけで判定する。
    await page.goto("/admin/reports/");
    await openPluginTab(page);
    await expect(page.getByRole("link", { name: plugin.name })).toHaveCount(0);

    await page.getByLabel("対応済みも表示").check();
    const historical = page.locator(".oc-surface", { hasText: plugin.name }).first();
    await expect(historical).toBeVisible();
    await expect(historical.getByText("未対応なし")).toBeVisible();
  });

  test("作者は詳細で通報の中身を見られるが、対応も通報者 ID の閲覧もできない", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const plugin = await createPublishedPlugin(request, "plugrep-author");
    const detailText = `作者向け通報 ${plugin.name}`;
    await reportFromDevice(request, plugin.id, detailText);

    await resizeForProject(page, testInfo.project.name);
    await addSession(page, USER_SESSION);
    await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);

    await expect(page.getByText("通報の一覧", { exact: true })).toBeVisible();
    await expect(page.getByText(detailText)).toBeVisible();
    await expect(page.getByText("未対応 1 件")).toBeVisible();
    // 通報者 ID は出さない・対応ボタンも出さない。
    await expect(page.getByText(/通報者:/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "対応済み", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "却下", exact: true })).toHaveCount(0);
    // 通報一覧の近くの停止導線はサイト運営向け（作者には出さない）。
    await expect(page.getByRole("link", { name: "停止（キルスイッチ）へ" })).toHaveCount(0);

    await page
      .getByText("通報の一覧", { exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: shotPath("plugin-report-detail-author", testInfo.project.name) });
  });
});