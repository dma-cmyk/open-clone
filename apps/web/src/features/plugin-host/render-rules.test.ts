// 宣言的レンダー規則の分割（React 描画用）の回帰テスト。
// 文字列 HTML ではなく構造を返すことで、安価・URL・AA の描画と XSS 安全（テキストノード）を両立する。

import { describe, expect, it } from "vitest";
import { splitPostRenderRules } from "./render-rules";

const spoiler = {
  pattern: "\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]",
  flags: "g",
  template: "$1",
  kind: "spoiler" as const,
};

describe("splitPostRenderRules", () => {
  it("規則の前後の本文を保持し、規則範囲をキャプチャで置き換える", () => {
    expect(splitPostRenderRules("前 [spoiler]秘密 >>2[/spoiler] 後", [spoiler])).toEqual([
      { type: "text", text: "前 " },
      { type: "rule", kind: "spoiler", text: "秘密 >>2" },
      { type: "text", text: " 後" },
    ]);
  });

  it("規則が無ければ 1 つのテキスト断片", () => {
    expect(splitPostRenderRules("ただの本文", [])).toEqual([{ type: "text", text: "ただの本文" }]);
  });

  it("テンプレート・キャプチャの HTML は文字列のまま返す（描画側でテキストとして扱う）", () => {
    const rule = {
      pattern: "\\[b\\]([\\s\\S]*?)\\[/b\\]",
      flags: "g",
      template: "<img src=x onerror=alert(1)>$1",
      kind: "text" as const,
    };
    const segments = splitPostRenderRules("[b]<script>alert(1)</script>[/b]", [rule]);
    expect(segments).toEqual([
      {
        type: "rule",
        kind: "text",
        text: "<img src=x onerror=alert(1)><script>alert(1)</script>",
      },
    ]);
  });

  it("不正な正規表現は無視して本文をそのまま返す", () => {
    const rule = { pattern: "([", flags: "g", template: "$1", kind: "text" as const };
    expect(splitPostRenderRules("<script>x</script>", [rule])).toEqual([
      { type: "text", text: "<script>x</script>" },
    ]);
  });

  it("複数の規則を順に適用する（既に変換済みの範囲は再変換しない）", () => {
    const dice = { pattern: "1d6", flags: "g", template: "🎲", kind: "dice" as const };
    const segments = splitPostRenderRules("1d6 と [spoiler]x1d6[/spoiler]", [spoiler, dice]);
    expect(segments).toEqual([
      { type: "rule", kind: "dice", text: "🎲" },
      { type: "text", text: " と " },
      { type: "rule", kind: "spoiler", text: "x1d6" },
    ]);
  });

  it("空マッチでも無限ループしない", () => {
    const rule = { pattern: "(?=a)", flags: "g", template: "!", kind: "text" as const };
    const segments = splitPostRenderRules("aa", [rule]);
    expect(segments.filter((segment) => segment.type === "rule")).toHaveLength(2);
  });
});