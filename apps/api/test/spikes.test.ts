// ランタイム機能のスパイク（結果は DESIGN §A に記録済み）。
// 実装全体の前提となる環境機能をテストとして固定する。将来のランタイム変更を検知できる。

import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it } from "vitest";
import { network } from "./network";

describe("spike: D1 FTS5 trigram", () => {
  beforeAll(async () => {
    await env.DB.exec("DROP TABLE IF EXISTS spike_fts");
    await env.DB.exec(
      "CREATE VIRTUAL TABLE spike_fts USING fts5(body, tokenize='trigram')",
    );
    await env.DB.prepare(
      "INSERT INTO spike_fts(rowid, body) VALUES (1, ?), (2, ?)",
    )
      .bind("プロ野球について語りましょう", "宇宙戦艦ヤマト2202")
      .run();
  });

  it("3文字以上のクエリで部分一致する", async () => {
    const result = await env.DB.prepare(
      "SELECT rowid FROM spike_fts WHERE spike_fts MATCH '野球に'",
    ).all();
    expect(result.results.map((row) => row["rowid"])).toEqual([1]);
  });

  it("2文字クエリはヒットしない（DESIGN §15-6: LIKE フォールバックが必要）", async () => {
    const result = await env.DB.prepare(
      "SELECT rowid FROM spike_fts WHERE spike_fts MATCH '野球'",
    ).all();
    expect(result.results).toHaveLength(0);
  });

  it("LIKE フォールバックは 2文字でもヒットする", async () => {
    const result = await env.DB.prepare(
      "SELECT rowid FROM spike_fts WHERE body LIKE '%野球%'",
    ).all();
    expect(result.results.map((row) => row["rowid"])).toEqual([1]);
  });
});

describe("spike: PBKDF2-SHA256 100k iterations（Workers Free の CPU 10ms 制約）", () => {
  it("WebCrypto で deriveBits できる（100k 反復）", async () => {
    const started = Date.now();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("password"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode("test-salt"),
        iterations: 100_000,
      },
      key,
      256,
    );
    expect(new Uint8Array(bits)).toHaveLength(32);
    const elapsed = Date.now() - started;
    console.log(`PBKDF2-100k wall time: ${elapsed}ms`);
    // 明確に遅すぎる場合（>3秒）は設計見直しが必要。10ms 超過は Cloudflare 側で打ち切られる。
    expect(elapsed).toBeLessThan(3_000);
  }, 10_000);
});

describe("spike: Turnstile テストキー（MSW で siteverify をモック）", () => {
  it("siteverify をスタブ経由で成功扱いにできる", async () => {
    network.use(
      http.post("https://challenges.cloudflare.com/turnstile/v0/siteverify", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY ?? "");
    form.append("response", "dummy");
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });
});
