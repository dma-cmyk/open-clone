// CORS（DESIGN §2.2 / CONTRACTS §4、WP0 origin middleware）。
// 許可オリジンの反射 + credentials、未許可オリジンへの非付与、プリフライトを検証する。
import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE } from "../helpers/api";

const DISALLOWED_ORIGIN = "https://evil.example";

test.describe("CORS", () => {
  test("許可オリジンには Origin を反射して credentials を許可する", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(headers["access-control-allow-credentials"]).toBe("true");
    expect(headers["vary"] ?? "").toContain("Origin");
  });

  test("未許可オリジンには CORS ヘッダーを付けない", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/health`, {
      headers: { Origin: DISALLOWED_ORIGIN },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("プリフライト（許可）は 204 + 許可メソッド/ヘッダー", async ({ request }) => {
    const response = await request.fetch(`${API_BASE}/v1/boards`, {
      method: "OPTIONS",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(response.status()).toBe(204);
    const headers = response.headers();
    expect(headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(headers["access-control-allow-methods"] ?? "").toContain("POST");
    expect(headers["access-control-allow-headers"] ?? "").toContain("Content-Type");
  });

  test("プリフライト（未許可）は ACAO を付けない", async ({ request }) => {
    const response = await request.fetch(`${API_BASE}/v1/boards`, {
      method: "OPTIONS",
      headers: { Origin: DISALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    expect(response.status()).toBe(204);
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("ワイルドカード ACAO と credentials を同時に返さない", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/health`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const allowOrigin = response.headers()["access-control-allow-origin"];
    if (allowOrigin === "*") {
      expect(response.headers()["access-control-allow-credentials"]).not.toBe("true");
    }
  });
});