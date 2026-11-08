import { describe, expect, it } from "vitest";
import { pageLinks, parseRange, rangeLabel, rangeQuery } from "./range";

describe("parseRange", () => {
  it("未指定は最新50", () => {
    expect(parseRange(null)).toEqual({ kind: "last", count: 50 });
    expect(parseRange("")).toEqual({ kind: "last", count: 50 });
  });

  it("l<N> は最新N件（上限1000）", () => {
    expect(parseRange("l50")).toEqual({ kind: "last", count: 50 });
    expect(parseRange("l10")).toEqual({ kind: "last", count: 10 });
    expect(parseRange("l9999")).toEqual({ kind: "last", count: 1000 });
    expect(parseRange("l0")).toEqual({ kind: "last", count: 1 });
  });

  it("n / all は全部", () => {
    expect(parseRange("n")).toEqual({ kind: "last", count: 1000 });
    expect(parseRange("all")).toEqual({ kind: "last", count: 1000 });
  });

  it("範囲指定", () => {
    expect(parseRange("1-100")).toEqual({ kind: "range", from: 1, to: 100 });
    expect(parseRange("501-600")).toEqual({ kind: "range", from: 501, to: 600 });
    expect(parseRange("1-")).toEqual({ kind: "range", from: 1, to: 100 });
    expect(parseRange("42")).toEqual({ kind: "range", from: 42, to: 42 });
  });

  it("飛び番（最大100件）", () => {
    expect(parseRange("3,4,8")).toEqual({ kind: "nums", nums: [3, 4, 8] });
    expect(parseRange("images")).toEqual({ kind: "images" });
  });

  it("不正値は最新50へフォールバック", () => {
    expect(parseRange("abc")).toEqual({ kind: "last", count: 50 });
    expect(parseRange("0,0")).toEqual({ kind: "last", count: 50 });
  });
});

describe("rangeQuery / rangeLabel", () => {
  it("API 文字列へ戻せる", () => {
    expect(rangeQuery({ kind: "last", count: 50 })).toBe("l50");
    expect(rangeQuery({ kind: "range", from: 1, to: 100 })).toBe("1-100");
    expect(rangeQuery({ kind: "range", from: 7, to: 7 })).toBe("7");
    expect(rangeQuery({ kind: "nums", nums: [3, 4, 8] })).toBe("3,4,8");
    expect(rangeQuery({ kind: "images" })).toBe("images");
  });

  it("人間向けラベル", () => {
    expect(rangeLabel({ kind: "last", count: 50 })).toBe("最新50");
    expect(rangeLabel({ kind: "last", count: 1000 })).toBe("全部");
    expect(rangeLabel({ kind: "range", from: 1, to: 100 })).toBe("1-100");
    expect(rangeLabel({ kind: "images" })).toBe("画像一覧");
  });
});

describe("pageLinks", () => {
  it("100レス刻みで最大20ページ", () => {
    const links = pageLinks(250, { kind: "range", from: 1, to: 100 });
    expect(links).toHaveLength(3);
    expect(links[0]).toEqual({ label: "[1-]", r: "1-100" });
    expect(links[2]).toEqual({ label: "201-", r: "201-250" });
  });

  it("レスが少ない場合は1ページ", () => {
    expect(pageLinks(3, { kind: "last", count: 50 })).toEqual([{ label: "1-", r: "1-3" }]);
  });
});