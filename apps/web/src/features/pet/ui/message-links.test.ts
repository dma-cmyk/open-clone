// 返事の中のリンク化。同じサイト内のパスだけをリンクにする（HTML は解釈しない）。

import { describe, expect, it } from "vitest";
import { splitSiteLinks } from "./message-links";

describe("splitSiteLinks", () => {
  it("文章中のパスだけをリンクにする", () => {
    expect(splitSiteLinks("/b/news を見てください")).toEqual([
      { type: "link", value: "/b/news" },
      { type: "text", value: " を見てください" },
    ]);
  });

  it("句読点や閉じ括弧はリンクに含めない", () => {
    expect(splitSiteLinks("（/b/news/t/12）")).toEqual([
      { type: "text", value: "（" },
      { type: "link", value: "/b/news/t/12" },
      { type: "text", value: "）" },
    ]);
    expect(splitSiteLinks("/b/news。")).toEqual([
      { type: "link", value: "/b/news" },
      { type: "text", value: "。" },
    ]);
  });

  it("別ホスト（//example.com）と英数字の途中はリンクにしない", () => {
    expect(splitSiteLinks("https://example.com/b/news")).toEqual([
      { type: "text", value: "https://example.com/b/news" },
    ]);
    // 直前が英数字ならパスとして扱わない（`path/b/news` 全体が文字のまま）。
    expect(splitSiteLinks("path/b/news")).toEqual([{ type: "text", value: "path/b/news" }]);
  });

  it("リンクが無ければ全体をそのまま返す", () => {
    expect(splitSiteLinks("こんにちは\nまたね")).toEqual([{ type: "text", value: "こんにちは\nまたね" }]);
  });
});