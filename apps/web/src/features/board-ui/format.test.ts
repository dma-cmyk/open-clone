import { describe, expect, it } from "vitest";
import { expandAnchorSpec, formatDate, formatRelative, formatSize, mediaKind, truncate } from "./format";

describe("formatDate", () => {
  it("open2ch 書式（2桁年・全角括弧・曜日）", () => {
    const date = new Date(2026, 10, 8, 9, 19, 44);
    expect(formatDate(Math.floor(date.getTime() / 1000))).toBe("26/11/08(日) 09:19:44");
  });

  it("不正値は空文字", () => {
    expect(formatDate(Number.NaN)).toBe("");
  });
});

describe("formatRelative", () => {
  const now = 1_800_000_000;
  it("分・時間・日", () => {
    expect(formatRelative(now - 30, now)).toBe("たった今");
    expect(formatRelative(now - 120, now)).toBe("2分前");
    expect(formatRelative(now - 7200, now)).toBe("2時間前");
    expect(formatRelative(now - 86400 * 3, now)).toBe("3日前");
  });

  it("未指定は空", () => {
    expect(formatRelative(null, now)).toBe("");
  });
});

describe("expandAnchorSpec", () => {
  it("単体・範囲・飛び番", () => {
    expect(expandAnchorSpec(">>5")).toEqual([5]);
    expect(expandAnchorSpec(">>1-3")).toEqual([1, 2, 3]);
    expect(expandAnchorSpec(">>3,4,8")).toEqual([3, 4, 8]);
    expect(expandAnchorSpec(">>3-5,9")).toEqual([3, 4, 5, 9]);
  });

  it("逆順範囲は正規化し、100件で打ち切る", () => {
    expect(expandAnchorSpec(">>5-3")).toEqual([3, 4, 5]);
    expect(expandAnchorSpec(">>1-500")).toHaveLength(100);
  });

  it("不正値は空", () => {
    expect(expandAnchorSpec(">>abc")).toEqual([]);
  });
});

describe("mediaKind", () => {
  it("拡張子と contentType で判定", () => {
    expect(mediaKind("https://example.com/a.png")).toBe("image");
    expect(mediaKind("https://example.com/a", "image/webp")).toBe("image");
    expect(mediaKind("https://example.com/a.mp4")).toBe("video");
    expect(mediaKind("https://example.com/a.txt")).toBe("text");
    expect(mediaKind("https://example.com/a.zip")).toBe("file");
  });
});

describe("formatSize / truncate", () => {
  it("サイズ表記", () => {
    expect(formatSize(0)).toBe("");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.00 MB");
  });

  it("切り詰め", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
    expect(truncate("abc", 3)).toBe("abc");
  });
});