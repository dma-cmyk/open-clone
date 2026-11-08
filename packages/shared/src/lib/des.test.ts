import { describe, expect, it } from "vitest";
import { desCrypt, generateTrip, parseTripName } from "./des";

// ゴールデンベクタ: システム crypt(3)（perl crypt / glibc）から生成した値。
// password|salt|expected
const CRYPT_VECTORS = [
  "password|sa|sa3tHJ3/KuYvI",
  "password|ab|abJnggxhB/yWI",
  "12345678|12|12yJ.Of/NQ.Pk",
  "tripkey12|ab|abtMa5P9JtlP.",
  "a|H.|H.6ZnBI2EKkq.",
  "abcdefgh|AA|AA4BwdrBifKl.",
  "helloWorld|xy|xyQEH61TErhBY",
  "p|..|..MksImr6rRgc",
  "longpassword123|z9|z98IPiQXcjnNU",
] as const;

describe("desCrypt (crypt(3) 互換)", () => {
  for (const vector of CRYPT_VECTORS) {
    const [password, salt, expected] = vector.split("|") as [string, string, string];
    it(`crypt("${password}", "${salt}") === "${expected}"`, () => {
      expect(desCrypt(password, salt)).toBe(expected);
    });
  }

  it("salt は 2 文字に切り詰める", () => {
    expect(desCrypt("password", "saXX")).toBe(desCrypt("password", "sa"));
  });

  it("パスワードは先頭8文字のみ", () => {
    expect(desCrypt("abcdefghXXXX", "AA")).toBe(desCrypt("abcdefgh", "AA"));
  });
});

describe("generateTrip (2ch 互換 ◆+10桁)", () => {
  // ゴールデンベクタ: perl crypt(3) + 0ch+ 準拠の salt 正規化で生成
  // （salt = substr(key."H.", 1, 2) → 無効文字置換 → tr マッピング → crypt → 3文字目以降10桁）
  const TRIP_VECTORS: Array<[string, string]> = [
    ["abc", "◆GmgU93SCyE"],
    ["mysecret", "◆fPW0jN7TZA"],
    ["trip", "◆hEpdoZ.tHU"],
    ["a", "◆ZnBI2EKkq."],
    ["ab", "◆85qvGhCCNc"],
    ["test1234", "◆o9CDijBNYE"],
    ["12345678", "◆WBRXcNtpf."],
  ];
  for (const [key, expected] of TRIP_VECTORS) {
    it(`trip("${key}") === "${expected}"`, () => {
      expect(generateTrip(key)).toBe(expected);
    });
  }

  it("形式: ◆ + [./0-9A-Za-z] 10桁", () => {
    expect(generateTrip("abc")).toMatch(/^◆[./0-9A-Za-z]{10}$/);
  });

  it("同じキー → 同じトリップ", () => {
    expect(generateTrip("mysecret")).toBe(generateTrip("mysecret"));
  });

  it("キーは12バイト（SJIS）で切り詰め", () => {
    expect(generateTrip("abcdefghijklEXTRA")).toBe(generateTrip("abcdefghijkl"));
  });

  it("短いキーでも 10 桁（0ch+ 準拠の H. パディング）", () => {
    expect(generateTrip("a")).toMatch(/^◆[./0-9A-Za-z]{10}$/);
  });

  it("日本語キーでも 10 桁", () => {
    expect(generateTrip("日本語テスト")).toMatch(/^◆[./0-9A-Za-z]{10}$/);
  });
});

describe("parseTripName", () => {
  it("# なしならそのまま", () => {
    expect(parseTripName("名無し")).toEqual({ name: "名無し", trip: null });
  });
  it("#key → 名前とトリップに分解", () => {
    const parsed = parseTripName("名無し#secret");
    expect(parsed.name).toBe("名無し");
    expect(parsed.trip).toBe(generateTrip("secret"));
  });
  it("# だけならトリップなし", () => {
    expect(parseTripName("名無し#")).toEqual({ name: "名無し", trip: null });
  });
});
