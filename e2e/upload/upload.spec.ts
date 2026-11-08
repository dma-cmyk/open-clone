// アップローダの E2E（実スタック: wrangler dev + next dev + ローカル D1）。
// 外部サービスへは一切送らない:
//  - 通常は `mock` アダプタ（Worker 内で完結）だけを使う
//  - Catbox のスタブ検証は、API に CATBOX_API_URL（e2e/scripts/stub-server.mjs）を設定した環境で
//    E2E_UPLOAD_STUB=1 を付けたときだけ実行する（実 Catbox へ誤爆させないため）
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";
import { TURNSTILE, STUB_BASE, stubRequests } from "../helpers/stubs";

const USER_COOKIE = "oc_sess=e2e-user-session-token";
/** WP4 のビット列（PNG シグネチャ + IHDR 先頭。マジックバイト検証を通す最小構成）。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const UPLOAD_STUB = process.env.E2E_UPLOAD_STUB === "1";

interface PrepareData {
  ticketId: string;
  adapter: string;
  mode: string;
  plan: { mode: string; proxyPath?: string; url?: string };
  uploadToken?: string;
  maxBytes: number;
}

interface AttachmentData {
  id: string;
  url: string;
  kind: string;
  adapter: string;
  postId: number | null;
  size: number;
  filename: string;
}

async function headers(cookie = USER_COOKIE): Promise<Record<string, string>> {
  // /v1/uploads/prepare は Turnstile 必須（site_config `uploader.require_turnstile` 既定 true）。
  // 公式テストキー（常に成功）を送る。E2E_TURNSTILE_STUB=1 ならローカルスタブが検証する。
  return { Origin: ALLOWED_ORIGIN, cookie, "x-turnstile-token": TURNSTILE.successToken };
}

/** 期待ステータスと違えば応答本文付きで失敗させる（成功時は本文を消費しない）。 */
async function expectStatus(response: APIResponse, status: number): Promise<void> {
  if (response.status() === status) return;
  throw new Error(`expected HTTP ${status}, got ${response.status()}: ${await response.text()}`);
}

async function envelope<T>(response: APIResponse): Promise<T> {
  const body = await readEnvelope<T>(response);
  if (!body || !body.ok) {
    throw new Error(`API 失敗 (${response.status()}): ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function prepare(
  request: APIRequestContext,
  input: Record<string, unknown>,
  cookie = USER_COOKIE,
): Promise<PrepareData> {
  const response = await request.post(apiUrl("/v1/uploads/prepare"), {
    headers: await headers(cookie),
    data: input,
  });
  await expectStatus(response, 201);
  return envelope<PrepareData>(response);
}

/** proxy へ生バイトを送る（x-upload-token は URL に載せない）。 */
function proxy(request: APIRequestContext, plan: PrepareData, bytes: Buffer, cookie = USER_COOKIE): Promise<APIResponse> {
  return request.post(apiUrl(plan.plan.proxyPath!), {
    headers: {
      ...(cookie ? { cookie, Origin: ALLOWED_ORIGIN } : { Origin: ALLOWED_ORIGIN }),
      "content-type": "image/png",
      ...(plan.uploadToken ? { "x-upload-token": plan.uploadToken } : {}),
    },
    data: bytes,
  });
}

test.describe("アップローダ（mock アダプタで完結）", () => {
  test("prepare → proxy → commit → 履歴 → 投稿添付 → スレ表示 → 削除", async ({ page, request, context }) => {
    await context.addCookies([{ name: "oc_sess", value: "e2e-user-session-token", domain: "localhost", path: "/" }]);

    // 1. mock アダプタでアップロード（外部送信なし）
    const prepared = await prepare(request, {
      adapter: "mock",
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "pixel.png",
      purpose: "post",
    });
    expect(prepared.adapter).toBe("mock");
    expect(prepared.plan.mode).toBe("proxy-stream");
    expect(prepared.uploadToken).toBeTruthy();

    const proxied = await proxy(request, prepared, PNG_BYTES);
    await expectStatus(proxied, 200);
    const uploaded = await envelope<{ externalUrl: string; kind: string }>(proxied);
    expect(uploaded.kind).toBe("image");
    expect(uploaded.externalUrl).toContain("https://mock.uploads.local/");

    const committed = await request.post(apiUrl("/v1/uploads/commit"), {
      headers: await headers(),
      data: { ticketId: prepared.ticketId },
    });
    expect(committed.status()).toBe(201);
    const attachment = await envelope<AttachmentData>(committed);
    expect(attachment.url).toBe(uploaded.externalUrl);
    expect(attachment.postId).toBeNull();

    // 2. 履歴（未投稿）
    const history = await request.get(apiUrl("/v1/uploads/history?unattached=true"), { headers: await headers() });
    expect(history.status()).toBe(200);
    const historyBody = await envelope<{ items: AttachmentData[] }>(history);
    expect(historyBody.items.map((item) => item.id)).toContain(attachment.id);

    // 3. 板・スレを作成し、投稿に添付を紐付ける（attachToPost 経由）
    const slug = unique("upl");
    const board = await request.post(apiUrl("/v1/boards"), {
      headers: await headers(),
      data: { slug, name: "アップロード板", category: "テスト" },
    });
    await expectStatus(board, 201);

    const thread = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
      headers: await headers(),
      data: { title: "添付テスト", body: "画像を添付します", attachments: [attachment.id] },
    });
    await expectStatus(thread, 201);
    const threadData = await envelope<{ threadId: number }>(thread);

    const detail = await request.get(apiUrl(`/v1/threads/${threadData.threadId}`), { headers: await headers() });
    const detailBody = await envelope<{
      posts: Array<{ attachments?: Array<{ url: string }> }>;
    }>(detail);
    expect(detailBody.posts[0]!.attachments?.[0]?.url).toBe(uploaded.externalUrl);

    // 4. スレ画面に添付画像が表示される
    await page.goto(`/b/${slug}/t/${threadData.threadId}/`);
    const image = page.locator(`.oc-attachment img[src="${uploaded.externalUrl}"]`);
    await expect(image).toHaveCount(1);

    // 5. 削除（本人）
    const deleted = await request.delete(apiUrl(`/v1/uploads/${attachment.id}`), { headers: await headers() });
    await expectStatus(deleted, 200);
    const gone = await request.get(apiUrl(`/v1/uploads/${attachment.id}`), { headers: await headers() });
    expect(gone.status()).toBe(404);
  });

  test("アダプタ一覧と、板設定だけで保存先を切り替えられる", async ({ request }) => {
    const list = await request.get(apiUrl("/v1/uploads/adapters"), { headers: await headers() });
    expect(list.status()).toBe(200);
    const data = await envelope<{
      defaultAdapter: string;
      items: Array<{ id: string; mode: string; requiresGithub: boolean; available: boolean }>;
    }>(list);
    expect(data.defaultAdapter).toBe("catbox");
    expect(data.items.map((item) => item.id)).toEqual(
      expect.arrayContaining(["catbox", "litterbox", "cloudinary", "gist", "github", "mock"]),
    );
    expect(data.items.find((item) => item.id === "catbox")!.mode).toBe("proxy-stream");
    expect(data.items.find((item) => item.id === "gist")!.requiresGithub).toBe(true);

    const slug = unique("swap");
    const board = await request.post(apiUrl("/v1/boards"), {
      headers: await headers(),
      data: { slug, name: "切替板", category: "テスト" },
    });
    await expectStatus(board, 201);

    // 板設定 uploader=mock → adapter 未指定の prepare が mock になる
    const patch = await request.patch(apiUrl(`/v1/boards/${slug}`), {
      headers: await headers(),
      data: { settings: { uploader: "mock" } },
    });
    await expectStatus(patch, 200);

    const boardId = (await envelope<{ board: { id: number } }>(patch)).board.id;
    const prepared = await prepare(request, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "swap.png",
      boardId,
    });
    expect(prepared.adapter).toBe("mock");

    // クリーンアップ（途中で失敗しても他テストに影響しないように）
    await request.delete(apiUrl(`/v1/boards/${slug}?confirm=1`), { headers: await headers() });
  });

  test("他人（別端末）の添付は削除できない", async ({ request }) => {
    const prepared = await prepare(request, {
      adapter: "mock",
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "own.png",
    });
    expect((await proxy(request, prepared, PNG_BYTES)).status()).toBe(200);
    const committed = await request.post(apiUrl("/v1/uploads/commit"), {
      headers: await headers(),
      data: { ticketId: prepared.ticketId },
    });
    const attachment = await envelope<AttachmentData>(committed);

    // 未ログイン・別端末からの削除は 403
    const otherDevice = `oc_did=${"a".repeat(32)}`;
    const denied = await request.delete(apiUrl(`/v1/uploads/${attachment.id}`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: otherDevice },
    });
    expect(denied.status()).toBe(403);

    // 所有者は削除できる
    const allowed = await request.delete(apiUrl(`/v1/uploads/${attachment.id}`), { headers: await headers() });
    expect(allowed.status()).toBe(200);
  });

  test("サイズ超過・MIME 偽装・禁止拡張子は拒否する", async ({ request }) => {
    const tooLarge = await request.post(apiUrl("/v1/uploads/prepare"), {
      headers: await headers(),
      data: { adapter: "mock", contentType: "image/png", size: PNG_BYTES.length, filename: "a.exe" },
    });
    expect(tooLarge.status()).toBe(400);
    expect((await readEnvelope(tooLarge))?.ok).toBe(false);

    const spoofed = await prepare(request, {
      adapter: "mock",
      contentType: "image/png",
      size: 100,
      filename: "fake.png",
    });
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const mismatch = await proxy(request, spoofed, jpegBytes);
    expect(mismatch.status()).toBe(400);
  });
});

test.describe("C-1: アップロードの Turnstile は投稿と同じ板設定", () => {
  test("turnstile=off の板では匿名・ウィジェットなしで画像付き投稿できる", async ({ page, request }) => {
    const slug = unique("uioff");
    const board = await request.post(apiUrl("/v1/boards"), {
      headers: await headers(),
      data: {
        slug,
        name: "C1 アップロード板",
        category: "テスト",
        settings: { turnstile: "off", uploader: "mock", cooldownSeconds: 0 },
      },
    });
    await expectStatus(board, 201);
    const created = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
      headers: await headers(),
      data: { title: "C1 画像スレ", body: "アップロードの回帰テスト" },
    });
    await expectStatus(created, 201);
    const threadId = (await envelope<{ threadId: number }>(created)).threadId;

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });
    // モバイルは投稿欄が折りたたまれている。
    const openbar = page.locator(".oc-form-openbar");
    if (await openbar.isVisible()) await openbar.click();

    // 板設定 off なので、投稿用・アップロード用とも Turnstile は表示されない。
    await expect(page.locator(".oc-turnstile")).toHaveCount(0);

    const prepareResponse = page.waitForResponse(
      (response) => /\/api\/v1\/uploads\/prepare$/.test(response.url()) && response.request().method() === "POST",
    );
    await page.locator('.oc-form input[type="file"]').setInputFiles({
      name: "c1.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    const prepared = await prepareResponse;
    expect(prepared.status(), await prepared.text()).toBe(201);
    // トークンなしで通る（以前は 400 TURNSTILE_FAILED）。
    expect(prepared.request().headers()["x-turnstile-token"]).toBeUndefined();
    await expect(page.locator(".oc-ng-item").first()).toBeVisible({ timeout: 15_000 });

    const body = `匿名の画像付き投稿 ${Date.now()}`;
    await page.locator(".oc-form textarea").fill(body);
    const posted = page.waitForResponse(
      (response) =>
        new RegExp(`/api/v1/threads/${threadId}/posts$`).test(response.url()) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "投稿する" }).click();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(201);
    await expect(page.locator(".oc-post", { hasText: body })).toBeVisible({ timeout: 15_000 });
  });

  test("turnstile=anonymous の板ではアップロード用ウィジェットが出てトークン付きで通る", async ({ page, request }) => {
    const slug = unique("uianon");
    const board = await request.post(apiUrl("/v1/boards"), {
      headers: await headers(),
      data: {
        slug,
        name: "C1 匿名Turnstile板",
        category: "テスト",
        settings: { turnstile: "anonymous", uploader: "mock", cooldownSeconds: 0 },
      },
    });
    await expectStatus(board, 201);
    const created = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
      headers: await headers(),
      data: { title: "C1 Turnstile スレ", body: "ウィジェットのテスト" },
    });
    await expectStatus(created, 201);
    const threadId = (await envelope<{ threadId: number }>(created)).threadId;

    // Turnstile スクリプトは外部へ取りに行かず、即トークンを返すスタブにする。
    await page.addInitScript(() => {
      const widgets = new Map<string, { callback?: (token: string) => void }>();
      let seq = 0;
      (window as unknown as { turnstile: unknown }).turnstile = {
        render(_element: HTMLElement, options: { callback?: (token: string) => void }) {
          seq += 1;
          const id = `stub-${seq}`;
          widgets.set(id, options);
          // 実ウィジェット同様に高さを持つ要素を挿し、表示状態を検証できるようにする。
          const mark = document.createElement("div");
          mark.textContent = "stub-widget";
          _element.appendChild(mark);
          setTimeout(() => options.callback?.(`stub-token-${seq}`), 0);
          return id;
        },
        reset(id: string) {
          const options = widgets.get(id);
          if (options) setTimeout(() => options.callback?.(`stub-token-${Date.now()}`), 0);
        },
        remove(id: string) {
          widgets.delete(id);
        },
      };
    });

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });
    const openbar = page.locator(".oc-form-openbar");
    if (await openbar.isVisible()) await openbar.click();
    await expect(page.locator(".oc-upload-turnstile .oc-turnstile").first()).toBeVisible();

    const prepareResponse = page.waitForResponse(
      (response) => /\/api\/v1\/uploads\/prepare$/.test(response.url()) && response.request().method() === "POST",
    );
    await page.locator('.oc-form input[type="file"]').setInputFiles({
      name: "anon.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    const prepared = await prepareResponse;
    expect(prepared.status(), await prepared.text()).toBe(201);
    expect(prepared.request().headers()["x-turnstile-token"]).toContain("stub-token-");
    await expect(page.locator(".oc-ng-item").first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Catbox 中継（スタブ設定時のみ）", () => {
  test.skip(!UPLOAD_STUB, "CATBOX_API_URL をスタブに向けた環境（E2E_UPLOAD_STUB=1）でのみ実行");

  test("既定アダプタ（catbox）が Worker 中継で外部へ送られ、URL が表示できる", async ({ request }) => {
    const prepared = await prepare(request, {
      contentType: "image/png",
      size: PNG_BYTES.length,
      filename: "pixel.png",
    });
    expect(prepared.adapter).toBe("catbox");
    expect(prepared.plan.proxyPath).toBeTruthy();

    const proxied = await proxy(request, prepared, PNG_BYTES);
    await expectStatus(proxied, 200);
    const uploaded = await envelope<{ externalUrl: string }>(proxied);
    expect(uploaded.externalUrl.startsWith(`${STUB_BASE}/files/`)).toBe(true);

    const committed = await request.post(apiUrl("/v1/uploads/commit"), {
      headers: await headers(),
      data: { ticketId: prepared.ticketId },
    });
    expect(committed.status()).toBe(201);

    // スタブが multipart を受け取っている（= Worker が中継した）
    const requests = await stubRequests();
    expect(requests.some((entry) => entry.url.includes("/user/api.php") && entry.body.includes("fileToUpload"))).toBe(
      true,
    );
  });
});