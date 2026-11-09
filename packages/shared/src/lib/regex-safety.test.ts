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
    for (const pattern of ["(a|aa)+", "(a|a)+", "(\\d|\\w)+", "(a|ab)*", "((a|aa))+", "((?:a|ab))+"]) {
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

  it("繰り返すグループ本体の lookaround を拒否する（報告書 24 第3回 M-3）", () => {
    for (const pattern of ["((?=a+)a)+x", "((?=\\w+)\\w)+x", "((?=(a+))a)+x", "((?<=a)b)+", "((?!a)b)+"]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, pattern).toBe(false);
      expect(result.reason, pattern).toContain("lookaround");
    }
    // 可変長の lookaround は繰り返しの外でも、外側のバックトラックで繰り返し評価され得る。
    for (const pattern of ["(?=a+)", "(?=(a+))", "(?=a+[ab])", "(?<=\\w+)", "[a-z]{2,}.{2}(?=a+[ab])!"]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, pattern).toBe(false);
      expect(result.reason, pattern).toContain("lookaround");
    }
  });

  it("同じ並びの可変長量指定子が曖昧な形を拒否する（報告書 24 第3回 M-3）", () => {
    for (const pattern of ["\\w+[a-z]+", "a+a+", ".*\\s*", "(?:\\w{2,}[a-z]{2,}(?:[ab]{2}))!", "\\w+a[ab]*"]) {
      expect(analyzeRegexPattern(pattern).safe, pattern).toBe(false);
    }
    // 間がどちらの文字集合とも重ならない要素で区切られていれば許可する。
    for (const pattern of ["\\d+\\.\\d+", "\\w+\\s+\\w+", "a+b+", "[a-z]+[0-9]+"]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, `${pattern}: ${result.reason ?? ""}`).toBe(true);
    }
  });

  it("固定長だけの繰り返しは許可する", () => {
    for (const pattern of ["(abc)+", "(?:\\d{2}:)+", "(a{2}b{3})+", "(?:ab){2,4}"]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, `${pattern}: ${result.reason ?? ""}`).toBe(true);
    }
    // 固定長の lookaround は許可する。
    for (const pattern of ["(?=a)a", "(?<=\\w)x", "(?=a{2})a", "(?=a|ab)a"]) {
      const result = analyzeRegexPattern(pattern);
      expect(result.safe, `${pattern}: ${result.reason ?? ""}`).toBe(true);
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