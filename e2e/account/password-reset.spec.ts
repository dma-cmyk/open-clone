// パスワードを忘れたときの復旧の E2E（設計 50。pc と mobile の両プロジェクトで実行）。
// ① 登録 → 復旧コード作成（登録の最後）→ ログアウト → 「パスワードを忘れたとき」で再設定 → 新パスワードでログイン
// ② 所有者が再設定 URL を発行 → 別ブラウザで開いて再設定 → ログイン

import { expect, test, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, WEB_BASE, apiUrl } from "../helpers/api";
import { fakeIp, unique } from "../helpers/ids";
import { stubTurnstile } from "../core/rv-core-helpers";

const OWNER_SESSION = "e2e-owner-session-token";
const PASSWORD = "e2e-reset-pass-1234";
const NEW_PASSWORD = "e2e-reset-new-pass-1234";

/** 表示された復旧コード（XXXXXX-XXXXXX-XXXXXX-XXXXXX）をすべて読む。 */
async function readRecoveryCodes(page: Page): Promise<string[]> {
  const locator = page.locator("code").filter({ hasText: /^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/ });
  await expect(locator.first()).toBeVisible();
  const codes = (await locator.allTextContents()).map((value) => value.trim());
  expect(codes).toHaveLength(10);
  return codes;
}

/** 固定所有者セッション（seed.sql）をブラウザへ入れる。 */
async function loginAsOwner(page: Page): Promise<void> {
  await page.context().addCookies([
    { name: "oc_sess", value: OWNER_SESSION, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

test.describe("パスワードを忘れたときの復旧", () => {
  test("登録の最後に復旧コードを作成し、コードで再設定して新しいパスワードでログインする", async ({
    page,
    request,
  }, testInfo) => {
    const email = `${unique("pwreset").toLowerCase()}@example.com`;
    const name = `E2E 復旧 ${Date.now().toString(36)}`;

    // --- 登録（最後に復旧コード作成の任意ステップ） ---
    await page.goto("/account/register");
    await expect(page.getByRole("heading", { name: "新規登録" })).toBeVisible();
    await page.locator("#reg-name").fill(name);
    await page.locator("#reg-email").fill(email);
    await page.locator("#reg-password").fill(PASSWORD);
    await page.locator("#reg-password2").fill(PASSWORD);
    await page.getByRole("button", { name: "登録する" }).click();

    const reachedRecoveryStep = page
      .getByRole("heading", { name: "復旧コードを作成（推奨）" })
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const rateLimited = page
      .getByText("新規登録の上限に達しました")
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    // ローカル再実行では登録上限（5回/24h・IP）に達することがある。
    // その場合は API（別 IP）で登録し、セキュリティ画面から復旧コードを作る（同じ機能の確認）。
    const usedUiRegistration = await Promise.race([reachedRecoveryStep, rateLimited]);
    if (!usedUiRegistration) {
      test.info().annotations.push({
        type: "rate-limit-fallback",
        description: "登録 UI が上限到達のため API 登録（別 IP）で継続",
      });
      const fallback = await request.post(apiUrl("/v1/auth/register"), {
        headers: {
          origin: ALLOWED_ORIGIN,
          "content-type": "application/json",
          "x-real-ip": fakeIp(Math.floor(Math.random() * 40_000)),
        },
        data: { name, email, password: PASSWORD },
      });
      expect(fallback.status(), await fallback.text()).toBe(201);
      const token = /oc_sess=([^;]+)/.exec(fallback.headers()["set-cookie"] ?? "")?.[1];
      expect(token, "登録 API のセッション Cookie").toBeTruthy();
      await page.context().addCookies([
        { name: "oc_sess", value: token!, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" },
      ]);
    }

    // --- 復旧コードを作成（登録の最後、またはセキュリティ画面） ---
    let recoveryCodes: string[];
    if (usedUiRegistration) {
      await page.getByRole("button", { name: "復旧コードを作成する（推奨）" }).click();
      recoveryCodes = await readRecoveryCodes(page);
      await page.getByRole("button", { name: "保存したので続ける" }).click();
    } else {
      await page.goto("/account/security");
      await expect(page.getByRole("heading", { name: "セキュリティ" })).toBeVisible();
      await page.locator("#recovery-pass").fill(PASSWORD);
      await page.getByRole("button", { name: /復旧コードを作成する|復旧コードを作り直す/ }).click();
      recoveryCodes = await readRecoveryCodes(page);
      await page.goto("/account");
    }
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText("一般ユーザー")).toBeVisible();
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/$/);

    // --- 「パスワードを忘れたとき」で再設定（ロボット確認あり） ---
    await stubTurnstile(page);
    await page.goto("/account/password-reset");
    await expect(page.getByRole("heading", { name: "パスワードを忘れたとき" })).toBeVisible();
    await page.locator("#pwreset-email").fill(email);
    await page.locator("#pwreset-code").fill(recoveryCodes[0]!);
    await page.locator("#pwreset-new").fill(NEW_PASSWORD);
    await page.locator("#pwreset-new2").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "パスワードを再設定" }).click();
    await expect(page.getByText("パスワードを再設定しました。新しいパスワードでログインしてください。")).toBeVisible();
    await expect(page.getByText("残りの復旧コード: 9")).toBeVisible();

    // --- 新しいパスワードでログイン、古いパスワードは拒否 ---
    await page.getByRole("link", { name: "ログインする" }).click();
    await expect(page).toHaveURL(/\/account\/login$/);
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(PASSWORD);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page.getByText("メールアドレスまたはパスワードが正しくありません")).toBeVisible();

    await page.locator("#login-password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { name: "プロフィール" })).toBeVisible();
  });

  test("所有者が再設定 URL を発行→別ブラウザで開いて再設定→ログイン", async ({ browser, page, request }, testInfo) => {
    const email = `${unique("pwreset-operator").toLowerCase()}@example.com`;
    const name = `E2E 運営復旧 ${Date.now().toString(36)}`;

    // 対象ユーザーは API（別 IP）で作る（登録上限と画面操作の競合を避ける）。
    const registered = await request.post(apiUrl("/v1/auth/register"), {
      headers: {
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        "x-real-ip": fakeIp(Math.floor(Math.random() * 40_000)),
      },
      data: { name, email, password: PASSWORD },
    });
    expect(registered.status(), await registered.text()).toBe(201);

    // --- 所有者でユーザー一覧を開き、再設定 URL を発行 ---
    await loginAsOwner(page);
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "ユーザー一覧" })).toBeVisible();
    await page.getByPlaceholder("表示名・メールで検索").fill(email);
    await page.getByRole("button", { name: "検索" }).click();
    const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: email, exact: true }) });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "再設定 URL" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`${email}`) })).toBeVisible();
    await page.getByRole("button", { name: "再設定 URL を発行する（要 TOTP 再認証）" }).click();
    const urlInput = page.locator("input[readonly]");
    await expect(urlInput).toBeVisible();
    const resetUrl = await urlInput.inputValue();
    expect(resetUrl).toContain("/account/password-reset/confirm?token=");
    await expect(page.getByRole("link", { name: /メールを作成/ })).toHaveAttribute("href", /^mailto:/);
    await expect(page.getByText(email).first()).toBeVisible();

    // --- 別ブラウザで URL を開いて再設定 ---
    const other = await browser.newContext({ baseURL: WEB_BASE });
    const otherPage = await other.newPage();
    await stubTurnstile(otherPage);
    await otherPage.goto(resetUrl);
    await expect(otherPage.getByRole("heading", { name: "パスワードの再設定" })).toBeVisible();
    await otherPage.locator("#pwconfirm-new").fill(NEW_PASSWORD);
    await otherPage.locator("#pwconfirm-new2").fill(NEW_PASSWORD);
    await otherPage.getByRole("button", { name: "パスワードを再設定" }).click();
    await expect(
      otherPage.getByText(`${name} のパスワードを再設定しました。新しいパスワードでログインしてください。`),
    ).toBeVisible();

    // 使用済み URL は同じ案内で拒否される
    await otherPage.goto(resetUrl);
    await otherPage.locator("#pwconfirm-new").fill("e2e-reuse-pass-1234");
    await otherPage.locator("#pwconfirm-new2").fill("e2e-reuse-pass-1234");
    await otherPage.getByRole("button", { name: "パスワードを再設定" }).click();
    await expect(otherPage.getByText("この URL は無効か、有効期限が切れています")).toBeVisible();

    // --- 新しいパスワードでログイン ---
    await otherPage.goto("/account/login");
    await otherPage.locator("#login-email").fill(email);
    await otherPage.locator("#login-password").fill(NEW_PASSWORD);
    await otherPage.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(otherPage).toHaveURL(/\/account$/);

    // 発行した URL は未使用一覧から消えている
    await page.reload();
    await page.getByPlaceholder("表示名・メールで検索").fill(email);
    await page.getByRole("button", { name: "検索" }).click();
    const rowAfter = page.getByRole("row").filter({ has: page.getByRole("cell", { name: email, exact: true }) });
    await expect(rowAfter).toHaveCount(1);
    await rowAfter.getByRole("button", { name: "再設定 URL" }).click();
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: new RegExp(email) }) });
    await expect(panel).toContainText("未使用の URL: なし");

    await other.close();
    testInfo.annotations.push({ type: "operator-reset", description: "別ブラウザで URL を開いて再設定" });
  });
});