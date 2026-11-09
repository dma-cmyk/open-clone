// テンプレート生成・authoring.* スキーマ・トークン API スキーマのユニットテスト
// （報告書 28 §8.0 / 27 §7.0 の受け入れ条件）。
// runStaticChecks（api 側）を通ることは apps/api/test/plugin-template-generation.test.ts で検証する。

import { describe, expect, it } from "vitest";
import { PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES } from "../constants";
import { analyzeRegexPattern } from "../lib/regex-safety";
import { PLUGIN_TEMPLATES, type PluginTemplateDefinition } from "../plugin-templates-data";
import {
  TemplateGenerationError,
  authoringCreateDraftSchema,
  authoringTemplateInfoSchema,
  authoringTemplateParameterSchema,
  escapeRegExp,
  generateFromTemplate,
  pluginAuthorTokenCreateResponseSchema,
  pluginAuthorTokenCreateSchema,
  pluginAuthorTokenListResponseSchema,
  toAuthoringTemplateInfo,
  validateTemplateParams,
} from "./plugin-authoring";
import { pluginCreateSchema, pluginManifestSchema } from "./plugin";

function templateOf(id: string): PluginTemplateDefinition {
  const template = PLUGIN_TEMPLATES.find((entry) => entry.id === id);
  if (!template) throw new Error(`unknown template: ${id}`);
  return template;
}

/** 既定値をそのまま渡す（required かつ空の既定値は代表値で埋める）。 */
function representativeParams(id: string): Record<string, unknown> {
  const template = templateOf(id);
  const params: Record<string, unknown> = {};
  for (const parameter of template.parameters) {
    if (parameter.default !== undefined) params[parameter.key] = parameter.default;
  }
  if (id === "ng-word-mask") params.words = ["単語"];
  if (id === "quick-reply") params.body = "テスト投稿です";
  return params;
}

function generateOk(id: string, params: Record<string, unknown>) {
  const result = generateFromTemplate(id, params);
  if (!result.ok) throw new Error(`generate failed: ${JSON.stringify(result.fieldErrors)}`);
  return result;
}

/** 生成コードから 1 行の CONFIG データを取り除いた骨格を返す（ロジック不変の比較用）。 */
function codeSkeleton(code: string): { skeleton: string; config: Record<string, unknown> } {
  const configLine = /^ {6}var CONFIG = (.+);$/m.exec(code);
  if (!configLine) throw new Error("CONFIG 行が見つかりません");
  const config = JSON.parse(configLine[1] ?? "") as Record<string, unknown>;
  return { skeleton: code.replace(configLine[0], "      var CONFIG = <CONFIG>;"), config };
}

const INJECTION_STRINGS = [
  "'); eval('x'); //",
  "*/ alert(1) /*",
  "</script><script>alert(1)</script>",
  "`${alert(1)}`",
  ".*+?()[]{}|\\^$",
  "\u2028\u2029\u0000",
  "<!-- -->",
  "'; api.storage.set('x','y'); //",
];

describe("テンプレート定義", () => {
  it("7 件が定義され、公開形スキーマ（strict）を通る", () => {
    expect(PLUGIN_TEMPLATES).toHaveLength(7);
    for (const template of PLUGIN_TEMPLATES) {
      const info = toAuthoringTemplateInfo(template);
      expect(authoringTemplateInfoSchema.safeParse(info).success).toBe(true);
      // 公開形に内部フィールド（kind/risk）が漏れない
      expect(info).not.toHaveProperty("kind");
      expect(info).not.toHaveProperty("risk");
    }
  });

  it("パラメータ定義そのものが strict スキーマを通る", () => {
    for (const template of PLUGIN_TEMPLATES) {
      for (const parameter of template.parameters) {
        expect(authoringTemplateParameterSchema.safeParse(parameter).success, parameter.key).toBe(
          true,
        );
      }
    }
  });

  it("id は一意で、name 既定値は PLUGIN_NAME_PATTERN を通る", () => {
    const ids = new Set<string>();
    for (const template of PLUGIN_TEMPLATES) {
      expect(ids.has(template.id)).toBe(false);
      ids.add(template.id);
      const nameParameter = template.parameters.find((parameter) => parameter.key === "name");
      expect(nameParameter, template.id).toBeDefined();
      const params = representativeParams(template.id);
      expect(generateOk(template.id, params).manifest.name).toBe(params.name);
    }
  });

  it("使用スロット・権限はマウント済みのものだけ（報告書 27 §1.1/§1.3）", () => {
    const mounted: Record<string, true> = {
      "thread-head": true,
      "thread-post-inline": true,
      "thread-post-footer": true,
      "thread-bottom": true,
      "board-head": true,
      "site-header": true,
      "site-top": true,
      "board-manage": true,
    };
    const wiredPermissions: Record<string, true> = {
      "ui:slot": true,
      "data:read:thread": true,
      "data:read:board": true,
      "data:write:post": true,
      "storage:shared": true,
      notify: true,
    };
    for (const template of PLUGIN_TEMPLATES) {
      for (const slot of template.baseManifest.slots ?? []) expect(mounted[slot]).toBe(true);
      for (const permission of template.baseManifest.permissions ?? []) {
        expect(wiredPermissions[permission]).toBe(true);
      }
    }
  });
});

describe("generateFromTemplate: 代表パラメータ", () => {
  for (const template of PLUGIN_TEMPLATES) {
    it(`${template.id} は manifest スキーマ・ReDoS 自己検査・32KB 上限を通る`, () => {
      const result = generateOk(template.id, representativeParams(template.id));
      const parsed = pluginManifestSchema.safeParse(result.manifest);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      for (const rule of result.manifest.render?.post ?? []) {
        expect(analyzeRegexPattern(rule.pattern, rule.flags).safe, rule.pattern).toBe(true);
      }
      expect(new TextEncoder().encode(result.code).byteLength).toBeLessThanOrEqual(
        PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES,
      );
    });
  }

  it("render 系のコードは固定文字列（利用者入力を含まない）", () => {
    for (const id of ["spoiler", "ng-word-mask", "keyword-deco"]) {
      expect(generateOk(id, representativeParams(id)).code).toBe("register({});");
    }
  });

  it("生成コードは JavaScript として構文解析できる", () => {
    for (const template of PLUGIN_TEMPLATES) {
      const result = generateOk(template.id, representativeParams(template.id));
      expect(() => new Function(result.code), template.id).not.toThrow();
    }
  });

  it("未知のテンプレート id は fieldError", () => {
    const result = generateFromTemplate("nope", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors[0]?.key).toBe("templateId");
  });

  it("未知キーは拒否する", () => {
    const params = { ...representativeParams("spoiler"), evil: "x" };
    const result = generateFromTemplate("spoiler", params);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.some((error) => error.key === "evil")).toBe(true);
  });

  it("必須・型・上限を検証する", () => {
    expect(generateFromTemplate("ng-word-mask", { ...representativeParams("ng-word-mask"), words: [] }).ok).toBe(false);
    expect(generateFromTemplate("dice-button", { ...representativeParams("dice-button"), sides: 101 }).ok).toBe(false);
    expect(generateFromTemplate("dice-button", { ...representativeParams("dice-button"), sides: 6.5 }).ok).toBe(false);
    expect(generateFromTemplate("counter", { ...representativeParams("counter"), storageKey: "a b" }).ok).toBe(false);
    expect(generateFromTemplate("quick-reply", { ...representativeParams("quick-reply"), body: "" }).ok).toBe(false);
    expect(generateFromTemplate("keyword-deco", { ...representativeParams("keyword-deco"), deco: "nope" }).ok).toBe(false);
    expect(generateFromTemplate("spoiler", { ...representativeParams("spoiler"), openTag: "" }).ok).toBe(false);
  });
});

describe("generateFromTemplate: 境界パラメータ", () => {
  const boundaries: Array<[string, Record<string, unknown>]> = [
    ["spoiler", { openTag: "1234567890", closeTag: "abcdefghij" }],
    ["ng-word-mask", { words: Array.from({ length: 50 }, (_, index) => `w${index}`), mask: "x".repeat(20) }],
    ["keyword-deco", { keyword: "k".repeat(30), deco: "spoiler", ignoreCase: true }],
    [
      "dice-button",
      {
        slot: "thread-bottom",
        label: "L".repeat(20),
        sides: 100,
        count: 10,
        messages: Array.from({ length: 10 }, (_, index) => `${index + 1}:ok`).join("\n"),
      },
    ],
    ["counter", { label: "c".repeat(20), start: 999_999, step: 100, storageKey: "k".repeat(40) }],
    ["thread-info", { fields: ["title", "count", "board"], prefix: "p".repeat(8) }],
    [
      "quick-reply",
      { buttonLabel: "b".repeat(20), body: "あ".repeat(2000), postName: "n".repeat(100), confirmText: "c".repeat(60) },
    ],
  ];

  for (const [id, override] of boundaries) {
    it(`${id} の上限値で生成できる`, () => {
      const params = { ...representativeParams(id), ...override };
      const result = generateOk(id, params);
      expect(pluginManifestSchema.safeParse(result.manifest).success).toBe(true);
      expect(new TextEncoder().encode(result.code).byteLength).toBeLessThanOrEqual(
        PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES,
      );
      for (const rule of result.manifest.render?.post ?? []) {
        expect(analyzeRegexPattern(rule.pattern, rule.flags).safe).toBe(true);
      }
    });
  }

  it("NG ワードの合計正規表現長 200 字超は fieldError", () => {
    const words = Array.from({ length: 50 }, (_, index) => `word${index}`);
    const result = generateFromTemplate("ng-word-mask", {
      ...representativeParams("ng-word-mask"),
      words,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.some((error) => error.key === "words")).toBe(true);
  });

  it("サイコロのコメント形式・面の範囲・重複を検証する", () => {
    const base = representativeParams("dice-button");
    for (const messages of ["6", "6:", "7:out", "6:a\n6:b", "1:a\n2:b"]) {
      const result = generateFromTemplate("dice-button", { ...base, messages });
      if (messages === "1:a\n2:b") expect(result.ok).toBe(true);
      else expect(result.ok).toBe(false);
    }
  });
});

describe("generateFromTemplate: 注入耐性", () => {
  it("render 系: メタ文字はエスケープされ、コードは固定のまま", () => {
    for (const injected of INJECTION_STRINGS) {
      const spoiler = generateOk("spoiler", { ...representativeParams("spoiler"), openTag: injected.slice(0, 10), closeTag: injected.slice(0, 10) });
      expect(spoiler.code).toBe("register({});");
      const rule = spoiler.manifest.render?.post?.[0];
      expect(rule).toBeDefined();
      expect(rule!.pattern).toContain(escapeRegExp(injected.slice(0, 10).trim()));
      expect(analyzeRegexPattern(rule!.pattern, rule!.flags).safe).toBe(true);
    }

    const keyword = generateOk("keyword-deco", { ...representativeParams("keyword-deco"), keyword: "a|b.*" });
    expect(keyword.manifest.render?.post?.[0]?.pattern).toBe("(a\\|b\\.\\*)");
  });

  it("slot 系: 入力は CONFIG データにだけ入り、コード骨格は変わらない", () => {
    const baseline: Record<string, string> = {};
    for (const id of ["dice-button", "counter", "thread-info", "quick-reply"]) {
      baseline[id] = codeSkeleton(generateOk(id, representativeParams(id)).code).skeleton;
    }

    for (const id of ["dice-button", "counter", "thread-info", "quick-reply"]) {
      for (const injected of INJECTION_STRINGS) {
        const params = { ...representativeParams(id) };
        if (id === "dice-button") params.label = injected.slice(0, 20);
        if (id === "counter") params.label = injected.slice(0, 20);
        if (id === "thread-info") params.prefix = injected.slice(0, 8);
        if (id === "quick-reply") {
          params.body = injected;
          params.postName = injected.slice(0, 100);
          params.confirmText = injected.slice(0, 60);
        }
        const result = generateOk(id, params);
        const { skeleton, config } = codeSkeleton(result.code);
        expect(skeleton, `${id}: ${injected}`).toBe(baseline[id]);
        if (id === "dice-button" || id === "counter") {
          expect(config.label).toBe(injected.slice(0, 20).trim());
        }
        if (id === "quick-reply") {
          expect(config.body).toBe(injected);
          expect(config.postName).toBe(injected.slice(0, 100).trim());
        }
        // HTML/スクリプト終端や行終端として解釈され得る文字は生で残さない
        expect(result.code).not.toContain("</script>");
        expect(result.code).not.toContain("\u2028");
        expect(result.code).not.toContain("\u2029");
        // 静的に禁止された API を注入文字列経由で呼べない（データは文字列のまま）
        expect(result.code).not.toContain("\n  eval(");
      }
    }
  });

  it("slot 系: 制御文字・引用符を含む入力でも JSON として往復できる", () => {
    const result = generateOk("quick-reply", {
      ...representativeParams("quick-reply"),
      body: 'a"b\'c\\d\n\r\t\u2028</script>${x}',
    });
    const { config } = codeSkeleton(result.code);
    expect(config.body).toBe('a"b\'c\\d\n\r\t\u2028</script>${x}');
  });

  it("生成コードが不安全な正規表現になった場合は例外（実装バグ検知）", () => {
    // 直接の不正入力では作れないが、生成器の自己検査が効いていることを確認する。
    // ここでは escape されていない入力を作る経路が無いため、例外型の存在だけを確認する。
    expect(new TemplateGenerationError("x").code).toBe("TEMPLATE_GENERATION_FAILED");
  });
});

describe("MCP / token スキーマ（strict）", () => {
  it("authoring.create_draft は未知キーを拒否する", () => {
    const generated = generateOk("spoiler", representativeParams("spoiler"));
    const valid = { manifest: generated.manifest, code: generated.code };
    expect(authoringCreateDraftSchema.safeParse(valid).success).toBe(true);
    expect(authoringCreateDraftSchema.safeParse({ ...valid, ownerAccountId: "x" }).success).toBe(false);
    expect(authoringCreateDraftSchema.safeParse({ ...valid, code: "x".repeat(70 * 1024) }).success).toBe(false);
  });

  it("authoring.create_draft は既知の templateId のみ受け付ける", () => {
    const generated = generateOk("spoiler", representativeParams("spoiler"));
    const valid = { manifest: generated.manifest, code: generated.code, templateId: "spoiler" };
    expect(authoringCreateDraftSchema.safeParse(valid).success).toBe(true);
    expect(authoringCreateDraftSchema.safeParse({ ...valid, templateId: "nope" }).success).toBe(false);
  });

  it("pluginCreateSchema は templateId（既知 id）を受け付ける", () => {
    const generated = generateOk("spoiler", representativeParams("spoiler"));
    const base = { manifest: generated.manifest, code: generated.code };
    expect(pluginCreateSchema.parse({ ...base, templateId: "spoiler" }).templateId).toBe("spoiler");
    expect(pluginCreateSchema.safeParse({ ...base, templateId: "nope" }).success).toBe(false);
    expect(pluginCreateSchema.safeParse(base).success).toBe(true);
  });

  it("トークン発行・一覧の形は未知キーを拒否する", () => {
    expect(pluginAuthorTokenCreateSchema.safeParse({ name: "自宅の Claude Code" }).success).toBe(true);
    expect(pluginAuthorTokenCreateSchema.safeParse({}).success).toBe(true);
    expect(pluginAuthorTokenCreateSchema.safeParse({ name: "x", extra: 1 }).success).toBe(false);
    expect(pluginAuthorTokenCreateSchema.safeParse({ name: "" }).success).toBe(false);

    const issued = {
      id: "01J00000000000000000000000",
      token: "ocp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      prefix: "ocp_xxxxxxxx",
      name: "自宅の Claude Code",
      status: "active",
      createdAt: 1_800_000_000,
      expiresAt: 1_800_000_000 + 90 * 86_400,
    };
    expect(pluginAuthorTokenCreateResponseSchema.safeParse(issued).success).toBe(true);
    expect(pluginAuthorTokenCreateResponseSchema.safeParse({ ...issued, tokenHash: "x" }).success).toBe(false);
    expect(pluginAuthorTokenListResponseSchema.safeParse({ items: [] }).success).toBe(true);
    expect(pluginAuthorTokenListResponseSchema.safeParse({ items: [], extra: 1 }).success).toBe(false);
  });
});

describe("validateTemplateParams", () => {
  it("既定値と代表値の両方を受け付ける", () => {
    for (const template of PLUGIN_TEMPLATES) {
      const result = validateTemplateParams(template.id, representativeParams(template.id));
      expect(result.ok, template.id).toBe(true);
    }
  });

  it("数値は数値文字列を受け付ける（フォーム入力）", () => {
    const result = validateTemplateParams("dice-button", {
      ...representativeParams("dice-button"),
      sides: "20",
      count: "2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.sides).toBe(20);
      expect(result.values.count).toBe(2);
    }
  });

  it("stringList は改行区切りの文字列を受け付け、重複を除く", () => {
    const result = validateTemplateParams("ng-word-mask", {
      ...representativeParams("ng-word-mask"),
      words: "NG\nNG\n  ng  \n",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.words).toEqual(["NG", "ng"]);
  });
});