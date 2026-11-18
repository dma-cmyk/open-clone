// 名前欄コマンドの表示（サーバー乱数・長い名前・偽装防止）の単体テスト。

import { describe, expect, it } from "vitest";
import {
  NAME_MAX_CHARS,
  decorateName,
  formatDiceResult,
  neutralizeNameBrackets,
  randomBelow,
  rollDice,
} from "../src/lib/name-decoration";

const DICE_2D6 = { count: 2, sides: 6 };

describe("サイコロの乱数", () => {
  it("出目は 1〜面の数に収まり、個数ぶん返る", () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const roll = rollDice({ count: 10, sides: 1000 });
      expect(roll.values).toHaveLength(10);
      for (const value of roll.values) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(1);
        expect(value).toBeLessThanOrEqual(1000);
      }
      expect(roll.total).toBe(roll.values.reduce((sum, value) => sum + value, 0));
    }
  });

  it("1d6 の出目に無視できる以上の偏りがない", () => {
    const trials = 60_000;
    const counts = new Map<number, number>();
    for (let index = 0; index < trials; index += 1) {
      const [value] = rollDice({ count: 1, sides: 6 }).values;
      counts.set(value!, (counts.get(value!) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    const expected = trials / 6;
    // 5% の幅（標準偏差 ≈ 91 の 5.5 倍）。実装が `% 6` のままであっても差は出ないが、
    // 「偏りのない方法で振っている」ことを分布で確認する。
    for (const face of [1, 2, 3, 4, 5, 6]) {
      const count = counts.get(face) ?? 0;
      expect(Math.abs(count - expected), `face ${face}: ${count}`).toBeLessThan(expected * 0.05);
    }
  });

  it("randomBelow は 0 以上 maxExclusive 未満", () => {
    expect(() => randomBelow(0)).toThrow(RangeError);
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      const value = randomBelow(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });
});

describe("出目の表示", () => {
  it("1 個は合計を省き、2 個以上は合計を付ける（設計の例どおり）", () => {
    expect(formatDiceResult({ dice: { count: 1, sides: 6 }, values: [4], total: 4 })).toBe("【1d6:4】");
    expect(formatDiceResult({ dice: { count: 2, sides: 6 }, values: [3, 5], total: 8 })).toBe("【2d6:3+5=8】");
    expect(
      formatDiceResult({ dice: { count: 10, sides: 1000 }, values: [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1000], total: 2008 }),
    ).toBe("【10d1000:1000+1+1+1+1+1+1+1+1+1000=2008】");
  });
});

describe("表示名の組み立て", () => {
  it("長い名前でも出目の表示は切らない", () => {
    const longName = "あ".repeat(64);
    const name = decorateName(longName, 1, [], DICE_2D6);
    expect(name.endsWith("】")).toBe(true);
    expect(name).toMatch(/【2d6:\d\+\d=\d+】$/);
    // 切るのは利用者の名前の側だけ（出目の表示は完全に残る）。
    expect(Array.from(name).length).toBeLessThanOrEqual(NAME_MAX_CHARS);
  });

  it("名前とコマンドが両方長くても、おみくじと出目は切らない", () => {
    const longName = "い".repeat(64);
    const name = decorateName(longName, 12, ["!ninja", "!random", "!kuji", "!dama"], DICE_2D6);
    expect(name).toContain("(Lv12)");
    expect(name).toContain("(乱数:");
    expect(name).toMatch(/【(大吉|中吉|小吉|吉|末吉|凶|大凶)】/);
    expect(name).toContain("(お年玉:");
    expect(name).toMatch(/【2d6:\d\+\d=\d+】$/);
    // 利用者の名前は上限に合わせて縮むが、空にはしない。
    expect(name.startsWith("名無しさん")).toBe(false);
    expect(name.startsWith("い")).toBe(true);
  });

  it("名前が空なら既定名を使う", () => {
    expect(decorateName("", 1, [], null)).toBe("名無しさん");
    expect(decorateName("   ", 1, [], DICE_2D6)).toMatch(/^名無しさん 【2d6:/);
  });

  it("既存の表示（!ninja / !random / !dama）を壊さない", () => {
    const ninja = decorateName("名無し", 3, ["!ninja"], null);
    expect(ninja).toBe("名無し (Lv3)");
    expect(decorateName("名無し", 1, ["!random"], null)).toMatch(/^名無し \(乱数:\d{1,3}\)$/);
    expect(decorateName("名無し", 1, ["!dama"], null)).toMatch(/^名無し \(お年玉:\d{1,5}円\)$/);
  });
});

describe("偽装できないこと", () => {
  it("手書きの【2d6:6+6=12】は本物の出目と見分けられる", () => {
    const vanilla = neutralizeNameBrackets("【2d6:6+6=12】");
    expect(vanilla).toBe("〔2d6:6+6=12〕");

    const name = decorateName("【2d6:6+6=12】", 1, [], DICE_2D6);
    expect(name).toContain("〔2d6:6+6=12〕");
    // 本物の出目は 1 個だけで、名前側の括弧は必ず別の文字になっている。
    expect(name.split("【")).toHaveLength(2);
    expect(name).not.toContain("【2d6:6+6=12】");
  });

  it("手書きの【大吉】も本物のおみくじと見分けられる", () => {
    const fake = decorateName("【大吉】", 1, [], null);
    expect(fake).toBe("〔大吉〕");

    const real = decorateName("【大吉】", 1, ["!kuji"], null);
    expect(real).toContain("〔大吉〕");
    expect(real.split("【")).toHaveLength(2);
    expect(real).toMatch(/〔大吉〕 【(大吉|中吉|小吉|吉|末吉|凶|大凶)】$/);
  });

  it("全角・半角の括弧が混ざっていても名前側は必ず変わる", () => {
    for (const attempt of ["【 2d6 : 6+6=12 】", "【1d6:6】", "【大凶】", "【】【】"]) {
      const name = decorateName(attempt, 1, [], DICE_2D6);
      expect(name, attempt).not.toMatch(/^【/);
      expect(name).toContain("【2d6:");
      expect(name.split("【")).toHaveLength(2);
    }
  });
});