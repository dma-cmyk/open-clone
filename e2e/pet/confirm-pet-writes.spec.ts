// 書き込みツールの確認カード（本物の中継・本物のツールを通す統合 e2e）。
//
// 中継は `page.route` で置き換えない。本物の `POST /api/v1/pet/chat` を通し、事業者だけを
// e2e スタブ（`#tool <name> <JSON>`）にする。承認・取り消し・Turnstile・danger を確認する。

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { fakeDeviceId } from "../helpers/ids";
import {
  configurePet,
  createPetBoard,
  createPetThread,
  isolatePetRelayRate,
  openPet,
  petCardDetail,
  petLastMessageText,
  petTestApiKey,
  pinDeviceCookie,
  releaseTurnstile,
  replyPetThread,
  sendPetTool,
  stubTurnstile,
  usePetSession,
  waitPetIdle,
  PET_SESSIONS,
} from "./helpers";

/** 証拠の写真（`E2E_EVIDENCE_DIR` があるときだけ）。 */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.E2E_EVIDENCE_DIR;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}.png` });
}

/** スレ画面でペットを開き、会話できる状態にする（2 回目以降は設定済みなので触らない）。 */
async function openPetChat(
  page: Page,
  context: BrowserContext,
  options: { cookie: string | null; holdTurnstile?: boolean; apiKey: string },
): Promise<void> {
  await isolatePetRelayRate(page);
  await stubTurnstile(page, { hold: options.holdTurnstile ?? false });
  await usePetSession(context, options.cookie);
  await page.reload();
  await openPet(page);
  if ((await page.getByTestId("pet-provider").count()) > 0) {
    await configurePet(page, { model: "stub-model", apiKey: options.apiKey });
  }
  await expect(page.getByTestId("pet-input")).toBeVisible();
}

test.describe("ペットの確認カード（書き込み）", () => {
  test("承認するとカードの本文どおりに書き込まれ、スレに出る", async ({ page, context, request }) => {
    const apiKey = petTestApiKey("confirm");
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, { cookie: null, apiKey });

    const body = `カード承認の本文 ${Date.now()}`;
    await sendPetTool(page, "create_post", { threadId: thread.threadId, body });

    const card = page.getByTestId("pet-confirm-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("このスレに書き込みます");
    await expect(petCardDetail(page, "本文")).toHaveText(body);
    // Turnstile off の板なのでウィジェットは出ない。
    await expect(page.locator(".oc-pet-confirm-turnstile")).toHaveCount(0);

    await page.getByTestId("pet-confirm-run").click();
    await expect(page.getByText("実行しました。", { exact: true })).toBeVisible();
    await expect(page.getByTestId("pet-tool-line").filter({ hasText: "完了" })).toBeVisible();
    await expect(page.getByTestId("pet-messages")).toContainText("ツール結果(create_post)");

    await page.reload();
    const posted = page.locator(".oc-post-main").filter({ hasText: body });
    await expect(posted).toHaveCount(1);
  });

  test("取り消すと書き込まれず、AI に CANCELED が返る", async ({ page, context, request }) => {
    const apiKey = petTestApiKey("confirm");
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, { cookie: null, apiKey });

    const body = `取り消す本文 ${Date.now()}`;
    await sendPetTool(page, "create_post", { threadId: thread.threadId, body });
    await expect(page.getByTestId("pet-confirm-card")).toBeVisible();
    await page.getByTestId("pet-confirm-cancel").click();

    await expect(page.getByText("取り消しました。", { exact: true })).toBeVisible();
    await expect(page.getByTestId("pet-tool-line").filter({ hasText: "できませんでした" })).toBeVisible();
    // スタブにツール結果として届いた内容（= AI が見た内容）に CANCELED がある。
    await expect(page.getByTestId("pet-messages")).toContainText("CANCELED");
    await waitPetIdle(page);
    expect(await petLastMessageText(apiKey)).toContain('"code":"CANCELED"');

    await page.reload();
    await expect(page.locator(".oc-post-main").filter({ hasText: body })).toHaveCount(0);
  });

  test("always 板ではログイン済みでも Turnstile が出て、通るまで実行できない", async ({ page, context, request }) => {
    const apiKey = petTestApiKey("confirm");
    const board = await createPetBoard(request, { turnstile: "always" });
    const thread = await createPetThread(request, board.slug);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    // トークンをすぐには発行しない（通るまで押せないことを見る）。
    await openPetChat(page, context, { cookie: PET_SESSIONS.owner, holdTurnstile: true, apiKey });

    const body = `ターンスタイルの本文 ${Date.now()}`;
    await sendPetTool(page, "create_post", { threadId: thread.threadId, body });
    const card = page.getByTestId("pet-confirm-card");
    await expect(card).toBeVisible();
    await expect(page.locator(".oc-pet-confirm-turnstile")).toBeVisible();
    await expect(page.getByTestId("pet-confirm-run")).toBeDisabled();
    await shot(page, "pet-confirm-turnstile-disabled");

    await releaseTurnstile(page);
    await expect(page.getByTestId("pet-confirm-run")).toBeEnabled();
    await page.getByTestId("pet-confirm-run").click();
    await expect(page.getByText("実行しました。", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.locator(".oc-post-main").filter({ hasText: body })).toHaveCount(1);
  });

  test("30 分の通過記録がある板では Turnstile を出さない", async ({ page, context, request }) => {
    const apiKey = petTestApiKey("confirm");
    const board = await createPetBoard(request, { turnstile: "anonymous", turnstilePassMinutes: 30 });
    const thread = await createPetThread(request, board.slug);
    // 端末クッキーを先に固定してから画面を開く。初回読み込みでは複数の API が oc_did を
    // 発行し合うため、後から取得した値に固定すると、パスを作った端末と画面の端末がずれ得る。
    const did = fakeDeviceId();
    await pinDeviceCookie(context, did);
    // 同じ端末として 1 回投稿し、板の 30 分パスを作る（画面の投稿と同じ経路・同じ検証）。
    const seeded = await request.post(apiUrl(`/v1/threads/${thread.threadId}/posts`), {
      headers: {
        Origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        cookie: `oc_did=${did}`,
      },
      // レス作成は本文の `turnstileToken` を見る（ヘッダーは読まれない）。
      data: { body: "通過記録の下ごしらえ", turnstileToken: "1x00000000000000000000AA" },
    });
    expect(seeded.status(), await seeded.text()).toBe(201);

    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, { cookie: null, apiKey });

    const body = `通過記録ありの本文 ${Date.now()}`;
    await sendPetTool(page, "create_post", { threadId: thread.threadId, body });
    const card = page.getByTestId("pet-confirm-card");
    await expect(card).toBeVisible();
    await expect(page.locator(".oc-pet-confirm-turnstile")).toHaveCount(0);
    await page.getByTestId("pet-confirm-run").click();
    await expect(page.getByText("実行しました。", { exact: true })).toBeVisible();

    await page.reload();
    await expect(page.locator(".oc-post-main").filter({ hasText: body })).toHaveCount(1);
  });

  test("danger の管理操作は警告色と「実行する（取り消せません）」で、権限が無い人にはサーバーの拒否が返る", async ({
    page,
    context,
    request,
  }) => {
    const apiKey = petTestApiKey("confirm");
    const board = await createPetBoard(request);
    const thread = await createPetThread(request, board.slug);
    const target = await replyPetThread(request, thread.threadId, `非表示にする本文 ${Date.now()}`, PET_SESSIONS.user);

    // 板スタッフ（サイト管理者）として非表示にする。
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, { cookie: PET_SESSIONS.owner, apiKey });
    await sendPetTool(page, "hide_post", { postId: target.id, threadId: thread.threadId });
    const card = page.getByTestId("pet-confirm-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/oc-pet-confirm-danger/);
    await expect(page.getByTestId("pet-confirm-run")).toHaveText("実行する（取り消せません）");
    await shot(page, "pet-confirm-danger");
    await page.getByTestId("pet-confirm-run").click();
    await expect(page.getByText("実行しました。", { exact: true })).toBeVisible();
    await expect(page.getByTestId("pet-tool-line").filter({ hasText: "完了" })).toBeVisible();

    // 権限の無い利用者（板スタッフでない）は、サーバーの拒否がそのまま返る。
    const other = await replyPetThread(request, thread.threadId, `権限なしで消そうとする本文 ${Date.now()}`);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, { cookie: PET_SESSIONS.user, apiKey });
    await sendPetTool(page, "hide_post", { postId: other.id, threadId: thread.threadId });
    await expect(page.getByTestId("pet-confirm-card")).toBeVisible();
    await page.getByTestId("pet-confirm-run").click();
    const failed = page.getByTestId("pet-tool-line").filter({ hasText: "できませんでした" });
    await expect(failed).toBeVisible();
    await expect(failed).toContainText("板スタッフ権限");
    await waitPetIdle(page);
    expect(await petLastMessageText(apiKey)).toContain('"code":"FORBIDDEN"');
  });

  test("edit_my_post は always 板で Turnstile を出し、4096 バイトを超える本文はカードを出さない", async ({
    page,
    context,
    request,
  }) => {
    const apiKey = petTestApiKey("confirm");
    const board = await createPetBoard(request, { turnstile: "always" });
    const thread = await createPetThread(request, board.slug);
    const mine = await replyPetThread(request, thread.threadId, `編集する自分のレス ${Date.now()}`);
    await page.goto(`/b/${board.slug}/t/${thread.threadId}?r=all`);
    await openPetChat(page, context, { cookie: PET_SESSIONS.owner, holdTurnstile: true, apiKey });

    await sendPetTool(page, "edit_my_post", { postId: mine.id, threadId: thread.threadId, body: "直した本文" });
    const card = page.getByTestId("pet-confirm-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("自分のレスを書き換えます");
    await expect(page.locator(".oc-pet-confirm-turnstile")).toBeVisible();
    await expect(page.getByTestId("pet-confirm-run")).toBeDisabled();
    await releaseTurnstile(page);
    await expect(page.getByTestId("pet-confirm-run")).toBeEnabled();
    await page.getByTestId("pet-confirm-run").click();
    await expect(page.getByText("実行しました。", { exact: true })).toBeVisible();

    // 4096 バイトを超える日本語（1 文字 3 バイト）は、カードを出さずに引数エラーになる。
    await sendPetTool(page, "edit_my_post", {
      postId: mine.id,
      threadId: thread.threadId,
      body: "あ".repeat(1366),
    });
    await expect(page.getByTestId("pet-tool-line").filter({ hasText: "できませんでした" })).toBeVisible();
    await expect(page.getByTestId("pet-messages")).toContainText("4096 バイト");
    // 実行済みカードは決定済みの表示（`pet-confirm-card` ではない）になっている。
    await expect(page.locator(".oc-pet-confirm-done")).toHaveCount(1);
  });
});