// M-2: 静的検査の Unicode エスケープ回避。
// 識別子の位置の `\uXXXX` / `\u{...}` は拒否し、文字列・テンプレート・コメント・
// 正規表現リテラル内のエスケープは許可することを確認する。

import { describe, expect, it } from "vitest";
import diceSample from "../../../examples/plugins/dice/plugin.js?raw";
import gallerySample from "../../../examples/plugins/gallery/plugin.js?raw";
import gistSample from "../../../examples/plugins/gist-embed/plugin.js?raw";
import spoilerSample from "../../../examples/plugins/spoiler/plugin.js?raw";
import { runStaticChecks } from "../src/services/plugins/static-checks";

const IDENTIFIER_ESCAPES = [
  "\\u0065val('1+1');",
  "new \\u0046unction('x');",
  "\\u006cocalStorage;",
  "\\u{65}val('1+1');",
  "\\u0077hile(true){}",
];

describe("静的検査: Unicode エスケープ（M-2）", () => {
  for (const code of IDENTIFIER_ESCAPES) {
    it(`識別子の位置のエスケープを拒否する: ${code}`, async () => {
      const result = await runStaticChecks(code);
      expect(result.allowed).toBe(false);
      expect(result.reasons.join("\n")).toContain("Unicode エスケープ");
    });
  }

  it("文字列・テンプレート・コメント・正規表現リテラル内のエスケープは許可する", async () => {
    const code = [
      'var a = "\\u0065val(1)";',
      "var b = '\\u006cocalStorage';",
      "var c = `\\u0065val ${1}`;",
      "// \\u0065val(1)",
      "/* \\u0046unction('x') */",
      "var re = /[\\u0061-\\u007a]+/g;",
      "var d = 4 / 2; \\u0020\\u0020",
    ].join("\n");
    const result = await runStaticChecks(code);
    // 最後の行だけ識別子の位置のエスケープ（空白のエスケープ）なので拒否される。
    expect(result.allowed).toBe(false);
    expect(result.reasons.join("\n")).toContain("Unicode エスケープ");

    const stringsOnly = [
      'var a = "\\u0065val(1)";',
      "var c = `\\u0065val ${1}`;",
      "// \\u0065val(1)",
      "/* \\u0046unction('x') */",
      "var re = /[\\u0061-\\u007a]+/g;",
    ].join("\n");
    const allowed = await runStaticChecks(stringsOnly);
    expect(allowed.allowed, allowed.reasons.join(" / ")).toBe(true);
  });

  it("公式サンプル（examples/plugins）は引き続き許可される", async () => {
    for (const [name, code] of [
      ["spoiler", spoilerSample],
      ["dice", diceSample],
      ["gallery", gallerySample],
      ["gist-embed", gistSample],
    ] as const) {
      const result = await runStaticChecks(code);
      expect(result.allowed, `${name}: ${result.reasons.join(" / ")}`).toBe(true);
    }
  });

  it("テンプレート生成物の CONFIG 内エスケープ（\\u0028 等）は許可される", async () => {
    const code = [
      "register({",
      "  slots: {",
      '    "thread-bottom": function (ctx) {',
      '      var CONFIG = {"buttonLabel":"\\u0065val(1)","body":"\\u0063ookie"};',
      "      ctx.root.textContent = CONFIG.buttonLabel;",
      "    }",
      "  }",
      "});",
    ].join("\n");
    const result = await runStaticChecks(code);
    expect(result.allowed, result.reasons.join(" / ")).toBe(true);
  });
});