// 最小スモーク。実スタック（web + api + D1）が起動していることを確認する。
import { expect, test } from "@playwright/test";
import { API_BASE, readEnvelope } from "./helpers/api";

test.describe("smoke", () => {
  test("トップページが表示される", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("おーぷんクローン");
  });

  test("API health（直接）", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/health`);
    expect(response.status()).toBe(200);
    const body = await readEnvelope<{ status: string; service: string }>(response);
    expect(body?.ok).toBe(true);
    if (!body?.ok) throw new Error("health が envelope ではありません");
    expect(body.data.status).toBe("ok");
    expect(body.data.service).toBe("open-clone-api");
  });

  test("API health（web rewrites プロキシ経由）", async ({ request }) => {
    const response = await request.get("/api/v1/health");
    expect(response.status()).toBe(200);
    const body = await readEnvelope<{ status: string }>(response);
    expect(body?.ok).toBe(true);
    if (!body?.ok) throw new Error("proxy health が envelope ではありません");
    expect(body.data.status).toBe("ok");
  });

  test("外部サービススタブが起動している", async ({ request }) => {
    const response = await request.get(`${process.env.E2E_STUB_URL ?? "http://127.0.0.1:8898"}/__health`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("e2e-stub");
  });
});