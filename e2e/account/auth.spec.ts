// アカウント認証 E2E（登録 → TOTP 登録 → TOTP ログイン → リカバリーコード復旧 → ログアウト）。
// 実スタック（Next dev + wrangler dev）を Playwright の webServer が起動する（WP7 基盤）。
// 登録・ログインの試行制限を他 spec と共有しないよう、x-real-ip をテストごとに分離する。

import { expect, test, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE } from "../helpers/api";
import { fakeIp, unique } from "../helpers/ids";
import { isBase32Secret, stableTotpCode } from "./totp";

const PASSWORD = "e2e-pass-1234";

function uniqueEmail(prefix: string): string {
  return `${unique(prefix).toLowerCase()}@example.com`;
}

/** 画面に表示された TOTP secret（base32）を読む。 */
async function readTotpSecret(page: Page): Promise<string> {
  const candidates = page.locator("code").filter({ hasText: /^[A-Z2-7]{16,64}$/ });
  await expect(candidates.first()).toBeVisible();
  const secret = (await candidates.first().textContent())?.trim() ?? "";
  if (!isBase32Secret(secret)) throw new Error(`TOTP secret を読み取れませんでした: ${JSON.stringify(secret)}`);
  return secret;
}

/** 表示されたリカバリーコード（XXXXXX-XXXXXX-XXXXXX-XXXXXX）をすべて読む。 */
async function readRecoveryCodes(page: Page): Promise<string[]> {
  const locator = page.locator("code").filter({ hasText: /^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/ });
  await expect(locator.first()).toBeVisible();
  const codes = (await locator.allTextContents()).map((value) => value.trim());
  expect(codes).toHaveLength(10);
  expect(new Set(codes).size).toBe(10);
  return codes;
}

test.describe("アカウント登録と TOTP", () => {
  test("登録→TOTP 登録→ログアウト→TOTP ログイン→リカバリーコード復旧", async ({ context, page, request }) => {
    // 登録の試行制限（IP 単位・24h）を過去の実行と共有しないよう、毎回ランダムなテスト IP を使う。
    await context.setExtraHTTPHeaders({ "x-real-ip": fakeIp(Math.floor(Math.random() * 40_000)) });
    const email = uniqueEmail("totp");
    const name = `E2E TOTP ${Date.now().toString(36)}`;

    // --- 登録 ---
    await page.goto("/account/register");
    await expect(page.getByRole("heading", { name: "新規登録" })).toBeVisible();
    await page.locator("#reg-name").fill(name);
    await page.locator("#reg-email").fill(email);
    await page.locator("#reg-password").fill(PASSWORD);
    await page.locator("#reg-password2").fill(PASSWORD);
    await page.getByRole("button", { name: "登録する" }).click();

    // ローカル再実行では IP 単位の登録上限（5回/24h）に達することがある。
    // Next dev の proxy は x-real-ip を転送しないため、429 のときは API 直叩き（別 IP）で同じアカウントを作る。
    const uiRegistered = await Promise.race([
      page.waitForURL(/\/account$/, { timeout: 15_000 }).then(() => true).catch(() => false),
      page
        .getByText("新規登録の上限に達しました")
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => false)
        .catch(() => false),
    ]);
    if (!uiRegistered) {
      const fallback = await request.post(`${API_BASE}/v1/auth/register`, {
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
      await context.addCookies([{ name: "oc_sess", value: token!, domain: "localhost", path: "/" }]);
      test.info().annotations.push({
        type: "rate-limit-fallback",
        description: "登録 UI が上限到達のため API 登録（別 IP）で継続",
      });
      await page.goto("/account");
    }

    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { name: "プロフィール" })).toBeVisible();
    await expect(page.getByText("一般ユーザー")).toBeVisible();

    // --- TOTP 登録（QR + secret を画面から取得） ---
    await page.goto("/account/totp");
    await expect(page.getByRole("heading", { name: "TOTP 二段階認証" })).toBeVisible();
    await page.getByRole("button", { name: "TOTP の登録を開始" }).click();
    await expect(page.getByAltText("TOTP 登録用 QR コード")).toBeVisible();
    const secret = await readTotpSecret(page);

    await page.locator("#totp-enable-code").fill(await stableTotpCode(secret));
    await page.getByRole("button", { name: "有効化" }).click();

    await expect(page.getByText("リカバリーコード（新しい 10 個）")).toBeVisible();
    const recoveryCodes = await readRecoveryCodes(page);
    await expect(page.getByText("有効", { exact: true }).first()).toBeVisible();

    // --- ログアウト ---
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/account");
    await expect(page.getByRole("link", { name: "ログイン" }).first()).toBeVisible();

    // --- TOTP ログイン ---
    await page.goto("/account/login");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(PASSWORD);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page.locator("#login-totp")).toBeVisible();
    await expect(page.getByText("TOTP コードを入力してください。")).toBeVisible();

    await page.locator("#login-totp").fill(await stableTotpCode(secret));
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText("TOTP: 有効")).toBeVisible();

    // --- リカバリーコードで復旧（TOTP 端末を失った想定） ---
    await page.getByRole("button", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/account/recovery");
    await page.locator("#rec-email").fill(email);
    await page.locator("#rec-password").fill(PASSWORD);
    await page.locator("#rec-code").fill(recoveryCodes[0]!);
    await page.getByRole("button", { name: "復旧する" }).click();

    await expect(page.getByText("リカバリーに成功しました。TOTP はリセットされました。")).toBeVisible();
    await expect(page.getByText("残りのリカバリーコード: 9")).toBeVisible();

    // 同じリカバリーコードの再利用は拒否される（単回使用）
    await page.goto("/account/recovery");
    await page.locator("#rec-email").fill(email);
    await page.locator("#rec-password").fill(PASSWORD);
    await page.locator("#rec-code").fill(recoveryCodes[0]!);
    await page.getByRole("button", { name: "復旧する" }).click();
    await expect(page.getByText("リカバリーコードが正しくありません")).toBeVisible();
  });

  test("未ログインで /account/totp を開くとログイン導線を表示する", async ({ page }) => {
    await page.goto("/account/totp");
    await expect(page.getByText("ログインが必要です。")).toBeVisible();
    await expect(page.getByRole("link", { name: "ログイン" }).first()).toBeVisible();
  });
});