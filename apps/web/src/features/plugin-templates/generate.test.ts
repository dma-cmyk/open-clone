// テンプレートフォーム ↔ 生成器の結合テスト（報告書 28 §8.2 / 27 §8）。
// フォームの生の値（テキストエリア・チェックボックス・数値入力）から
// `generateFromTemplate` までの経路を、7 テンプレートすべてで検証する。

import { describe, expect, it } from "vitest";
import {
  PLUGIN_TEMPLATES,
  analyzeRegexPattern,
  pluginManifestSchema,
  type PluginTemplateDefinition,
} from "shared";
import {
  formStateToParams,
  generateDraft,
  initialFormState,
  mapFieldErrors,
  templateChangelog,
  validateForm,
  type FormState,
} from "./form-model";
import { parseTemplateOrigin, templateKindLabel } from "./registry";
import { buildRenderSamples } from "./samples";

function templateOf(id: string): PluginTemplateDefinition {
  const found = PLUGIN_TEMPLATES.find((template) => template.id === id);
  if (!found) throw new Error(`テンプレート ${id} が見つかりません`);
  return found;
}

/** 必須項目が既定値で空のテンプレートに、利用者が入力する値を補う。 */
function fillRequired(template: PluginTemplateDefinition): FormState {
  const state = initialFormState(template);
  for (const parameter of template.parameters) {
    if (parameter.type === "stringList" && parameter.required) state[parameter.key] = "秘密\n伏せ字";
    if (parameter.type === "text" && parameter.required) state[parameter.key] = "了解です。よろしくお願いします。";
  }
  return state;
}

function codeBytes(code: string): number {
  return new TextEncoder().encode(code).byteLength;
}

describe("テンプレートフォームの結合（7 テンプレート）", () => {
  it.each(PLUGIN_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s はフォーム入力だけで保存可能な manifest/code を生成する",
    (_id, template) => {
      const validation = validateForm(template, fillRequired(template));
      expect(validation.fieldErrors).toEqual({});
      expect(validation.ok).toBe(true);

      const draft = generateDraft(template, fillRequired(template));
      if (!draft.ok) throw new Error(JSON.stringify(draft.fieldErrors));
      expect(draft.templateId).toBe(template.id);
      expect(() => pluginManifestSchema.parse(draft.manifest)).not.toThrow();
      expect(codeBytes(draft.code)).toBeLessThanOrEqual(32 * 1024);

      for (const rule of draft.manifest.render?.post ?? []) {
        expect(analyzeRegexPattern(rule.pattern, rule.flags ?? "").safe).toBe(true);
      }

      if (template.kind === "render") {
        expect(draft.code.trim()).toBe("register({});");
        expect(draft.manifest.render?.post?.length).toBeGreaterThan(0);
      } else {
        expect(draft.manifest.slots.length).toBeGreaterThan(0);
        expect(draft.code).toContain("register({");
      }
    },
  );

  it("必須項目が空の既定値では 2 テンプレートだけ検証に失敗する（フォームが入力を促す）", () => {
    const invalid = PLUGIN_TEMPLATES.filter(
      (template) => !validateForm(template, initialFormState(template)).ok,
    ).map((template) => template.id);
    expect(invalid.sort()).toEqual(["ng-word-mask", "quick-reply"]);
  });

  it("テキストエリアの複数行・数値文字列・チェックボックスを生成器の型へ変換する", () => {
    const template = templateOf("ng-word-mask");
    const state = initialFormState(template);
    state.words = "  秘密  \n\n 伏せ字\n秘密\n";
    state.ignoreCase = false;

    const params = formStateToParams(template, state);
    expect(params.words).toEqual(["  秘密  ", "", " 伏せ字", "秘密", ""]);

    const validation = validateForm(template, state);
    expect(validation.ok).toBe(true);
    expect(validation.values.words).toEqual(["秘密", "伏せ字"]);

    const dice = templateOf("dice-button");
    const diceState = initialFormState(dice);
    diceState.sides = "20";
    diceState.count = "3";
    const diceParams = formStateToParams(dice, diceState);
    expect(diceParams.sides).toBe(20);
    const diceValidation = validateForm(dice, diceState);
    expect(diceValidation.ok).toBe(true);
    expect(diceValidation.values.sides).toBe(20);
    expect(diceValidation.values.count).toBe(3);
  });

  it("数値の空欄は既定値を使う（未入力を 0 にしない）", () => {
    const template = templateOf("dice-button");
    const state = initialFormState(template);
    state.sides = "";
    const params = formStateToParams(template, state);
    expect(params.sides).toBeUndefined();
    expect(validateForm(template, state).ok).toBe(true);
  });
});

describe("フォームのエラー文言（報告書 27 §6.2）", () => {
  it("プラグイン名の形式違反は専用の文言にする", () => {
    const template = templateOf("spoiler");
    const state = initialFormState(template);
    state.name = "Bad Name!";
    expect(validateForm(template, state).fieldErrors.name).toBe(
      "名前は英小文字・数字・ハイフンで、3〜41 文字（英小文字で開始）にしてください",
    );
  });

  it("数値の範囲外はラベルと範囲を示す", () => {
    const template = templateOf("dice-button");
    const state = initialFormState(template);
    state.sides = "1";
    expect(validateForm(template, state).fieldErrors.sides).toBe(
      "面の数 は 2〜100 の整数で入力してください",
    );
  });

  it("単語が空なら 1 行 1 語で入力を促す", () => {
    const template = templateOf("ng-word-mask");
    const state = initialFormState(template);
    state.words = "";
    expect(validateForm(template, state).fieldErrors.words).toBe(
      "単語を 1 つ以上入力してください（1 行に 1 語）",
    );
  });

  it("単語が多すぎる（正規表現 200 字超）ときは数を減らすよう促す", () => {
    const template = templateOf("ng-word-mask");
    const state = initialFormState(template);
    state.words = Array.from({ length: 50 }, (_, index) => `word-${index}-${"x".repeat(3)}`).join("\n");
    const errors = validateForm(template, state).fieldErrors;
    expect(errors.words).toContain("単語が多すぎます");
  });

  it("サイコロのコメント形式の誤りはフィールドに出す", () => {
    const template = templateOf("dice-button");
    const state = initialFormState(template);
    state.messages = "大当たり";
    expect(validateForm(template, state).fieldErrors.messages).toContain("「面:文言」");
  });

  it("mapFieldErrors は未知キーをそのまま通す", () => {
    const template = templateOf("spoiler");
    expect(mapFieldErrors(template, [{ key: "templateId", message: "不明なテンプレートです" }])).toEqual({
      templateId: "不明なテンプレートです",
    });
  });
});

describe("生成物の注入耐性（入力はデータとしてのみ入る）", () => {
  const injections = ["'); eval('", "</script>", "$(alert)", "`+process+`", "a.*b+"];

  it.each(injections)("slot 系でも %s をコードに連結しない", (payload) => {
    const template = templateOf("quick-reply");
    const state = initialFormState(template);
    state.body = `本文 ${payload}`;
    state.buttonLabel = "📝 定型レス";
    const draft = generateDraft(template, state);
    if (!draft.ok) throw new Error(JSON.stringify(draft.fieldErrors));
    expect(draft.code).not.toContain("eval(");
    expect(draft.code).not.toContain("</script>");
    expect(JSON.parse(draft.code.match(/var CONFIG = (\{.*\});/)?.[1] ?? "{}").body).toBe(`本文 ${payload}`);
  });

  it.each(injections)("render 系はタグを正規表現メタ文字としてエスケープする: %s", (payload) => {
    const template = templateOf("spoiler");
    const state = initialFormState(template);
    state.openTag = payload.slice(0, 10);
    state.closeTag = "[/sp]";
    const validation = validateForm(template, state);
    if (!validation.ok) return; // 長さ制約で拒否される入力は生成しない
    const draft = generateDraft(template, state);
    if (!draft.ok) throw new Error(JSON.stringify(draft.fieldErrors));
    for (const rule of draft.manifest.render?.post ?? []) {
      expect(analyzeRegexPattern(rule.pattern, rule.flags ?? "").safe).toBe(true);
    }
  });
});

describe("サンプルと表示用の派生", () => {
  it("render 系は該当・非該当・長文の 3 種を返し、長文は上限を超える", () => {
    for (const id of ["spoiler", "ng-word-mask", "keyword-deco"]) {
      const template = templateOf(id);
      const validation = validateForm(template, fillRequired(template));
      const samples = buildRenderSamples(id, validation.values);
      expect(samples.map((sample) => sample.key)).toEqual(["hit", "miss", "long"]);
      const long = samples.find((sample) => sample.key === "long");
      expect(long?.body.length).toBeGreaterThan(2_048);
      expect(long?.note).toContain("2,048");
    }
  });

  it("slot 系はサンプルを持たない", () => {
    for (const id of ["dice-button", "counter", "thread-info", "quick-reply"]) {
      expect(buildRenderSamples(id, {})).toEqual([]);
    }
  });

  it("changelog の [template:<id>] から作成元を解析できる", () => {
    const changelog = templateChangelog("spoiler");
    expect(parseTemplateOrigin(changelog)?.label).toBe("ネタバレ伏せ");
    expect(parseTemplateOrigin(changelog)?.templateId).toBe("spoiler");
    expect(parseTemplateOrigin("initial version")).toBeNull();
    expect(templateKindLabel(templateOf("spoiler"))).toBe("レスの表示ルール");
  });
});