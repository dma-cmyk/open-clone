// テンプレートフォームの状態 ↔ 生成器の入力の橋渡し（純粋関数）。
//
// `validateTemplateParams` / `generateFromTemplate`（shared）をそのまま使い、web 側で
// 検証・生成を再実装しない（報告書 27 §3.0 / 28 §6.2 の単一経路）。
// ここが持つのは「フォーム部品の生の値（文字列・真偽値・配列）」を
// 「生成器が受け取るパラメータ」へ変換する処理と、エラー文言の日本語化だけ。

import {
  TemplateGenerationError,
  generateFromTemplate,
  validateTemplateParams,
  type AuthoringTemplateParameter,
  type PluginManifest,
  type PluginTemplateDefinition,
} from "shared";

/** `<input>` / `<textarea>` の値、checkbox、選択肢の配列。 */
export type FormValue = string | boolean | string[];
export type FormState = Record<string, FormValue>;

export type FieldErrorMap = Record<string, string>;

export function initialFormState(template: PluginTemplateDefinition): FormState {
  const state: FormState = {};
  for (const parameter of template.parameters) {
    const constraints = parameter.constraints ?? {};
    switch (parameter.type) {
      case "boolean": {
        state[parameter.key] = parameter.default === true;
        break;
      }
      case "number": {
        state[parameter.key] =
          parameter.default === undefined || parameter.default === null ? "" : String(parameter.default);
        break;
      }
      case "select": {
        state[parameter.key] = String(parameter.default ?? constraints.options?.[0]?.value ?? "");
        break;
      }
      case "stringList": {
        const defaults = Array.isArray(parameter.default) ? parameter.default.map(String) : [];
        state[parameter.key] =
          constraints.options && constraints.options.length > 0 ? defaults : defaults.join("\n");
        break;
      }
      default: {
        state[parameter.key] =
          parameter.default === undefined || parameter.default === null ? "" : String(parameter.default);
      }
    }
  }
  return state;
}

/**
 * フォームの生の値を生成器の `params` へ変換する。
 * - stringList（チェックボックス）は配列のまま
 * - stringList（テキストエリア）は 1 行 1 件に分解
 * - number が空欄なら `undefined`（生成器が既定値を使う）
 */
export function formStateToParams(
  template: PluginTemplateDefinition,
  state: FormState,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const parameter of template.parameters) {
    const value = state[parameter.key];
    switch (parameter.type) {
      case "boolean": {
        params[parameter.key] = value === true;
        break;
      }
      case "stringList": {
        if (Array.isArray(value)) {
          params[parameter.key] = value;
        } else {
          params[parameter.key] = String(value ?? "").split(/\r?\n/);
        }
        break;
      }
      case "number": {
        const text = typeof value === "string" ? value.trim() : value === undefined ? "" : String(value);
        params[parameter.key] = text === "" ? undefined : Number(text);
        break;
      }
      default: {
        params[parameter.key] = typeof value === "string" ? value : "";
      }
    }
  }
  return params;
}

/** フォームの値を型どおりに整えたもの（生成器の既定値適用後）。 */
export type ValidatedFormValues = Record<string, unknown>;

export interface FormValidation {
  ok: boolean;
  fieldErrors: FieldErrorMap;
  /** 生成器が受け取る値（既定値を埋めた後）。 */
  values: ValidatedFormValues;
  /** フォームの生の値から作った params（未検証）。 */
  params: Record<string, unknown>;
}

function describeNumberRange(parameter: AuthoringTemplateParameter): string {
  const constraints = parameter.constraints ?? {};
  const min = constraints.min;
  const max = constraints.max;
  const integer = constraints.integer === true;
  const range =
    min !== undefined && max !== undefined
      ? `${min}〜${max}`
      : min !== undefined
        ? `${min} 以上`
        : max !== undefined
          ? `${max} 以下`
          : "数値";
  return `${parameter.label} は ${range} の${integer ? "整数" : "数値"}で入力してください`;
}

/**
 * 生成器のフィールドエラーを、報告書 27 §6.2 の文言へ寄せる。
 * 生成器のメッセージ自体が具体的な場合はそれを尊重し、汎用文言のときだけ言い換える。
 */
export function formatFieldMessage(
  template: PluginTemplateDefinition,
  parameter: AuthoringTemplateParameter,
  message: string,
): string {
  if (parameter.key === "name") {
    if (message.includes("形式") || message.includes("必須")) {
      return "名前は英小文字・数字・ハイフンで、3〜41 文字（英小文字で開始）にしてください";
    }
    return message;
  }
  if (parameter.key === "summary" && message.includes("文字以内")) {
    return "概要は 200 文字以内で入力してください";
  }
  if (parameter.type === "number" && (message.includes("以上") || message.includes("以下") || message.includes("整数"))) {
    return describeNumberRange(parameter);
  }
  if (parameter.type === "stringList" && message.includes("1 つ以上")) {
    return parameter.key === "words"
      ? "単語を 1 つ以上入力してください（1 行に 1 語）"
      : `${parameter.label} を 1 つ以上入力してください`;
  }
  if (message.includes(parameter.label)) return message;
  return `${parameter.label}: ${message}`;
}

export function mapFieldErrors(
  template: PluginTemplateDefinition,
  fieldErrors: readonly { key: string; message: string }[],
): FieldErrorMap {
  const errors: FieldErrorMap = {};
  for (const error of fieldErrors) {
    const parameter = template.parameters.find((candidate) => candidate.key === error.key);
    errors[error.key] = parameter
      ? formatFieldMessage(template, parameter, error.message)
      : error.message;
  }
  return errors;
}

/** フォームのライブ検証（shared の `validateTemplateParams` をそのまま使う）。 */
export function validateForm(template: PluginTemplateDefinition, state: FormState): FormValidation {
  const params = formStateToParams(template, state);
  const result = validateTemplateParams(template.id, params);
  if (result.ok) {
    return { ok: true, fieldErrors: {}, values: result.values, params };
  }
  return { ok: false, fieldErrors: mapFieldErrors(template, result.fieldErrors), values: {}, params };
}

export type DraftResult =
  | {
      ok: true;
      templateId: string;
      manifest: PluginManifest;
      code: string;
      values: ValidatedFormValues;
    }
  | { ok: false; fieldErrors: FieldErrorMap };

/**
 * フォームの値から `{ manifest, code }` を生成する（保存・プレビューの共通経路）。
 * 生成器の内部不変条件違反（ReDoS 自己検査・32KB 超）はそのまま throw する。
 */
export function generateDraft(template: PluginTemplateDefinition, state: FormState): DraftResult {
  const validation = validateForm(template, state);
  if (!validation.ok) return { ok: false, fieldErrors: validation.fieldErrors };
  const generated = generateFromTemplate(template.id, validation.params);
  if (!generated.ok) return { ok: false, fieldErrors: mapFieldErrors(template, generated.fieldErrors) };
  return {
    ok: true,
    templateId: generated.templateId,
    manifest: generated.manifest,
    code: generated.code,
    values: validation.values,
  };
}

/** 生成器の例外を利用者向けの文言にする（report27 §6.2）。 */
export function describeGenerationError(error: unknown): string {
  if (error instanceof TemplateGenerationError) {
    if (error.message.includes("正規表現")) {
      return `この入力だと危険な正規表現になるため使えません。単語を減らすか短くしてください（${error.message}）`;
    }
    return `プラグインを作成できませんでした（${error.message}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** チャンク名（保存後に changelog へ付ける作成元）。 */
export function templateChangelog(templateId: string): string {
  return `[template:${templateId}] テンプレートから作成`;
}