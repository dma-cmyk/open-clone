// 宣言的レンダー規則の正規表現の安全性判定（ReDoS 対策）の回帰テスト。
// 報告書 24 M-1 の再現パターン `(a+)+b` を拒否し、公式サンプルは通すことを確認する。

import { describe, expect, it } from "vitest";
import { analyzeRegexPattern, REGEX_PATTERN_MAX_LENGTH } from "./regex-safety";

describe("analyzeRegexPattern", () => {
  it("入れ子の量指定子（報告書 24 の再現パターン）を拒否する", () => {
    for (const pattern of ["(a+)+b", "(a*)*", "(a+)*", "(?:a+)+", "(a?){2,}", "([a-z]+)+$"]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, pattern).toBe(false);
      expect(result.reason, pattern).toBeTruthy();
    }
  });

  it("空文字に一致し得るグループの繰り返しを拒否する", () => {
    for (const pattern of ["(a*)+", "(a?)+", "(a|)+", "(?:a*)*"]) {
      expect(analyzeRegexPattern(pattern).safe, pattern).toBe(false);
    }
  });

  it("重なる選択肢の繰り返しを拒否する", () => {
    for (const pattern of ["(a|aa)+", "(a|a)+", "(\\d|\\w)+", "(a|ab)*"]) {
      expect(analyzeRegexPattern(pattern).safe, pattern).toBe(false);
    }
  });

  it("可変長の要素を含む並びの繰り返しを拒否する（報告書 24 第2回 M-2）", () => {
    for (const pattern of [
      "(a+[ab])+x",
      "(\\w+a)+x",
      "(?:a+[b])+x",
      // lookahead / lookbehind の中も同じ判定
      "(?=(a+[ab])+)",
      "(?<=(a+[ab])+)",
      // 透過的なグループで包んでも判定する
      "((a+b))+",
      "(\\d+\\.)+",
      "([A-Z][a-z]+)+",
    ]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, pattern).toBe(false);
      expect(result.reason, pattern).toBeTruthy();
    }
  });

  it("後方参照・過大な長さ・過大な繰り返し回数を拒否する", () => {
    expect(analyzeRegexPattern("(a)\\1").safe).toBe(false);
    expect(analyzeRegexPattern("(?<x>a)\\k<x>").safe).toBe(false);
    expect(analyzeRegexPattern("a".repeat(REGEX_PATTERN_MAX_LENGTH + 1)).safe).toBe(false);
    expect(analyzeRegexPattern("a{1001}").safe).toBe(false);
    expect(analyzeRegexPattern("a{1,1001}").safe).toBe(false);
  });

  it("公式サンプル（spoiler）と一般的な安全な規則は通す", () => {
    for (const pattern of [
      "\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]",
      "\\[x\\]([\\s\\S]*?)\\[/x\\]",
      "\\|\\|(.+?)\\|\\|",
      "1d6",
      "(?:ab)+",
      "(abc)+",
      "(a|b)+",
      "(?=a)",
      "[a-z]+@[a-z]+\\.[a-z]+",
    ]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, `${pattern}: ${result.reason ?? ""}`).toBe(true);
    }
  });

  it("判定は入力長に対して十分速い（実行前の静的判定）", () => {
    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) analyzeRegexPattern("(a+)+b");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});