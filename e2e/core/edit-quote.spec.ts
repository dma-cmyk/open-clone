// 71: レス・スレの編集・削除・引用スレ（E2E）。
// 匿名ブラウザ（Cookie のみ）で書いたレスを編集→履歴→本人削除、別ブラウザからは不可、
// スレの編集・削除、引用して新スレ（カードと引用一覧）、レス内スレ URL カード、板設定の不許可。
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";
function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: OWNER_COOKIE,
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

async function createBoardApi(request: APIRequestContext): Promise<string> {
  const slug = unique("eq").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `編集引用 ${slug}`,
      category: "E2E",
      description: "編集・削除・引用の E2E",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  if (response.status() !== 201) {
    throw new Error(`板作成失敗: ${response.status()} ${await response.text()}`);
  }
  return slug;
}

async function createThreadApi(
  request: APIRequestContext,
  slug: string,
  input: { title?: string; body?: string; quoteThreadId?: number } = {},
): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: input.title ?? `スレ ${Date.now()}`, body: input.body ?? "1げっと", quoteThreadId: input.quoteThreadId },
  });
  if (response.status() !== 201) {
    throw new Error(`スレ作成失敗: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as { data?: { threadId?: number } };
  const threadId = body.data?.threadId;
  if (!threadId) throw new Error("threadId なし");
  return threadId;
}

/**
 * 投稿フォームを開く。スマホ（Pixel 7 幅）では投稿欄が「✏ …」の 1 行バーに畳まれる。
 * 初期レンダリングは展開状態→useEffect で折りたたむため、単純な count チェックは競合する。
 * 目的のフォームの入力欄が見えるまで待ち、見えなければバーをクリックして開く。
 * `buttonName` は対象フォームの送信ボタン（例: /投稿する/・/スレを立てる/）。
 */
async function expandForm(page: Page, buttonName: RegExp): Promise<void> {
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: buttonName }) }).first();
  const field = form.locator("textarea").first();
  // モバイルでは初期展開→useEffect で折りたたむ競合がある。可視を確認したら settle 待ちを挟み、
  // 折りたたみの useEffect に追い越されないことを確かめてから返す。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await field.waitFor({ state: "visible", timeout: 3_000 });
    } catch {
      // 見えない = 畳まれている。バーをクリックして開く。
      const bar = page.locator(".oc-form-openbar").first();
      if ((await bar.count()) > 0) await bar.click({ timeout: 2_000 }).catch(() => undefined);
      continue;
    }
    await page.waitForTimeout(500);
    if (await field.isVisible()) return;
  }
  await field.waitFor({ state: "visible", timeout: 5_000 });
}




test.describe("編集・削除・引用スレ", () => {
  test("匿名ブラウザでレスを書き→編集→「編集済み」と履歴→本人削除→表示", async ({ page, request }) => {
    const slug = await createBoardApi(request);
    const threadId = await createThreadApi(request, slug, { title: "編集削除スレ", body: "1 の本文" });

    await page.goto(`/b/${slug}/t/${threadId}?r=l50`);


    // 投稿フォームに本文を書いて投稿（匿名 = Cookie だけ）。
    await expandForm(page, /投稿する/);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: /投稿する/ }) }).first();
    await form.locator("textarea").first().fill("自分の書いたレス");
    await form.getByRole("button", { name: /投稿する/ }).click();
    await expect(page.locator(".oc-post").filter({ hasText: "自分の書いたレス" })).toBeVisible({ timeout: 15_000 });

    // 編集ボタン（自分のレスだけに出る）→ モーダルで本文を書き換える。
    const myPost = page.locator(".oc-post").filter({ hasText: "自分の書いたレス" });
    await myPost.getByRole("button", { name: "編集" }).click();
    const modal = page.locator(".oc-modal").filter({ hasText: "を編集" });
    await expect(modal).toBeVisible();
    await modal.locator("textarea").fill("自分の書いたレス（編集後）");
    await modal.getByRole("button", { name: /編集を保存/ }).click();
    await expect(myPost.filter({ hasText: "自分の書いたレス（編集後）" })).toBeVisible({ timeout: 15_000 });

    // 「編集済み（1回）」バッジ → クリックで履歴モーダル（誰でも見られる）。
    await myPost.getByRole("button", { name: /編集済み/ }).click();
    const history = page.locator(".oc-modal").filter({ hasText: "編集履歴" });
    await expect(history).toBeVisible();
    await expect(history.locator(".oc-post-history")).toContainText("自分の書いたレス");
    await history.getByRole("button", { name: "閉じる" }).click();

    // 本人削除 → 「投稿者により削除されました」表示（レス番号は残る）。
    page.once("dialog", (dialog) => void dialog.accept());
    await myPost.getByRole("button", { name: "削除" }).click();
    await expect(page.locator(".oc-post").filter({ hasText: "投稿者により削除されました" })).toBeVisible({
      timeout: 15_000,
    });
  });

  test.slow();
  test("別ブラウザからは編集・削除ボタンが無く API も 403", async ({ browser, request }) => {
    const slug = await createBoardApi(request);
    const threadId = await createThreadApi(request, slug, { title: "別端末のスレ", body: "1" });

    // 匿名 A がレスを書く。
    const pageA = await (await browser.newContext()).newPage();
    await pageA.goto(`/b/${slug}/t/${threadId}?r=l50`);
    await expandForm(pageA, /投稿する/);
    const formA = pageA.locator("form").filter({ has: pageA.getByRole("button", { name: /投稿する/ }) }).first();
    await formA.locator("textarea").first().fill("A のレス");
    await formA.getByRole("button", { name: /投稿する/ }).click();
    await expect(pageA.locator(".oc-post").filter({ hasText: "A のレス" })).toBeVisible({ timeout: 15_000 });

    // A のレスの post id を API から取る（pageA と同じ Cookie を使う）。
    const cookies = await pageA.context().cookies();
    const did = cookies.find((cookie) => cookie.name === "oc_did")?.value ?? "";
    const detail = await request.get(apiUrl(`/v1/threads/${threadId}?r=l50`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: `oc_did=${did}` },
    });
    const data = ((await detail.json()) as { data?: { posts?: Array<{ id: number; body: string }> } }).data;
    const target = data?.posts?.find((post) => post.body === "A のレス");
    expect(target).toBeTruthy();

    // 別ブラウザ B: 編集・削除ボタンが無い。
    const pageB = await (await browser.newContext()).newPage();
    await pageB.goto(`/b/${slug}/t/${threadId}?r=l50`);
    await expect(pageB.locator(".oc-post").filter({ hasText: "A のレス" })).toBeVisible({ timeout: 15_000 });
    const foreignPost = pageB.locator(".oc-post").filter({ hasText: "A のレス" });
    await expect(foreignPost.getByRole("button", { name: "編集", exact: true })).toHaveCount(0);
    await expect(foreignPost.getByRole("button", { name: "削除", exact: true })).toHaveCount(0);

    // B の端末から API を叩いても 403。
    const bHeaders = {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "x-real-ip": "203.0.113.99",
    };
    const edit = await request.patch(apiUrl(`/v1/posts/${target!.id}`), { headers: bHeaders, data: { body: "乗っ取り" } });
    expect(edit.status()).toBe(403);
    const del = await request.delete(apiUrl(`/v1/posts/${target!.id}`), { headers: bHeaders });
    expect(del.status()).toBe(403);
    await pageA.close();
    await pageB.close();
  });

  test("スレ主がタイトルと本文を編集し、他人レスありでも板スタッフならスレを削除できる", async ({ page, request }) => {
    const slug = await createBoardApi(request);
    const threadId = await createThreadApi(request, slug, { title: "編集するスレ", body: "元の本文" });

    await page.goto(`/b/${slug}/t/${threadId}?r=l50`);
    // スレ主（owner セッションで立てた）が「スレを編集」を開く。
    await page.context().addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: new URL(page.url()).hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.reload();
    await page.getByRole("button", { name: /スレを編集/ }).click();
    const modal = page.locator(".oc-modal").filter({ hasText: "スレを編集" });
    await expect(modal).toBeVisible();
    await modal.getByLabel(/スレタイ/).fill("編集後のスレタイ");
    await modal.locator("textarea").fill("編集後の本文");
    await modal.getByRole("button", { name: /編集を保存/ }).click();
    await expect(page.getByRole("heading", { name: /編集後のスレタイ/ })).toBeVisible({ timeout: 15_000 });

    // 他人のレスを 1 件足してスレ本人削除を試みると 403。
    const other = await request.post(apiUrl(`/v1/threads/${threadId}/posts`), {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", "x-real-ip": "203.0.113.50" },
      data: { body: "他人のレス" },
    });
    expect(other.status()).toBe(201);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: /スレを削除/ }).click();
    await expect(page.locator(".oc-toast, .oc-toast-stack").last()).toContainText(/削除/, { timeout: 15_000 }).catch(() => {
      // toast が無くても下の still チェックで判定する。
    });
    // m2 修正: スレ主が板スタッフでもある場合（owner = 板管理人）はスタッフ削除が通る
    //（他人レスがあっても削除できる）。スレは削除済み（409）になる。
    await page.waitForTimeout(1_000);
    const still = await request.get(apiUrl(`/v1/threads/${threadId}`), { headers: { Origin: ALLOWED_ORIGIN } });
    expect(still.status()).toBe(409);
  });

  test("引用して新スレ: カード表示と元スレ側の引用一覧", async ({ page, request }) => {
    const slug = await createBoardApi(request);
    const sourceId = await createThreadApi(request, slug, { title: "引用されるスレ", body: "元の本文" });

    // スレ画面から「引用して新スレ」→ 板ページの ?quote= 経由でスレ立て。
    await page.goto(`/b/${slug}/t/${sourceId}?r=l50`);
    await page.getByRole("button", { name: /引用して新スレ/ }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}/\\?quote=${sourceId}`), { timeout: 15_000 });

    await expandForm(page, /スレを立てる/);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: /スレを立てる/ }) }).first();
    await expect(form.getByLabel(/スレタイ/)).toBeVisible({ timeout: 15_000 });
    await form.getByLabel(/スレタイ/).fill("引用して立てたスレ");
    await form.locator("textarea").first().fill("新しいスレの本文");
    await form.getByRole("button", { name: /スレを立てる/ }).click();
    await expect(page).toHaveURL(/\/b\/[^/]+\/t\/\d+/, { timeout: 15_000 });

    // 新スレの先頭に引用元カード。
    await expect(page.locator(".oc-quote-card").filter({ hasText: "引用されるスレ" })).toBeVisible({ timeout: 15_000 });

    // 元スレの画面に「引用したスレ」一覧。
    await page.goto(`/b/${slug}/t/${sourceId}?r=l50`);
    await page.getByRole("button", { name: /引用したスレ/ }).click();
    const quotes = page.locator(".oc-modal").filter({ hasText: "このスレを引用したスレ" });
    await expect(quotes).toBeVisible();
    await expect(quotes.locator(".oc-quote-ref-row")).toContainText("引用して立てたスレ");
  });

  test("レス内のスレ URL がカードになる", async ({ page, request }) => {
    const slug = await createBoardApi(request);
    const targetId = await createThreadApi(request, slug, { title: "カード対象スレ", body: "本文" });

    // レスに自サイトのスレ URL を含めて投稿する。
    const threadId = await createThreadApi(request, slug, { title: "URL を貼るスレ", body: "1" });
    const posted = await request.post(apiUrl(`/v1/threads/${threadId}/posts`), {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", "x-real-ip": "203.0.113.51" },
      data: { body: `スレはこちら /b/${slug}/t/${targetId} をどうぞ` },
    });
    expect(posted.status()).toBe(201);

    await page.goto(`/b/${slug}/t/${threadId}?r=l50`);
    const card = page.locator(".oc-thread-link-card").filter({ hasText: "カード対象スレ" });
    await expect(card).toBeVisible({ timeout: 15_000 });
  });

  test("板の管理画面で不許可にするとボタンが消え API が 403", async ({ page, request }) => {
    const slug = await createBoardApi(request);
    const threadId = await createThreadApi(request, slug, { title: "不許可のスレ", body: "1" });

    // 匿名でレスを 1 件（編集・削除の対象）。
    await page.goto(`/b/${slug}/t/${threadId}?r=l50`);
    await expandForm(page, /投稿する/);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: /投稿する/ }) }).first();
    await form.locator("textarea").first().fill("不許可前に書いたレス");
    await form.getByRole("button", { name: /投稿する/ }).click();
    await expect(page.locator(".oc-post").filter({ hasText: "不許可前に書いたレス" })).toBeVisible({ timeout: 15_000 });
    const cookies = await page.context().cookies();
    const did = cookies.find((cookie) => cookie.name === "oc_did")?.value ?? "";
    const detail = await request.get(apiUrl(`/v1/threads/${threadId}?r=l50`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: `oc_did=${did}` },
    });
    const data = ((await detail.json()) as { data?: { posts?: Array<{ id: number; body: string }> } }).data;
    const target = data?.posts?.find((post) => post.body === "不許可前に書いたレス");
    expect(target).toBeTruthy();

    // 管理画面でレス編集を不許可にする。
    await page.context().addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: new URL(page.url()).hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto(`/b/${slug}/manage/basic`);
    const editCheck = page.getByLabel("レス編集", { exact: true });
    await expect(editCheck).toBeVisible({ timeout: 15_000 });
    await editCheck.uncheck();
    await page.getByRole("button", { name: /保存する/ }).click();
    await expect(page.locator(".oc-toast, .oc-toast-stack").first()).toBeVisible({ timeout: 15_000 }).catch(() => {
      // toast が無くても保存 API の完了で判定する（下の 403 チェックが本体）。
    });

    // 画面: 編集ボタンが消える。
    await page.goto(`/b/${slug}/t/${threadId}?r=l50`);
    await expect(page.locator(".oc-post").filter({ hasText: "不許可前に書いたレス" })).toBeVisible({ timeout: 15_000 });
    const targetPost = page.locator(".oc-post").filter({ hasText: "不許可前に書いたレス" });
    await expect(targetPost.getByRole("button", { name: "編集", exact: true })).toHaveCount(0);

    // API: 本人でも 403。
    const edit = await request.patch(apiUrl(`/v1/posts/${target!.id}`), {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", cookie: `oc_did=${did}` },
      data: { body: "不許可なのに編集" },
    });
    expect(edit.status()).toBe(403);
  });

  test("編集がリアルタイムで別ブラウザに反映される（post.updated）", async ({ browser, request }) => {
    const slug = await createBoardApi(request);
    const threadId = await createThreadApi(request, slug, { title: "リアルタイム反映のスレ", body: "1" });

    // A がレスを投稿し、B が同じスレを開いて待つ。
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.goto(`/b/${slug}/t/${threadId}?r=l50`);
    await expandForm(pageA, /投稿する/);
    const formA = pageA.locator("form").filter({ has: pageA.getByRole("button", { name: /投稿する/ }) }).first();
    await formA.locator("textarea").first().fill("リアルタイム反映の対象レス");
    await formA.getByRole("button", { name: /投稿する/ }).click();
    await expect(pageA.locator(".oc-post").filter({ hasText: "リアルタイム反映の対象レス" })).toBeVisible({
      timeout: 15_000,
    });

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto(`/b/${slug}/t/${threadId}?r=l50`);
    await expect(pageB.locator(".oc-post").filter({ hasText: "リアルタイム反映の対象レス" })).toBeVisible({
      timeout: 15_000,
    });

    // 実況（ポーリング）を ON にする（post.updated → onInvalidate → 再取得の経路）。
    await pageB.getByRole("button", { name: /実況/ }).click();
    // A が編集 → B の画面が再読み込みなしで新本文に変わる（post.updated → onInvalidate → 再取得）。
    await pageA
      .locator(".oc-post")
      .filter({ hasText: "リアルタイム反映の対象レス" })
      .getByRole("button", { name: "編集" })
      .click();
    const modal = pageA.locator(".oc-modal").filter({ hasText: "を編集" });
    await expect(modal).toBeVisible();
    await modal.locator("textarea").fill("リアルタイム反映の編集後本文");
    await modal.getByRole("button", { name: /編集を保存/ }).click();

    await expect(pageB.locator(".oc-post").filter({ hasText: "リアルタイム反映の編集後本文" })).toBeVisible({
      timeout: 20_000,
    });

    await pageA.close();
    await pageB.close();
    await contextA.close();
    await contextB.close();
  });

  test("管理画面の保存で既定のレス上限（maxPosts）が保存される", async ({ page, request }) => {
    const slug = await createBoardApi(request);
    await page.context().addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto(`/b/${slug}/manage/basic`);

    const maxPostsInput = page.getByLabel(/既定のレス上限/);
    await expect(maxPostsInput).toBeVisible({ timeout: 15_000 });
    await maxPostsInput.fill("500");
    await page.getByRole("button", { name: /保存する/ }).click();

    // 保存後、API で板設定の maxPosts が 500 になっていることを確認。
    await page.waitForTimeout(1_000);
    const detail = await request.get(apiUrl(`/v1/boards/${slug}`), { headers: { Origin: ALLOWED_ORIGIN } });
    expect(detail.status()).toBe(200);
    const board = (await detail.json()) as { data?: { board?: { settings?: { maxPosts?: number } } } };
    expect(board.data?.board?.settings?.maxPosts).toBe(500);
  });
});
