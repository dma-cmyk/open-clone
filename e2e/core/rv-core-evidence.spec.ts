// 証拠スクリーンショット生成（通常のテスト実行では skip）。
// 使い方: E2E_EVIDENCE=1 E2E_EVIDENCE_DIR=/path/to/10_証拠 pnpm exec playwright test core/rv-core-evidence.spec.ts --project=pc
import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { createBoard, createThread, expandPostForm, postForm, postReply, stubBlockedProxy, stubTurnstile } from "./rv-core-helpers";

const OUT_DIR = process.env.E2E_EVIDENCE_DIR ?? "";
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test.skip(!process.env.E2E_EVIDENCE, "E2E_EVIDENCE=1 のときだけ実行する");

test.describe("証拠画像", () => {
  test("PC: 投稿フォーム（Turnstile 1 個・文字数カウンタ・安価）", async ({ page, request }) => {
    await stubTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug, { title: `証拠用スレ ${new Date().toISOString()}`, body: "証拠用の 1 レス目" });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await postReply(request, threadId, ">>1 安価の証拠");
    // 安価（被参照）はサーバー計算なので、読み込み直してから撮る
    await page.reload();
    await expect(page.locator("#p1 .oc-backlinks")).toContainText("安価 2", { timeout: 30_000 });
    await postForm(page).locator("textarea").fill("文字数カウンタの証拠本文です。");
    await expect(page.locator(".oc-form-count")).toContainText("文字");
    await page.screenshot({ path: `${OUT_DIR}/01_pc_thread_form_turnstile_counter.png`, fullPage: false });
    await expect(page).toHaveTitle(/^証拠用スレ /);
    await page.screenshot({ path: `${OUT_DIR}/02_pc_thread_after_post.png`, fullPage: false });
  });

  test("PC: 設定画面（遷移後のタイトル）", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("h2").first()).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveTitle(/^設定 ｜ /);
    await page.screenshot({ path: `${OUT_DIR}/03_pc_settings_title.png` });
  });

  test("360px: 添付失敗の独立行と 44px 操作領域", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off", uploader: "catbox" });
    const threadId = await createThread(request, slug, { body: "狭幅の証拠" });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);
    await stubBlockedProxy(page);
    await page.locator('.oc-form input[type="file"]').setInputFiles({
      name: "e2e-fail.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    await expect(page.locator(".oc-upload-error")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${OUT_DIR}/04_narrow360_upload_error_row.png`, fullPage: false });
    await page.locator(".oc-upload-error").getByRole("button", { name: "キャンセル" }).click();
    await page.screenshot({ path: `${OUT_DIR}/05_narrow360_thread_actions.png`, fullPage: false });
  });

  test("360px: スレ内検索の解除と投稿フォーム", async ({ page, request }) => {
    await stubTurnstile(page);
    const slug = await createBoard(request, { turnstile: "anonymous" });
    const threadId = await createThread(request, slug, { body: "検索証拠の本文" });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("スレ内検索").fill("検索証拠");
    await page.locator(".oc-thread-head form").getByRole("button", { name: "検索" }).click();
    await expect(page.locator(".oc-badge", { hasText: "スレ内検索:" })).toBeVisible();
    await page.screenshot({ path: `${OUT_DIR}/06_narrow360_search_applied.png` });
    await page.getByRole("button", { name: "解除" }).click();
    await expect(page.getByLabel("スレ内検索")).toHaveValue("");
    await expandPostForm(page);
    await page.locator(".oc-form .oc-turnstile .stub-turnstile").waitFor();
    await page.screenshot({ path: `${OUT_DIR}/07_narrow360_search_cleared_form.png`, fullPage: false });
  });

  test("お絵かきモーダルの確定ボタン", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug);
    for (const size of [
      { width: 1280, height: 800, name: "08_pc" },
      { width: 360, height: 740, name: "09_narrow360" },
    ]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`/b/${slug}/t/${threadId}`);
      await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
      await expandPostForm(page);
      await page.getByRole("button", { name: /お絵かき/ }).click();
      await expect(page.locator(".oc-modal")).toBeVisible();
      await page.screenshot({ path: `${OUT_DIR}/${size.name}_oekaki_modal.png`, fullPage: false });
      await page.locator(".oc-modal").getByRole("button", { name: "キャンセル" }).click();
    }
  });
});

test.describe("証拠画像（A2 追加経路）", () => {
  test("ログイン後の ?next=/boards/new と、ログアウト後のトップ", async ({ page, request }) => {
    const email = `rvcore-evidence-${Date.now().toString(36)}@example.com`;
    const password = "e2e-Password-1";
    await request.post(apiUrl("/v1/auth/register"), {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      data: { name: "rvcore evidence", email, password },
    });

    await page.goto(`/account/login?next=${encodeURIComponent("/boards/new")}`);
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill(password);
    await page.getByRole("button", { name: "ログイン" }).last().click();
    await expect(page).toHaveURL(/\/boards\/new$/, { timeout: 20_000 });
    await expect(page.getByLabel(/板スラッグ/)).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${OUT_DIR}/10_pc_login_next_boards_new.png`, fullPage: false });

    const login = await request.post(apiUrl("/v1/auth/login"), {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      data: { email, password },
    });
    const token = /oc_sess=([^;]+)/.exec(login.headers()["set-cookie"] ?? "")?.[1] ?? "";
    const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3111");
    await page.context().addCookies([
      { name: "oc_sess", value: token, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/account");
    await page.getByRole("button", { name: /ログアウト/ }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.locator(".oc-hero h1")).toContainText("おーぷんクローン", { timeout: 20_000 });
    await page.screenshot({ path: `${OUT_DIR}/11_pc_logout_home.png`, fullPage: false });
  });

  test("hash 付きの ?next= 復帰（R5 の回帰証拠）", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, { body: "hash 復帰の証拠" });
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({ json: { ok: true, data: { authenticated: true } } }),
    );
    await page.goto(`/account/login?next=${encodeURIComponent(`/b/${slug}/t/${threadId}#p1`)}`);
    await page.getByLabel("メールアドレス").fill("rvcore-evidence-hash@example.test");
    await page.getByLabel("パスワード").fill("e2e-Password-1");
    await page.getByRole("button", { name: "ログイン" }).last().click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}/t/${threadId}#p1$`), { timeout: 20_000 });
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${OUT_DIR}/12_pc_login_next_hash.png`, fullPage: false });
  });
});
