// ログイン・登録の Turnstile トークン使い切り（本番不具合 A1）の回帰。
//
// 本物の siteverify はトークンを 1 回で使い切る。API の /v1/auth/login は
// `requireTurnstile({ required: false })` で、トークンが付いていれば必ず検証する。
// 以前の画面は 1 回受け取ったトークンを送信のたびに再送していたため、
//   - TOTP 有効アカウント: 1 回目（パスワードのみ）が TOTP_REQUIRED で返り、
//     2 回目（TOTP 入力）が使用済みトークンで 400 TURNSTILE_FAILED
//   - パスワード間違いの後の再送も同じ
// となり、画面からログインできなかった。
//
// 検証はローカルスタブ（E2E_TURNSTILE_STUB=1 で TURNSTILE_VERIFY_URL を差し替え）で行う。
// スタブは同じトークンの 2 回目を timeout-or-duplicate で拒否する（本物と同じ）。
// 未設定の環境では実 siteverify を叩いてしまうため実行しない。
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { fakeIp, unique } from "../helpers/ids";
import { stableTotpCode } from "./totp";

const TURNSTILE_STUB = process.env.E2E_TURNSTILE_STUB === "1";
const PASSWORD = "e2e-pass-1234";

declare global {
  interface Window {
    /** 画面のスタブが発行したトークン数（ウィジェットの描画・リセット）。 */
    __ocIssuedTokens?: number;
  }
}

/** 公式テストキーと同じ形のトークンを 1 回限りで発行するウィジェットスタブ。 */
async function stubTurnstile(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface StubOptions {
      callback?: (token: string) => void;
    }
    const widgets = new Map<string, (token: string) => void>();
    // siteverify スタブはトークンを使い切るため、ページ間・並列実行で衝突しない値にする
    // （数字だけにするのは、スタブが fail/invalid/timeout を含む値を失敗扱いするため）。
    const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    let seq = 0;
    const issue = (callback: (token: string) => void) => {
      window.setTimeout(() => {
        window.__ocIssuedTokens = (window.__ocIssuedTokens ?? 0) + 1;
        callback(`stub-token-${runId}-${seq}`);
      }, 0);
    };
    window.__ocIssuedTokens = 0;
    // Window.turnstile は rv-core-helpers.ts が `unknown` で宣言している。
    // 実スクリプトの API と同じ形のオブジェクトを代入するだけなのでキャストは要らない。
    window.turnstile = {
      render(element: HTMLElement, options: StubOptions) {
        seq += 1;
        const id = `acct-stub-${seq}`;
        if (options.callback) {
          widgets.set(id, options.callback);
          issue(options.callback);
        }
        const box = document.createElement("div");
        box.className = "stub-turnstile";
        box.textContent = "stub-turnstile";
        element.appendChild(box);
        return id;
      },
      reset(id: string) {
        const callback = widgets.get(id);
        if (!callback) return;
        seq += 1;
        issue(callback);
      },
      remove(id: string) {
        widgets.delete(id);
      },
    };
  });
}

interface Account {
  email: string;
  cookie: string;
}

/** API 直叩きでアカウントを作る（画面の Turnstile には触れない）。 */
async function registerAccount(request: APIRequestContext, prefix: string): Promise<Account> {
  const email = `${unique(prefix).toLowerCase()}@example.com`;
  const response = await request.post(apiUrl("/v1/auth/register"), {
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "x-real-ip": fakeIp(Math.floor(Math.random() * 40_000)),
    },
    data: { name: `Turnstile ${Date.now().toString(36)}`, email, password: PASSWORD },
  });
  expect(response.status(), await response.text()).toBe(201);
  const cookie = /oc_sess=([^;]+)/.exec(response.headers()["set-cookie"] ?? "")?.[1];
  expect(cookie, "登録 API のセッション Cookie").toBeTruthy();
  return { email, cookie: cookie! };
}

/** TOTP を有効化し、secret（base32）を返す。 */
async function enableTotp(request: APIRequestContext, account: Account): Promise<string> {
  const headers = {
    origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: `oc_sess=${account.cookie}`,
  };
  const setup = await request.post(apiUrl("/v1/auth/totp/setup"), { headers, data: {} });
  expect(setup.status(), await setup.text()).toBe(200);
  const setupBody = await readEnvelope<{ secret: string }>(setup);
  if (!setupBody?.ok) throw new Error("TOTP セットアップの応答が不正です");
  const secret = setupBody.data.secret;

  const enable = await request.post(apiUrl("/v1/auth/totp/enable"), {
    headers,
    data: { code: await stableTotpCode(secret) },
  });
  expect(enable.status(), await enable.text()).toBe(200);
  return secret;
}

/** ログイン画面へ送った x-turnstile-token を記録する。 */
function recordLoginTokens(page: Page): string[] {
  const tokens: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/auth/login") {
      tokens.push(request.headers()["x-turnstile-token"] ?? "");
    }
  });
  return tokens;
}

/** ログイン画面を開き、最初のトークンが届くまで待つ（必ずトークン付きで 1 回目を送る）。 */
async function openLogin(page: Page, email: string): Promise<void> {
  await stubTurnstile(page);
  await page.goto("/account/login");
  await expect.poll(() => page.evaluate(() => window.__ocIssuedTokens ?? 0)).toBeGreaterThan(0);
  await page.locator("#login-email").fill(email);
}

test.describe("Turnstile トークンは 1 回だけ（ログインの再送）", () => {
  test.skip(
    !TURNSTILE_STUB,
    "E2E_TURNSTILE_STUB=1（TURNSTILE_VERIFY_URL をローカルスタブへ差し替え）でのみ実行",
  );

  test("TOTP 有効: TOTP_REQUIRED の後の再送でもログインできる", async ({ page, request }) => {
    const account = await registerAccount(request, "ts-totp");
    const secret = await enableTotp(request, account);
    const sent = recordLoginTokens(page);
    await openLogin(page, account.email);

    await page.locator("#login-password").fill(PASSWORD);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page.locator("#login-totp")).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0], "1 回目はトークン付きで送る").toBeTruthy();

    await page.locator("#login-totp").fill(await stableTotpCode(secret));
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/, { timeout: 15_000 });

    // 2 回目は 1 回目のトークンを再送していない（再送すると 400 TURNSTILE_FAILED）。
    expect(sent).toHaveLength(2);
    expect(sent[1], "2 回目もトークン付き").toBeTruthy();
    expect(sent[1]).not.toBe(sent[0]);
  });

  test("パスワード間違いの後の再送でもログインできる", async ({ page, request }) => {
    const account = await registerAccount(request, "ts-retry");
    const sent = recordLoginTokens(page);
    await openLogin(page, account.email);

    await page.locator("#login-password").fill("wrong-password-1234");
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page.locator(".oc-error")).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0], "1 回目はトークン付きで送る").toBeTruthy();

    await page.locator("#login-password").fill(PASSWORD);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/, { timeout: 15_000 });

    expect(sent).toHaveLength(2);
    expect(sent[1], "2 回目もトークン付き").toBeTruthy();
    expect(sent[1]).not.toBe(sent[0]);
  });
});