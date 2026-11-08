import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /v1/health", () => {
  it("ヘルスチェックが 200 を返す", async () => {
    const response = await SELF.fetch("http://worker.test/v1/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
  });
});

describe("GET /v1/meta/health", () => {
  it("正規パスでも 200", async () => {
    const response = await SELF.fetch("http://worker.test/v1/meta/health");
    expect(response.status).toBe(200);
  });
});

describe("存在しないルート", () => {
  it("404 envelope を返す", async () => {
    const response = await SELF.fetch("http://worker.test/v1/not-found");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { ok: false; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("実装済みルート", () => {
  it("WP1 の boards 一覧は 200 で envelope を返す", async () => {
    const response = await SELF.fetch("http://worker.test/v1/boards");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true; data: { items: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
  });
});
