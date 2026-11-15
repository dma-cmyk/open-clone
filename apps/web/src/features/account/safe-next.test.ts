// ログイン/新規登録の戻り先 `next` の検証（レビュー UX-R3）の単体テスト。
import { describe, expect, it } from "vitest";
import { resolveSafeNext } from "./safe-next";

describe("resolveSafeNext", () => {
  it("同一サイト内のローカルパスは保持する", () => {
    expect(resolveSafeNext("/boards/new", "/account")).toBe("/boards/new");
    expect(resolveSafeNext("/search?q=%E6%A4%9C%E7%B4%A2&type=full", "/account")).toBe(
      "/search?q=%E6%A4%9C%E7%B4%A2&type=full",
    );
  });

  it("未指定・空は既定値へ落とす", () => {
    expect(resolveSafeNext(null, "/account")).toBe("/account");
    expect(resolveSafeNext("", "/account")).toBe("/account");
  });

  it("プロトコル相対 URL（//host）は拒否する", () => {
    expect(resolveSafeNext("//outside.invalid/", "/account")).toBe("/account");
  });

  it("バックスラッシュで始まる外部 URL 相当は拒否する", () => {
    expect(resolveSafeNext("/\\outside.invalid/", "/account")).toBe("/account");
    expect(resolveSafeNext("\\\\outside.invalid/", "/account")).toBe("/account");
  });

  it("スキーム付き URL は拒否する", () => {
    expect(resolveSafeNext("http://outside.invalid/", "/account")).toBe("/account");
    expect(resolveSafeNext("https://outside.invalid/x", "/account")).toBe("/account");
    expect(resolveSafeNext("javascript:alert(1)", "/account")).toBe("/account");
  });

  it("制御文字・空白を含む値は拒否する", () => {
    expect(resolveSafeNext("/\t/outside.invalid/", "/account")).toBe("/account");
    expect(resolveSafeNext("/settings\n", "/account")).toBe("/account");
    // 空白はオリジンを越えられないため同一サイト内のパスとして通す
    expect(resolveSafeNext("/set tings", "/account")).toBe("/set tings");
  });

  it("% 符号化された制御文字も拒否する", () => {
    expect(resolveSafeNext("/%09/outside.invalid/", "/account")).toBe("/account");
    expect(resolveSafeNext("/%0a/settings", "/account")).toBe("/account");
    // %2F で組み立てた //host 相当も拒否する
    expect(resolveSafeNext("/%2F%2Foutside.invalid/", "/account")).toBe("/account");
  });
});
