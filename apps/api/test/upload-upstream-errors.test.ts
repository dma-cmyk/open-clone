// 保存先（外部サービス）の失敗応答を利用者向けメッセージへ翻訳する部分の回帰テスト。
// F-03: Catbox が 412 を返したとき、これまでは「HTTP 412 で失敗しました」だけで
// 次に何をすればよいか分からなかった。理由と取り得る操作（再試行 / 保存先変更）を返すこと。
import { describe, expect, it } from "vitest";
import { ApiError } from "shared";
import { assertUpstreamOk } from "../src/services/uploads/util";

function thrown(fn: () => void): ApiError {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof ApiError) return cause;
    throw cause;
  }
  throw new Error("ApiError が投げられませんでした");
}

describe("assertUpstreamOk: 保存先の拒否を利用者向けに翻訳する", () => {
  it("成功応答では何も投げない", () => {
    expect(() => assertUpstreamOk(new Response("ok", { status: 200 }), "Catbox", "catbox")).not.toThrow();
  });

  it("412 は理由・再試行・保存先変更の案内つき BAD_GATEWAY になる", () => {
    const error = thrown(() =>
      assertUpstreamOk(new Response("No file!", { status: 412 }), "Catbox（既定）", "catbox"),
    );
    expect(error.status).toBe(502);
    expect(error.code).toBe("BAD_GATEWAY");
    expect(error.message).toContain("HTTP 412");
    expect(error.message).toContain("再試行");
    expect(error.message).toContain("保存先を別のものに変えてください");
    expect(error.details).toMatchObject({
      upstreamStatus: 412,
      adapter: "catbox",
      reason: "upstream_blocked",
      retryable: true,
    });
  });

  it("403（bot 判定・IP 制限）も同じ扱いにする", () => {
    const error = thrown(() => assertUpstreamOk(new Response("Forbidden", { status: 403 }), "Catbox", "catbox"));
    expect(error.status).toBe(502);
    expect(error.details).toMatchObject({ upstreamStatus: 403, reason: "upstream_blocked" });
  });

  it("429 はレート制限として返す（再試行の案内つき）", () => {
    const error = thrown(() => assertUpstreamOk(new Response("", { status: 429 }), "Catbox", "catbox"));
    expect(error.status).toBe(429);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toContain("レート制限");
  });

  it("413 はサイズ超過として返す", () => {
    const error = thrown(() => assertUpstreamOk(new Response("", { status: 413 }), "Catbox", "catbox"));
    expect(error.status).toBe(413);
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("その他の 5xx は汎用メッセージに上流ステータスだけ載せる", () => {
    const error = thrown(() => assertUpstreamOk(new Response("", { status: 503 }), "Catbox", "catbox"));
    expect(error.status).toBe(502);
    expect(error.message).toContain("HTTP 503");
    expect(error.details).toMatchObject({ upstreamStatus: 503 });
  });
});