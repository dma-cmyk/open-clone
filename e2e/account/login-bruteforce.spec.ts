// F2: アカウント（メール）単位の失敗上限超過後、別 IP からのログインでも Turnstile が必須になり、
// 画面のログインフォームが Turnstile 要求の応答を受けて確認を出し、再送でログインできることの E2E。

import { expect, test, type APIRequestContext } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE } from "../helpers/api";
import { fakeIp, unique } from "../helpers/ids";

const PASSWORD = "e2e-bf-pass-1234";
const TURNSTILE_STUB = process.env.E2E_TURNSTILE_STUB === "1";

declare global {
  interface Window {
    __ocLoginTurnstile?: {
      renders: number;
      resets: number;
      issue: (token: string) => void;
    };
  }
}

async function seedAccountWithTenFailures(request: APIRequestContext, prefix: string): Promise<string> {
  const email = `${unique(prefix).toLowerCase()}@example.com`;
  const regIp = fakeIp(Math.floor(Math.random() * 35_000) + 500);
  const reg = await request.post(`${API_BASE}/v1/auth/register`, {
    headers: {
      origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": regIp,
      "x-real-ip": regIp,
    },
    data: { name: `E2E BF ${Date.now().toString(36)}`, email, password: PASSWORD },
  });
  expect(reg.status(), await reg.text()).toBe(201);

  // 10 個の異なる IP から失敗させる（ブラウザの接続元 127.0.0.1 とは別の IP）
  const baseSeed = Math.floor(Math.random() * 30_000) + 1000;
  for (let i = 0; i < 10; i += 1) {
    const failIp = fakeIp(baseSeed + i);
    const attempt = await request.post(`${API_BASE}/v1/auth/login`, {
      headers: {
        origin: ALLOWED_ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": failIp,
        "x-real-ip": failIp,
      },
      data: { email, password: "wrong-password-1234" },
    });
    expect(attempt.status(), `seed failure ${i + 1}: ${await attempt.text()}`).toBe(401);
  }
  return email;
}

test.describe("F2: 別 IP の失敗蓄積後にログイン画面が Turnstile を要求し再送で通る", () => {
  test("未確認のまま送ると TURNSTILE_FAILED を受け、確認後に再送するとログインできる", async ({ page, request }) => {
    const email = await seedAccountWithTenFailures(request, "bf-ui");

    // 初期描画時はトークンを出さず、reset 後に任意のタイミングでトークンを発行できるスタブ
    await page.addInitScript(() => {
      const state = {
        renders: 0,
        resets: 0,
        issue(_token: string) {},
      };
      const widgets = new Map<string, { cb?: (token: string) => void; box: HTMLElement }>();
      window.__ocLoginTurnstile = state;
      window.turnstile = {
        render(element: HTMLElement, options: { callback?: (token: string) => void }) {
          state.renders += 1;
          const id = `bf-widget-${state.renders}`;
          const box = document.createElement("div");
          box.className = "stub-turnstile";
          box.textContent = "stub-turnstile";
          element.appendChild(box);
          widgets.set(id, { cb: options.callback, box });
          return id;
        },
        reset(id: string) {
          state.resets += 1;
          const entry = widgets.get(id);
          if (entry?.cb) state.issue = (token: string) => entry.cb?.(token);
        },
        remove(id: string) {
          widgets.get(id)?.box.remove();
          widgets.delete(id);
        },
      };
    });

    const sentTokens: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/api/v1/auth/login") {
        sentTokens.push(req.headers()["x-turnstile-token"] ?? "");
      }
    });

    await page.goto("/account/login");
    await expect(page.locator(".stub-turnstile")).toBeVisible();
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(PASSWORD);

    // 1 回目: トークンなしで送信 → 400 TURNSTILE_FAILED
    const firstResponsePromise = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/v1/auth/login" && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status()).toBe(400);
    const firstEnvelope = (await firstResponse.json()) as { ok: boolean; code?: string };
    expect(firstEnvelope.ok).toBe(false);
    expect(firstEnvelope.code).toBe("TURNSTILE_FAILED");

    await expect(page.locator(".oc-error")).toContainText("Turnstile 認証が必要です");
    await expect(page.getByText("安全確認のため Bot 確認（Turnstile）が必要です")).toBeVisible();
    await expect(page.locator(".stub-turnstile")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__ocLoginTurnstile?.resets ?? 0)).toBeGreaterThanOrEqual(1);
    await expect(page.getByRole("button", { name: "確認中…" })).toBeDisabled();

    // 確認を完了させてトークンを発行し、もう一度ログインを送る
    const freshToken = TURNSTILE_STUB
      ? `stub-token-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
      : "1x00000000000000000000AA";
    await page.evaluate((tok) => window.__ocLoginTurnstile?.issue(tok), freshToken);

    const submitButton = page.getByRole("button", { name: "ログイン", exact: true });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await expect(page).toHaveURL(/\/account$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "プロフィール" })).toBeVisible();

    expect(sentTokens).toHaveLength(2);
    expect(sentTokens[0]).toBe("");
    expect(sentTokens[1]).toBe(freshToken);
  });

  test("初回に Turnstile スクリプト読込が失敗しても、TURNSTILE_FAILED 応答後に再読込してログインできる", async ({
    page,
    request,
  }) => {
    const email = await seedAccountWithTenFailures(request, "bf-recover");

    let scriptAttempts = 0;
    const freshToken = TURNSTILE_STUB
      ? `stub-token-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
      : "1x00000000000000000000AA";

    // 1 回目の challenges.cloudflare.com 読込は失敗させ、TURNSTILE_FAILED 後のリセットで成功させる
    await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", async (route) => {
      scriptAttempts += 1;
      if (scriptAttempts === 1) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          const boxes = new Map();
          window.turnstile = {
            render(el, opts) {
              const id = "recovered-" + (boxes.size + 1);
              const box = document.createElement("div");
              box.className = "stub-turnstile-recovered";
              box.textContent = "stub-turnstile-recovered";
              el.appendChild(box);
              boxes.set(id, box);
              setTimeout(() => opts.callback && opts.callback(${JSON.stringify(freshToken)}), 0);
              return id;
            },
            reset() {},
            remove(id) {
              const box = boxes.get(id);
              if (box) box.remove();
              boxes.delete(id);
            }
          };
        `,
      });
    });

    await page.goto("/account/login");
    await page.locator("#login-email").fill(email);
    await page.locator("#login-password").fill(PASSWORD);

    const firstResponsePromise = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/v1/auth/login" && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status()).toBe(400);

    // リトライされたスクリプトがウィジェットを描画し、トークン取得後にボタンが有効になる
    await expect(page.locator(".stub-turnstile-recovered")).toBeVisible();
    const submitButton = page.getByRole("button", { name: "ログイン", exact: true });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await expect(page).toHaveURL(/\/account$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "プロフィール" })).toBeVisible();
    expect(scriptAttempts).toBeGreaterThanOrEqual(2);
  });
});
