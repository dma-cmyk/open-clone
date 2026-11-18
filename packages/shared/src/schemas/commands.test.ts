// 名前欄コマンドのパーサ（`!NdM` の書式・境界・1 レス 1 個）の単体テスト。

import { describe, expect, it } from "vitest";
import { parseNameCommands } from "./commands";

describe("名前欄の !NdM", () => {
  it("末尾の !2d6 を取り除き、さいころの指定を返す", () => {
    expect(parseNameCommands("!2d6")).toMatchObject({ name: "", dice: { count: 2, sides: 6 } });
    expect(parseNameCommands("名無し !2d6")).toMatchObject({ name: "名無し", dice: { count: 2, sides: 6 } });
    expect(parseNameCommands("名無し!2d6")).toMatchObject({ name: "名無し", dice: { count: 2, sides: 6 } });
  });

  it("書式の境界（N=1・10、M=2・1000）を受け付ける", () => {
    for (const [raw, dice] of [
      ["!1d2", { count: 1, sides: 2 }],
      ["!10d1000", { count: 10, sides: 1000 }],
      ["!1d1000", { count: 1, sides: 1000 }],
      ["!10d2", { count: 10, sides: 2 }],
    ] as const) {
      expect(parseNameCommands(raw), raw).toMatchObject({ name: "", dice });
    }
  });

  it("範囲外はコマンドとして扱わず、名前にそのまま残す", () => {
    for (const raw of ["!0d6", "!11d6", "!2d1", "!2d1001", "!0d0", "!100d6"]) {
      const parsed = parseNameCommands(raw);
      expect(parsed.dice, raw).toBeNull();
      expect(parsed.name, raw).toBe(raw);
    }
  });

  it("1 レス 1 個まで（2 個目以降は振らず、名前からも取り除く）", () => {
    const parsed = parseNameCommands("!2d6 !3d8 !1d4");
    expect(parsed.dice).toEqual({ count: 2, sides: 6 });
    expect(parsed.name).toBe("");
    expect(parsed.name).not.toContain("!3d8");
  });

  it("既存のコマンドと組み合わせても動く", () => {
    const parsed = parseNameCommands("名無し!random !2d6");
    expect(parsed.commands).toEqual(["!random"]);
    expect(parsed.forceSage).toBe(true);
    expect(parsed.dice).toEqual({ count: 2, sides: 6 });
    expect(parsed.name).toBe("名無し");
  });

  it("空白の直後でない !2d6 はコマンドにしない（既存の !random と同じ境界）", () => {
    const parsed = parseNameCommands("!2d6だめ");
    expect(parsed.dice).toBeNull();
    expect(parsed.name).toBe("!2d6だめ");
  });

  it("ダイス以外の名前は変えない", () => {
    const parsed = parseNameCommands("名無しさん");
    expect(parsed).toMatchObject({ name: "名無しさん", dice: null, commands: [] });
  });
});