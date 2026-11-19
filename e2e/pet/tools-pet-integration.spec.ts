// 読み取り・移動・プラグイン・通報のツール（本物の中継・本物のツールを通す統合 e2e）。
//
// 中継は `page.route` で置き換えない。事業者だけを e2e スタブ（`#tool <name> <JSON>`）にする。

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { apiUrl } from "../helpers/api";
import {
  configurePet,
  createPetBoard,
  createPetThread,
  openPet,
  petApiHeaders,
  petLastMessageText,
  petLastRequest,
  replyPetThread,
  sendPetTool,
  stubTurnstile,
  usePetSession,
  waitPetIdle,
  PET_SESSIONS,
} from "./helpers";

/** ペットを開いて会話できる状態にする（設定は 1 回だけ）。 */
async function openPetChat(page: Page, context: BrowserContext, cookie: string | null): Promise<void> {
  await stubTurnstile(page);
  await usePetSession(context, cookie);
  await openPet(page);
  if ((await page.getByTestId("pet-provider").count()) > 0) {
    await configurePet(page, { model: "stub-model", apiKey: "sk-test" });
  }
  await expect(page.getByTestId("pet-input")).toBeVisible();
}

/** テスト用のプラグインを作る（owner）。 */
async function createPlugin(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(apiUrl("/v1/plugins"), {
    headers: petApiHeaders(PET_SESSIONS.owner),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "ペットのツール試験用のプラグイン",
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
  expect(response.status(), await response.text()).toBe(201);
  const envelope = (await response.json()) as { ok: boolean; data?: { id?: string } };
  const id = envelope.data?.id;
  if (!id) throw new Error("プラグイン作成の応答に id がありません");
  return id;
}

test.describe("ペットのツール（読み取り・移動・プラグイン・通報）", () => {
  test("add_my_plugin_version はカードの版と実際に付いた版が一致する", async ({ page, context, request }) => {
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    const pluginId = await createPlugin(request, `pet-ver-${Date.now().toString(36)}`.slice(0, 40));
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, PET_SESSIONS.owner);

    await sendPetTool(page, "add_my_plugin_version", {
      pluginId,
      code: "register({}); // v2",
      changelog: "ペットからの版追加",
    });
    const card = page.getByTestId("pet-confirm-card");
    await expect(card).toBeVisible();
    const versionRow = card.locator(".oc-pet-confirm-row").filter({ hasText: "新しい版" }).locator("dd");
    await expect(versionRow).toContainText("1.0.1");
    await page.getByTestId("pet-confirm-run").click();
    await expect(page.getByText("実行しました。", { exact: true })).toBeVisible();
    await waitPetIdle(page);

    const versions = await request.get(apiUrl(`/v1/plugins/${pluginId}/versions`), {
      headers: petApiHeaders(PET_SESSIONS.owner),
    });
    expect(versions.status(), await versions.text()).toBe(200);
    const envelope = (await versions.json()) as { ok: boolean; data?: { items?: { version: string }[] } };
    const list = envelope.data?.items ?? [];
    expect(list.map((item) => item.version)).toContain("1.0.1");
  });

  test("open_page はシェル内・フルページの移動後も会話を残し、外部 URL を拒む", async ({ page, context, request }) => {
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, null);

    // 会話の目印になる返事を作る。
    await page.getByTestId("pet-input").fill("こんにちは");
    await page.getByTestId("pet-send").click();
    await expect(page.getByTestId("pet-messages")).toContainText("了解: こんにちは");

    // シェル内の移動（板）。
    await sendPetTool(page, "open_page", { path: `/b/${board.slug}` });
    await expect(page).toHaveURL(new RegExp(`/b/${board.slug}(\\?|$)`));
    await expect(page.getByTestId("pet-messages")).toContainText("了解: こんにちは");
    await waitPetIdle(page);

    // フルページの移動（/plugins/）。読み直しても会話の履歴が残る。
    await sendPetTool(page, "open_page", { path: "/plugins/" });
    await expect(page).toHaveURL(/\/plugins\/?$/);
    await openPet(page);
    await expect(page.getByTestId("pet-messages")).toContainText("了解: こんにちは");

    // 外部 URL は拒む（移動しない）。実際の結果（INVALID_ARGS）が AI に返り、画面の行は失敗表示になる。
    const current = page.url();
    await sendPetTool(page, "open_page", { path: "https://example.com/" });
    await expect(
      page.getByTestId("pet-tool-line").filter({ hasText: "画面を移動しています" }).last(),
    ).toContainText("できませんでした");
    await waitPetIdle(page);
    expect(page.url()).toBe(current);
    // 次の依頼で、AI には失敗の結果が履歴として渡る（`/pet/__last` で確かめる）。
    await page.getByTestId("pet-input").fill("どうしたの？");
    await page.getByTestId("pet-send").click();
    await waitPetIdle(page);
    const lastRequest = await petLastRequest();
    expect(JSON.stringify(lastRequest?.messages ?? [])).toContain("INVALID_ARGS");
  });

  test("open_plugin_editor は下書きが入った状態でエディタを開く", async ({ page, context, request }) => {
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, PET_SESSIONS.owner);

    const name = `pet-draft-${Date.now().toString(36)}`.slice(0, 40);
    await sendPetTool(page, "open_plugin_editor", {
      manifest: {
        name,
        version: "1.0.0",
        summary: "ペットが作った下書き",
        scope: ["personal"],
        permissions: [],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: [],
        hooks: [],
      },
      code: "register({ ping() { return 1; } });",
    });

    await expect(page).toHaveURL(/\/plugins\/new\/?\?from=template/);
    await expect(page.getByText("テンプレートの内容を読み込みました", { exact: false })).toBeVisible();
    await expect(page.getByLabel("名前（slug・変更不可）")).toHaveValue(name);
    await expect(page.locator(".cm-content")).toContainText("register({ ping()");
  });

  test("read_help は節の一覧と本文（#pet 節を含む）を返す", async ({ page, context, request }) => {
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, null);

    // 節の一覧（ツール結果はスタブに届いた JSON で確かめる）。
    await sendPetTool(page, "read_help", {});
    await expect(page.getByTestId("pet-messages")).toContainText("ツール結果(read_help)");
    await waitPetIdle(page);
    const list = await petLastMessageText();
    expect(list).toContain('"id":"basics"');
    expect(list).toContain('"id":"pet"');

    // #pet 節の本文（DSPetUI が足した節）。
    await sendPetTool(page, "read_help", { section: "pet" });
    await expect(page.getByTestId("pet-tool-line").filter({ hasText: "完了" })).toHaveCount(2);
    await waitPetIdle(page);
    const section = await petLastMessageText();
    expect(section).toContain('"id":"pet"');
    expect(section).toContain("ペット");
  });

  test("handle_report は処理済みの通報ではカードを出さない", async ({ page, context, request }) => {
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    const target = await replyPetThread(request, thread.threadId, `通報の対象レス ${Date.now()}`, PET_SESSIONS.user);

    // 通報を作り、板スタッフ（サイト管理者）として対応済みにする。
    const created = await request.post(apiUrl("/v1/reports"), {
      headers: petApiHeaders(PET_SESSIONS.user),
      data: { boardSlug: board.slug, threadId: thread.threadId, posts: String(target.num), reason: "spam", turnstileToken: "1x00000000000000000000AA" },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdEnvelope = (await created.json()) as { ok: boolean; data?: { id?: string | number } };
    const reportId = createdEnvelope.data?.id;
    if (reportId === undefined) throw new Error("通報作成の応答に id がありません");
    const handled = await request.post(apiUrl(`/v1/reports/${reportId}/handle`), {
      headers: petApiHeaders(PET_SESSIONS.owner),
      data: { action: "resolve", note: "E2E" },
    });
    expect(handled.status(), await handled.text()).toBe(200);

    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, PET_SESSIONS.owner);
    await sendPetTool(page, "handle_report", { reportId: String(reportId), action: "delete" });

    const failed = page.getByTestId("pet-tool-line").filter({ hasText: "できませんでした" });
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("処理済み");
    await expect(page.getByTestId("pet-confirm-card")).toHaveCount(0);
    await waitPetIdle(page);
    expect(await petLastMessageText()).toContain("ALREADY_HANDLED");
  });
});