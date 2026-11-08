// SQL インジェクション耐性（DESIGN §13: 全 API を zod + D1 bind で検証）。
// 入力はデータとして扱われ、SQL エラー・内部情報がレスポンスに漏れないことを確認する。
import { expect, test, type APIResponse } from "@playwright/test";
import { API_BASE, readEnvelope, skipIfUnimplemented } from "../helpers/api";

const SQLI_PAYLOADS = [
  "' OR 1=1 --",
  "') OR ('1'='1",
  "1; DROP TABLE posts; --",
  "UNION SELECT password_hash FROM accounts --",
  "' AND (SELECT COUNT(*) FROM accounts) > 0 --",
];

// D1/SQLite のエラー痕跡。レスポンスに出てはいけない。
const LEAK_PATTERN =
  /SQLITE_ERROR|D1_ERROR|syntax error|no such table|no such column|UNIQUE constraint failed|stack trace|SqliteError/i;

async function assertNoLeak(response: APIResponse): Promise<string> {
  const text = await response.text();
  expect(text).not.toMatch(LEAK_PATTERN);
  return text;
}

test.describe("SQL インジェクション", () => {
  test("検索 q に SQL 断片を渡しても 500 にならず内部情報を漏らさない", async ({ request }) => {
    for (const payload of SQLI_PAYLOADS) {
      const response = await request.get(`${API_BASE}/v1/search?q=${encodeURIComponent(payload)}`);
      if (await skipIfUnimplemented(response)) return;
      expect(response.status(), payload).toBeLessThan(500);
      await assertNoLeak(response);
      const body = await readEnvelope(response);
      expect(body, payload).not.toBeNull();
    }
  });

  test("板一覧の q パラメータ", async ({ request }) => {
    for (const payload of SQLI_PAYLOADS) {
      const response = await request.get(`${API_BASE}/v1/boards?q=${encodeURIComponent(payload)}`);
      if (await skipIfUnimplemented(response)) return;
      expect(response.status(), payload).toBeLessThan(500);
      await assertNoLeak(response);
    }
  });

  test("since（差分取得）に SQL 断片", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/threads/1?since=${encodeURIComponent("1 OR 1=1")}`);
    if (await skipIfUnimplemented(response)) return;
    expect(response.status()).toBeLessThan(500);
    await assertNoLeak(response);
  });

  test("パストラバーサルでファイルを読めない", async ({ request }) => {
    const paths = [
      "/v1/../../etc/passwd",
      "/v1/%2e%2e/%2e%2e/etc/passwd",
      "/compat/../../etc/passwd/subject.txt",
    ];
    for (const path of paths) {
      const response = await request.get(`${API_BASE}${path}`);
      expect(response.status(), path).toBeLessThan(500);
      const text = await response.text();
      expect(text, path).not.toContain("root:x:0:0");
    }
  });
});