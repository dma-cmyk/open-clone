// 検索スニペットの装飾記法マスク（C1 / museAI #9、レビュー UX-R1 修正後）の単体テスト。
// 伏せ字記法（[sp]/[spoiler]/||...||）は中身を隠し、通常装飾・未知タグは中身を保持する。
import { describe, expect, it } from "vitest";
import { maskSnippetMarkup } from "../src/routes/search";

describe("maskSnippetMarkup", () => {
  it("1行の [sp] は中身を伏せ字にする", () => {
    const masked = maskSnippetMarkup("[sp]QA伏せ字表示テスト[/sp]");
    expect(masked).not.toContain("[sp]");
    expect(masked).not.toContain("[/sp]");
    expect(masked).not.toContain("QA伏せ字表示テスト");
    expect(masked).toContain("█");
  });

  it("改行を含む [sp] も範囲全体を伏せ字にする", () => {
    const masked = maskSnippetMarkup("[sp]隠した一行目\n隠した二行目[/sp]");
    expect(masked).not.toContain("隠した一行目");
    expect(masked).not.toContain("隠した二行目");
    expect(masked).not.toContain("\n");
  });

  it("角括弧を含む [sp] も範囲全体を伏せ字にする", () => {
    const masked = maskSnippetMarkup("[sp]隠した角括弧[1]の本文[/sp]");
    expect(masked).not.toContain("隠した角括弧");
    expect(masked).not.toContain("[1]");
  });

  it("公式サンプルと同じ [spoiler] 記法も伏せ字にする", () => {
    const masked = maskSnippetMarkup("前 [spoiler]秘密\n>>2[/spoiler] 後");
    expect(masked).not.toContain("秘密");
    expect(masked.startsWith("前 ")).toBe(true);
    expect(masked.endsWith(" 後")).toBe(true);
  });

  it("組み込み伏せ字 ||...|| も伏せ字にする", () => {
    const masked = maskSnippetMarkup("||組み込み伏せ字||");
    expect(masked).not.toContain("組み込み伏せ字");
    expect(masked).not.toContain("||");
  });

  it("通常装飾・未知のタグは中身を消さずマーカだけ除去する", () => {
    expect(maskSnippetMarkup("[b]通常の強調本文[/b]")).toBe("通常の強調本文");
    expect(maskSnippetMarkup("[unknown]何か[/unknown]")).toBe("何か");
    expect(maskSnippetMarkup("[sp] だけ")).toBe(" だけ");
    expect(maskSnippetMarkup("途中 [/sp] だけ")).toBe("途中  だけ");
  });

  it("記法でない角括弧（参照番号や配列）は壊さない", () => {
    expect(maskSnippetMarkup("see [1] and [2] refs")).toBe("see [1] and [2] refs");
    expect(maskSnippetMarkup("配列 a[0] はそのまま")).toBe("配列 a[0] はそのまま");
  });

  it("HTML 文字列はそのまま返し、React のテキスト描画で無害化する", () => {
    const payload = '<img src=x onerror="window.__x=1">';
    expect(maskSnippetMarkup(payload)).toBe(payload);
  });

  it("長い伏せ字の中身は表示を 40 字までに丸める", () => {
    const masked = maskSnippetMarkup(`[sp]${"あ".repeat(300)}[/sp]`);
    expect(masked.length).toBeLessThanOrEqual(40);
    expect(masked.length).toBeGreaterThan(0);
  });

  it("タイトルに適用しても通常のタイトルを欠落させない", () => {
    expect(maskSnippetMarkup("動作確認スレ 2026-11-15")).toBe("動作確認スレ 2026-11-15");
    expect(maskSnippetMarkup("[sp]秘密[/sp]のスレ")).not.toContain("秘密");
  });
});
