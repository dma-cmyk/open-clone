// rv-core A5/A6: 添付が保存先に拒否されたときの見せ方。
// 回帰対象: ChatGPT F-03（Catbox が HTTP 412 を返し、原因も次の操作も分からない）、
//           F-08（360px で長いエラーに押されて添付ボタンが縦に潰れる）。
// 外部サービスへは送らない: 板の保存先を catbox にし、E2E の Catbox スタブ（CATBOX_API_URL）が
// ファイル名に "e2e-fail" を含むアップロードへ 412 を返す仕組みを使う（実 Catbox へは接続しない）。
import { expect, test } from "@playwright/test";
import { apiUrl } from "../helpers/api";
import { createBoard, createThread, expandPostForm, ownerHeaders, stubBlockedProxy } from "./rv-core-helpers";
import { resetStubs, stubRequests } from "../helpers/stubs";


/** マジックバイト検証を通る最小の PNG。 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test.describe("rv-core A5/A6: 添付失敗の説明と狭幅レイアウト", () => {
  test("保存先の拒否（HTTP 412）を日本語で説明し、再試行・保存先変更・キャンセルを出す", async ({
    page,
    request,
  }) => {
    const slug = await createBoard(request, { turnstile: "off", uploader: "catbox" });
    const threadId = await createThread(request, slug);
    await page.setViewportSize({ width: 360, height: 740 });
    await stubBlockedProxy(page);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    const prepare = page.waitForResponse(
      (response) => /\/api\/v1\/uploads\/prepare$/.test(new URL(response.url()).pathname),
    );
    await page.locator('.oc-form input[type="file"]').setInputFiles({
      name: "e2e-fail.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    expect((await prepare).status()).toBe(201);

    const error = page.locator(".oc-upload-error");
    await expect(error).toBeVisible({ timeout: 30_000 });
    // 原因（保存先が拒否した）と次の操作が分かる文言
    await expect(error).toContainText("HTTP 412");
    await expect(error).toContainText("保存先を別のものに変えてください");
    await expect(error.getByRole("button", { name: "再試行" })).toBeVisible();
    await expect(error.getByRole("button", { name: "キャンセル" })).toBeVisible();
    // 狭幅の投稿フォームでは保存先セレクトをエラー行に出す（その場で保存先を変えられる）
    await expect(error.getByLabel("保存先")).toBeVisible();

    // エラーはボタンの下の独立した行。添付ボタンが潰れていないこと（F-08）。
    const pick = page.locator(".oc-form .oc-upload-pick").first();
    const pickBox = await pick.boundingBox();
    const errorBox = await error.boundingBox();
    const uploaderBox = await page.locator(".oc-form .oc-uploader").first().boundingBox();
    expect(pickBox).not.toBeNull();
    expect(errorBox).not.toBeNull();
    // ボタンは 1 行の高さ（縦に折り返して 2〜4 行にならない）
    expect(pickBox?.height ?? 0).toBeLessThan(44);
    expect(pickBox?.width ?? 0).toBeGreaterThanOrEqual(96);
    // エラー行はアップローダの幅いっぱい（ボタンと同じ行に押し込まれていない）
    expect(Math.abs((errorBox?.width ?? 0) - (uploaderBox?.width ?? 0))).toBeLessThanOrEqual(2);
    // エラーはボタンより下にある
    expect(errorBox?.y ?? 0).toBeGreaterThanOrEqual((pickBox?.y ?? 0) + (pickBox?.height ?? 0));
  });

  test("「再試行」は同じファイルを送り直し、「キャンセル」で表示を消せる", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off", uploader: "catbox" });
    const threadId = await createThread(request, slug);
    await stubBlockedProxy(page);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    const firstPrepare = page.waitForResponse(
      (response) => /\/api\/v1\/uploads\/prepare$/.test(new URL(response.url()).pathname),
    );
    await page.locator('.oc-form input[type="file"]').setInputFiles({
      name: "e2e-fail-2.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    expect((await firstPrepare).status()).toBe(201);
    const error = page.locator(".oc-upload-error");
    await expect(error).toBeVisible({ timeout: 30_000 });

    const retryPrepare = page.waitForResponse(
      (response) => /\/api\/v1\/uploads\/prepare$/.test(new URL(response.url()).pathname),
    );
    await error.getByRole("button", { name: "再試行" }).click();
    const retried = await retryPrepare;
    expect(retried.status()).toBe(201);
    expect((retried.request().postDataJSON() as { filename?: string } | null)?.filename).toBe("e2e-fail-2.png");
    await expect(error).toBeVisible({ timeout: 30_000 });

    await page.locator(".oc-upload-error").getByRole("button", { name: "キャンセル" }).click();
    await expect(page.locator(".oc-upload-error")).toHaveCount(0);
  });

  test("保存先を切り替えると、その保存先でアップロードし直せる", async ({ page, request }) => {
    // 既定は失敗する catbox、切り替え先の mock は Worker 内で完結して成功する
    const slug = await createBoard(request, { turnstile: "off", uploader: "catbox" });
    const threadId = await createThread(request, slug);
    await page.setViewportSize({ width: 360, height: 740 });
    await stubBlockedProxy(page);
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    await page.locator('.oc-form input[type="file"]').setInputFiles({
      name: "e2e-fail-3.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    const error = page.locator(".oc-upload-error");
    await expect(error).toBeVisible({ timeout: 30_000 });

    await error.getByLabel("保存先").selectOption("mock");
    // 保存先を変えたので、差し替えていた失敗応答を外して実際の mock アップロードを通す
    await page.unroute(/\/api\/v1\/uploads\/proxy/);
    await error.getByRole("button", { name: "再試行" }).click();
    // アップロード成功で添付チップが出る
    await expect(page.locator(".oc-ng-item", { hasText: "e2e-fail-3.png" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".oc-upload-error")).toHaveCount(0);
  });

  test("API は保存先の 412 を、利用者向けメッセージ込みの 502 として返す（スタブ隔離が保証されるときだけ）", async ({
    request,
  }) => {
    // 外部保存先へ送らないための前提: Worker の Catbox 中継先がローカルスタブへ差し替わっていること。
    // 差し替えなし（E2E_UPLOAD_STUB 未設定）では、このテストはファイルを一切送らずに止める。
    test.skip(
      process.env.E2E_UPLOAD_STUB !== "1",
      "E2E_UPLOAD_STUB=1（保存先をローカルスタブへ差し替え）が未設定のため実行しない。上流 412 の翻訳は apps/api/test/upload-catbox-rejected.test.ts（MSW でローカル再現）で検証する。",
    );
    // このリクエストでスタブが受けたかを確かめるため、ログを空にしてから送る。
    await resetStubs();

    const headers = ownerHeaders();
    // E2E の Catbox スタブは、ファイル名に "e2e-fail" を含む multipart へ 412 を返す。
    const filename = `e2e-fail-rvcore-${Date.now().toString(36)}.png`;
    const prepared = await request.post(apiUrl("/v1/uploads/prepare"), {
      headers,
      data: { filename, contentType: "image/png", size: PNG_BYTES.length, adapter: "catbox" },
    });
    expect(prepared.status(), await prepared.text()).toBe(201);
    const plan = (await prepared.json()) as {
      data: { ticketId: string; adapter: string; plan: { proxyPath: string }; uploadToken: string };
    };
    expect(plan.data.adapter).toBe("catbox");

    const proxy = await request.post(apiUrl(plan.data.plan.proxyPath), {
      headers: { ...headers, "x-upload-token": plan.data.uploadToken, "content-type": "image/png" },
      data: PNG_BYTES,
    });
    expect(proxy.status()).toBe(502);
    const body = (await proxy.json()) as { ok: boolean; code: string; message: string; details?: unknown };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("BAD_GATEWAY");
    expect(body.message).toContain("HTTP 412");
    expect(body.message).toContain("保存先を別のものに変えてください");
    expect(body.details).toMatchObject({ upstreamStatus: 412, adapter: "catbox", retryable: true });

    // 中継が実際にローカルスタブへ届いたこと（このリクエストのファイル名で紐付ける）
    const hits = (await stubRequests()).filter((entry) => entry.url.includes("/user/api.php"));
    expect(hits.length, "スタブへ中継されていない（実サービスへ送った可能性がある）").toBe(1);
    expect(hits[0]!.body).toContain(filename);
  });
});
