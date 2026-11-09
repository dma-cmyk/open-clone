// 最小スモーク。実スタック（web + api + D1）が起動していることを確認する。
import { expect, test } from "@playwright/test";
import { API_BASE, readEnvelope } from "./helpers/api";

test.describe("smoke", () => {
  test("トップページが表示される", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("おーぷんクローン");
  });

  test("選択中のカテゴリチップはコントラスト 4.5:1 以上で読める", async ({ page }) => {
    await page.goto("/");
    const chip = page.locator(".oc-chip-active").first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    const { color, background } = await chip.evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor };
    });
    const parse = (value: string): [number, number, number] => {
      const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value);
      if (!match) throw new Error(`色を解釈できません: ${value}`);
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const luminance = (rgb: [number, number, number]): number => {
      const [r, g, b] = rgb.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [lighter, darker] = [luminance(parse(color)), luminance(parse(background))].sort((a, b) => b - a);
    const ratio = (lighter! + 0.05) / (darker! + 0.05);
    expect(ratio, `color=${color} background=${background}`).toBeGreaterThanOrEqual(4.5);
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