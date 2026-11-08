import { describe, expect, it } from "vitest";
import { decodeShiftJis, encodeShiftJis, shiftJisByteLength } from "./shiftjis";

describe("shiftjis", () => {
  it("ASCII 往復", () => {
    const bytes = encodeShiftJis("Hello, World! 123");
    expect(bytes).toEqual(new TextEncoder().encode("Hello, World! 123"));
    expect(decodeShiftJis(bytes)).toBe("Hello, World! 123");
  });

  it("既知のバイト列: 日本 → 0x93FA 0x967B", () => {
    expect(Array.from(encodeShiftJis("日本"))).toEqual([0x93, 0xfa, 0x96, 0x7b]);
  });

  it("日本語の往復", () => {
    const text = "名無しさん＠おーぷん　【12球団総合】プロ野球雑談・議論 2026-27 Part55";
    expect(decodeShiftJis(encodeShiftJis(text))).toBe(text);
  });

  it("半角カナの往復", () => {
    const text = "ｶﾀｶﾅﾃｽﾄｱｲｳｴｵ";
    expect(decodeShiftJis(encodeShiftJis(text))).toBe(text);
  });

  it("変換不能文字は ? に置換", () => {
    expect(Array.from(encodeShiftJis("a🐈b"))).toEqual([0x61, 0x3f, 0x62]);
  });

  it("shiftJisByteLength はバイト数を返す", () => {
    expect(shiftJisByteLength("ab")).toBe(2);
    expect(shiftJisByteLength("日本語")).toBe(6);
    expect(shiftJisByteLength("ｱｲｳ")).toBe(3);
  });

  it("subject.txt 実測形式の往復", () => {
    const line = "1794097184.dat<>【12球団総合】プロ野球雑談・議論 2026-27 Part55 (718)";
    expect(decodeShiftJis(encodeShiftJis(line))).toBe(line);
  });
});
