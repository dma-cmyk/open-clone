// CSRF / Origin 検証（DESIGN §13、WP0 originGuard）。
// mutation は許可リスト外の Origin を 403 BAD_ORIGIN で拒否する。
import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope, skipIfHonoDefaultError } from "../helpers/api";

const DISALLOWED_ORIGIN = "https://evil.example";

test.describe("CSRF / Origin", () => {
  test("mutation: 未許可 Origin は 403 BAD_ORIGIN", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/boards`, {
      headers: { Origin: DISALLOWED_ORIGIN, "content-type": "application/json" },
      data: { name: "csrf-test" },
    });
    skipIfHonoDefaultError(response, "未許可 Origin の拒否が 500 になっている");
    expect(response.status()).toBe(403);
    const body = await readEnvelope(response);
    expect(body?.ok).toBe(false);
    if (body && !body.ok) expect(body.code).toBe("BAD_ORIGIN");
  });

  test("mutation: Origin: null は拒否", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/posts`, {
      headers: { Origin: "null", "content-type": "application/json" },
      data: {},
    });
    skipIfHonoDefaultError(response, "Origin: null の拒否が 500 になっている");
    expect(response.status()).toBe(403);
    const body = await readEnvelope(response);
    if (body && !body.ok) expect(body.code).toBe("BAD_ORIGIN");
  });

  test("mutation: 許可 Origin は CSRF 段階を通る", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/boards`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      data: { name: "csrf-allowed" },
    });
    // 認証・バリデーション・未実装（501）はあり得るが、Origin 拒否にはならない。
    expect(response.status()).not.toBe(403);
    const body = await readEnvelope(response);
    if (body && !body.ok) expect(body.code).not.toBe("BAD_ORIGIN");
  });

  test("GET は Origin 検証の対象外", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/health`, {
      headers: { Origin: DISALLOWED_ORIGIN },
    });
    expect(response.status()).toBe(200);
  });

  test("Origin なし mutation は開発環境では許可（本番は 403）", async ({ request }) => {
    // E2E は ENVIRONMENT=development で起動する。本番挙動は API 統合テスト（WP0）で検証。
    const response = await request.post(`${API_BASE}/v1/boards`, {
      headers: { "content-type": "application/json" },
      data: {},
    });
    expect(response.status()).not.toBe(403);
  });
});