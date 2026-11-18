// プラグインの権限・表示場所の説明（設計: 権限と表示場所の説明）。
//  - 詳細画面に日本語の権限名・危険度・説明・通信先・表示場所が出る
//  - エディタは場所名から選べ、選んだ場所の識別子が manifest に入る
//  - 別名（thread-head など）を含む manifest を読み込んでも、保存値は変わらない
//  - 「?」で画面の略図（板・スレ）が出る
//  - 390px でも横にはみ出さない
// スクリーンショットは E2E_OUTPUT_DIR（既定 test-results）配下の plugin-label-shots に出す。

import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

function ownerHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: OWNER_COOKIE };
}

function shotPath(name: string): string {
  const dir = path.join(process.env.E2E_OUTPUT_DIR ?? "test-results", "plugin-label-shots");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${test.info().project.name}.png`);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: shotPath(name), fullPage: false });
}

/** 390px でも横スクロールが出ないことを確かめる（設計の完了条件）。 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow, "横スクロールが発生していない").toBe(false);
}

async function resizeForProject(page: Page): Promise<void> {
  if (test.info().project.name === "mobile") {
    await page.setViewportSize({ width: 390, height: 844 });
  }
}

async function createPlugin(
  request: APIRequestContext,
  options: { permissions: string[]; slots: string[]; connectAllowlist?: string[] },
): Promise<{ id: string; name: string }> {
  const name = unique("labels").toLowerCase().slice(0, 40);
  const response = await request.post(apiUrl("/v1/plugins"), {
    headers: ownerHeaders(),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "権限と表示場所の説明の検証用",
        scope: ["personal"],
        permissions: options.permissions,
        connectAllowlist: options.connectAllowlist ?? [],
        entry: "plugin.js",
        slots: options.slots,
        hooks: [],
      },
      code: "register({});",
      visibility: "private",
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = await readEnvelope<{ id: string }>(response);
  if (!body || !body.ok) throw new Error("プラグイン作成の応答が不正です");
  return { id: body.data.id, name };
}

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    { name: "oc_sess", value: "e2e-owner-session-token", domain: "localhost", path: "/" },
  ]);
});

test.describe("プラグインの権限と表示場所の説明", () => {
  test("詳細画面: 日本語名・危険度・通信先・表示場所が出る", async ({ page, request }) => {
    await resizeForProject(page);
    const plugin = await createPlugin(request, {
      permissions: ["ui:slot", "net:fetch", "data:write:post"],
      slots: ["thread-head", "post-form-after"],
      connectAllowlist: ["https://api.example.com"],
    });

    await page.goto(`/plugins/view/?id=${encodeURIComponent(plugin.id)}`);
    const card = page.locator('[data-tour="plugin-detail-permissions"]');
    await expect(card).toBeVisible({ timeout: 20_000 });

    // 権限は日本語名 + 危険度 + 説明 + 識別子
    const netRow = card.locator('[data-permission="net:fetch"]');
    await expect(netRow).toContainText("外部との通信");
    await expect(netRow).toContainText("危険度: 中");
    await expect(netRow).toContainText("作者が指定した外部サイトと通信します");
    await expect(netRow.locator("code", { hasText: "net:fetch" })).toBeVisible();
    // 通信先（connectAllowlist）
    await expect(netRow).toContainText("https://api.example.com");
    // 書き込み権限の説明と危険度
    const postRow = card.locator('[data-permission="data:write:post"]');
    await expect(postRow).toContainText("書き込み");
    await expect(postRow).toContainText("確認の窓");
    // スロットは場所名で出し、識別子を小さく添える（別名は置き先の場所名）
    const slotList = card.getByTestId("plugin-slot-list");
    await expect(slotList.locator('[data-slot="thread-head"]')).toContainText("スレの上");
    await expect(slotList.locator('[data-slot="thread-head"]')).toContainText("thread-head");
    await expect(slotList.locator('[data-slot="post-form-after"]')).toContainText("書き込み欄の下");
    // ヘルプへのリンク
    await expect(card.getByRole("link", { name: /ヘルプ: プラグインの権限と表示場所/ })).toHaveAttribute(
      "href",
      "/help/#plugin-permissions",
    );

    await card.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await shot(page, "detail-permissions");
  });

  test("エディタ: 場所名から選ぶと正しい識別子が manifest に入る", async ({ page }) => {
    await resizeForProject(page);
    await page.goto("/plugins/new/");
    await expect(page.getByTestId("plugin-permission-checklist")).toBeVisible({ timeout: 20_000 });

    // 権限は日本語名・危険度・説明付きで並ぶ（識別子は小さく添える）
    const checklist = page.getByTestId("plugin-permission-checklist");
    const permission = page.locator('[data-testid="plugin-permission-checklist"] [data-permission="data:read:thread"]');
    await expect(permission).toContainText("スレの読み取り");
    await expect(permission).toContainText("危険度: 低");
    await expect(permission).toContainText("表示中のスレのタイトルやレスを読みます");
    await checklist.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expectNoHorizontalOverflow(page);
    await shot(page, "editor-permissions");

    // 画面には実際に置かれる 10 か所だけが場所名で並ぶ
    await expect(page.locator("[data-slot-host]")).toHaveCount(10);
    await expect(page.locator('[data-slot-host="thread-top"]')).toContainText("スレの上");
    // 初期値の別名 thread-post-inline は「各レスの下」としてチェック済み
    await expect(page.locator('[data-slot-host="post-actions"] input[type="checkbox"]')).toBeChecked();

    // 各レスの下（別名）を外し、スレの上を選ぶ
    await page.locator('[data-slot-host="post-actions"] input[type="checkbox"]').uncheck();
    await page.locator('[data-slot-host="thread-top"] input[type="checkbox"]').check();
    await expect(page.locator('[data-slot-host="thread-top"] input[type="checkbox"]')).toBeChecked();

    const name = unique("labels-new").toLowerCase().slice(0, 40);
    await page.getByLabel("名前（slug・変更不可）").fill(name);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/api/v1/plugins"),
    );
    await page.getByRole("button", { name: "保存（下書き）" }).click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const payload = response.request().postDataJSON() as { manifest: { slots: string[] } };
    expect(payload.manifest.slots).toEqual(["thread-top"]);

    // 略図: 場所を選ぶと自動で出る。「?」で別の場所へ切り替えられる
    const diagram = page.getByTestId("plugin-slot-diagram");
    await expect(diagram).toBeVisible();
    await expect(diagram).toContainText("スレの上");
    await expect(diagram.locator('[aria-current="true"]')).toContainText("スレの上");
    await page.getByRole("button", { name: "「各レスの下」の位置を図で見る" }).click();
    await expect(diagram.locator('[aria-current="true"]')).toContainText("各レスの下");
    await page.getByRole("button", { name: "「スレの上」の位置を図で見る" }).click();
    await expect(diagram.locator('[aria-current="true"]')).toContainText("スレの上");

    await diagram.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expectNoHorizontalOverflow(page);
    await shot(page, "editor-slots-diagram");
  });

  test("エディタ: 別名を含む manifest を読み込んでも保存値が変わらない", async ({ page, request }) => {
    await resizeForProject(page);
    const plugin = await createPlugin(request, {
      permissions: ["ui:slot"],
      slots: ["thread-head", "plugin-page"],
    });

    await page.goto(`/plugins/new/?id=${encodeURIComponent(plugin.id)}`);
    await expect(page.getByTestId("declared-extra-slots")).toBeVisible({ timeout: 20_000 });
    // 別名は置き先の場所名で表示し、値はそのまま保持している
    await expect(page.getByTestId("declared-extra-slots")).toContainText("スレの上");
    await expect(page.getByTestId("declared-extra-slots")).toContainText("thread-head");
    await expect(page.getByTestId("declared-extra-slots")).toContainText("表示場所なし");
    await expect(page.getByTestId("declared-extra-slots")).toContainText("plugin-page");
    // thread-head は「スレの上」の場所としてチェック済み
    await expect(page.locator('[data-slot-host="thread-top"] input[type="checkbox"]')).toBeChecked();

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/v1\/plugins\/[^/]+\/versions$/.test(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: /新バージョンを保存/ }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(201);
    const payload = response.request().postDataJSON() as { manifest: { slots: string[] } };
    expect(payload.manifest.slots).toEqual(["thread-head", "plugin-page"]);

    await page.getByTestId("declared-extra-slots").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await shot(page, "editor-alias-preserved");
  });

  test("ヘルプ: 説明表から権限と表示場所の節ができる", async ({ page }) => {
    await resizeForProject(page);
    await page.goto("/help/#plugin-permissions");
    const section = page.locator("#plugin-permissions");
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section).toContainText("プラグインの権限と表示場所");
    await expect(section).toContainText("外部との通信");
    await expect(section).toContainText("危険度: 中");
    await expect(section).toContainText("板の横（スマホでは表示されません）");
    await expect(section).toContainText("thread-head");
    await expect(section).toContainText("plugin-page");
    await section.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await shot(page, "help-plugin-permissions");
  });
});