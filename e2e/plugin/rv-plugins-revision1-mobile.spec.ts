// 差し戻し第1回の R2（停止中トグル）のモバイル（360px）証拠撮影。
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

async function loginAsTestUser(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

test("R2 モバイル: 停止中のトグルラベルと説明（360px）", async ({ page, request, context }) => {
  test.setTimeout(120_000);
  await loginAsTestUser(context);
  await page.setViewportSize({ width: 360, height: 740 });

  const name = unique("rv1m").slice(0, 41).toLowerCase();
  const createResponse = await request.post(`${API_BASE}/v1/plugins`, {
    headers: userHeaders(),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "モバイル証拠用",
        scope: ["personal"],
        permissions: [],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: [],
        hooks: [],
      },
      code: "register({});",
      visibility: "public",
      changelog: "rv1m",
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = await readEnvelope<{ id: string }>(createResponse);
  if (!created || !created.ok) throw new Error("作成に失敗");
  await request.post(`${API_BASE}/v1/plugins/${created.data.id}/publish`, {
    headers: userHeaders(),
    data: { scopes: ["personal"], visibility: "public" },
  });
  await request.post(`${API_BASE}/v1/plugins/${created.data.id}/install`, {
    headers: userHeaders(),
    data: { scope: "personal" },
  });

  try {
    await request.post(`${API_BASE}/v1/plugins/${created.data.id}/disable`, {
      headers: userHeaders(),
      data: { reason: "モバイル確認" },
    });

    await page.goto(`/plugins/view/?id=${encodeURIComponent(created.data.id)}`);
    const installRow = page.locator("li", { hasText: "個人用" }).first();
    await expect(page.getByText("停止中（効果なし）").first()).toBeVisible();
    await expect(installRow.getByRole("button", { name: "無効化", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results-rv-plugins/shots/r2-stopped-enabled-row-mobile.png" });

    const disableResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith(`/v1/plugins/${created.data.id}/disable-install`),
    );
    await installRow.getByRole("button", { name: "無効化", exact: true }).click();
    expect((await disableResponse).status()).toBe(200);
    await expect(installRow.getByRole("button", { name: "有効化", exact: true })).toBeVisible();
    await expect(page.getByText(/停止が解除されても自動では戻りません/).first()).toBeVisible();
    await page.screenshot({ path: "test-results-rv-plugins/shots/r2-stopped-disabled-row-mobile.png" });
  } finally {
    await request.post(`${API_BASE}/v1/plugins/${created.data.id}/enable`, { headers: userHeaders() }).catch(() => undefined);
    await request
      .post(`${API_BASE}/v1/plugins/${created.data.id}/uninstall`, {
        headers: userHeaders(),
        data: { scope: "personal" },
      })
      .catch(() => undefined);
    await request.delete(`${API_BASE}/v1/plugins/${created.data.id}`, { headers: userHeaders() }).catch(() => undefined);
  }
});
