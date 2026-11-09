// 宣言的レンダー規則の分割（React 描画用）の回帰テスト。
// 文字列 HTML ではなく構造を返すことで、安価・URL・AA の描画と XSS 安全（テキストノード）を両立する。

import { afterEach, describe, expect, it } from "vitest";
import {
  applyPostRenderRules,
  resetRenderRuleGuardsForTest,
  setRenderRuleTimeBudgetForTest,
  splitPostRenderRules,
} from "./render-rules";

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
describe("ReDoS 対策（報告書 24 M-1）", () => {
  afterEach(() => resetRenderRuleGuardsForTest());

  it("危険な正規表現（(a+)+b）は実行せず、31 文字の入力でも即座に本文を返す", () => {
    const rule = { pattern: "(a+)+b", flags: "g", template: "$1", kind: "text" as const };
    const text = `${"a".repeat(30)}!`;
    const started = performance.now();
    const segments = splitPostRenderRules(text, [rule]);
    const elapsed = performance.now() - started;
    // 未対策なら 31 文字で数十秒かかる（実測 64,044ms）。静的判定で即時拒否される。
    expect(elapsed).toBeLessThan(100);
    expect(segments).toEqual([{ type: "text", text }]);
  });

  it("HTML 文字列版（applyPostRenderRules）も危険な規則を実行しない", () => {
    const rule = { pattern: "(a+)+b", flags: "g", template: "$1", kind: "text" as const };
    const text = `${"a".repeat(30)}!`;
    const result = applyPostRenderRules(text, [rule]);
    expect(result.matched).toBe(false);
    expect(result.html).toBe(text);
  });

  it("可変長の要素を含む並びの繰り返し（M-2）も実行せず即座に返す", () => {
    const text = `${"a".repeat(600)}!`;
    for (const pattern of ["(a+[ab])+x", "(\\w+a)+x", "(?:a+[b])+x", "(?=(a+[ab])+)"]) {
      const rule = { pattern, flags: "g", template: "$1", kind: "text" as const };
      const started = performance.now();
      expect(splitPostRenderRules(text, [rule]), pattern).toEqual([{ type: "text", text }]);
      expect(applyPostRenderRules(text, [rule]).matched, pattern).toBe(false);
      expect(performance.now() - started, pattern).toBeLessThan(200);
    }
  });

  it("実行時間の上限を超えた規則は諦め、以降も無効化する", () => {
    setRenderRuleTimeBudgetForTest(-1);
    const rule = { pattern: "a", flags: "g", template: "!", kind: "text" as const };
    expect(splitPostRenderRules("aaa", [rule])).toEqual([{ type: "text", text: "aaa" }]);
    // 無効化済みなので、上限を戻しても実行されない。
    setRenderRuleTimeBudgetForTest(50);
    expect(splitPostRenderRules("aaa", [rule])).toEqual([{ type: "text", text: "aaa" }]);
  });

  it("マッチ数が上限（500）を超える規則は適用しない", () => {
    const rule = { pattern: "a", flags: "g", template: "!", kind: "text" as const };
    const text = "a".repeat(600);
    expect(splitPostRenderRules(text, [rule])).toEqual([{ type: "text", text }]);
  });

  it("本文が上限（10,000 文字）を超える場合は規則を適用しない", () => {
    const rule = { pattern: "a", flags: "g", template: "!", kind: "text" as const };
    const text = "a".repeat(10_001);
    expect(splitPostRenderRules(text, [rule])).toEqual([{ type: "text", text }]);
  });
});
