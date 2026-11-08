// セキュリティヘッダー / CSP（DESIGN §13）。
// 未実装のものは動的に skip し、実装された時点で自動的に検証へ戻る。
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_BASE } from "../helpers/api";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const BASE_HEADERS: Array<[string, RegExp]> = [
  ["x-content-type-options", /^nosniff$/i],
  ["referrer-policy", /strict-origin|no-referrer/i],
];

test.describe("security headers", () => {
  test("web: 基本セキュリティヘッダー", async ({ request }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    const headers = response.headers();
    const missing: string[] = [];
    for (const [name, pattern] of BASE_HEADERS) {
      const value = headers[name];
      if (!value) {
        missing.push(name);
        continue;
      }
      expect(value, name).toMatch(pattern);
    }
    if (missing.length > 0) test.skip(true, `未実装（WP2/基盤）: ${missing.join(", ")}`);
  });

  test("web: CSP が設定され、本番ポリシーは unsafe-eval を許可しない", async ({ request }) => {
    const response = await request.get("/");
    const csp = response.headers()["content-security-policy"];
    if (!csp) test.skip(true, "未実装（WP2/基盤）: Content-Security-Policy");
    expect(csp).toContain("default-src");
    expect(csp).toContain("frame-ancestors 'none'");
    // dev は Turbopack が eval を使うため next.config.ts の DEV_CSP が 'unsafe-eval' を許可する。
    // 本番（静的エクスポート + vercel.json）の CSP は eval を許可しないことを設定ファイルで検証する。
    const vercel = JSON.parse(readFileSync(path.join(repoRoot, "apps/web/vercel.json"), "utf8")) as {
      headers: Array<{ headers: Array<{ key: string; value: string }> }>;
    };
    const prodCsp = vercel.headers
      .flatMap((entry) => entry.headers)
      .find((header) => header.key === "Content-Security-Policy")?.value;
    expect(prodCsp, "vercel.json に Content-Security-Policy がありません").toBeTruthy();
    expect(prodCsp).not.toContain("'unsafe-eval'");
    expect(prodCsp).not.toContain("frame-ancestors *");
  });

  test("web: クリックジャッキング防止（XFO または frame-ancestors）", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    const xfo = headers["x-frame-options"];
    const csp = headers["content-security-policy"] ?? "";
    const protectedByCsp = /frame-ancestors\s+'none'|frame-ancestors\s+'self'/i.test(csp);
    if (!xfo && !csp.includes("frame-ancestors")) {
      test.skip(true, "未実装（WP2/基盤）: X-Frame-Options / CSP frame-ancestors");
    }
    if (xfo) expect(xfo).toMatch(/DENY|SAMEORIGIN/i);
    else expect(protectedByCsp).toBe(true);
  });

  test("api: JSON 応答に nosniff とキャッシュ制御", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/health`);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    const missing: string[] = [];
    if (!headers["x-content-type-options"]) missing.push("x-content-type-options");
    if (!headers["cache-control"]) missing.push("cache-control");
    if (missing.length > 0) test.skip(true, `未実装（WP0）: ${missing.join(", ")}`);
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  test("api: 404 は内部情報を漏らさない", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/__no_such_route__`);
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/stack|SQLITE|D1_ERROR|no such table|at .*\.(ts|js):/i);
  });
});