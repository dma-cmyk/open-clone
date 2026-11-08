import { describe, expect, it } from "vitest";
import { isValidUlid, ulid, ulidTime } from "./ulid";

describe("ulid", () => {
  it("形式: 26文字 Crockford Base32", () => {
    const id = ulid();
    expect(isValidUlid(id)).toBe(true);
    expect(id).toHaveLength(26);
  });

  it("時刻が埋め込まれる・復元できる", () => {
    const time = 1_760_000_000_000;
    const id = ulid(time);
    expect(ulidTime(id)).toBe(time);
  });

  it("単調性（同時刻でも乱数で一意、時刻順ソート）", () => {
    const ids = new Set(Array.from({ length: 100 }, () => ulid(1_760_000_000_000)));
    expect(ids.size).toBe(100);
    const sorted = [...ids].sort();
    expect(sorted[0]! < sorted[99]!).toBe(true);
  });

  it("不正形式は拒否", () => {
    expect(isValidUlid("not-a-ulid")).toBe(false);
    expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV!")).toBe(false);
  });
});
