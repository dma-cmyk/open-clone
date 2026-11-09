// AI プラグイン作成の契約（テンプレート生成 + 作成用 MCP ツール + トークン管理 REST）。
// 正本: 報告書 28 §4.3/§4.6 と 27 §3.0/§3。web（① テンプレートフォーム）と
// api（② /mcp-plugin・/v1/me/plugin-tokens）は必ずこのファイルの型・スキーマ・定数を使う。
//
// 安全原則（報告書 27 §3.0 / 28 §5.4）:
// - 利用者入力は manifest（純 JSON）か、`JSON.stringify` した 1 行の CONFIG データとしてのみ埋め込む。
// - render 系のコードは固定の `register({});`。正規表現は入力を escapeRegExp してから組み立て、
//   生成後に analyzeRegexPattern で自己検査する（不合格は実装バグとして例外）。
// - 未知キーは strict schema で拒否する（fail-closed）。

import { z } from "zod";
import {
  PLUGIN_AUTHOR_CODE_MAX_BYTES,
  PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES,
  PLUGIN_TOKEN_NAME_MAX_CHARS,
} from "../constants";
import { REGEX_PATTERN_MAX_LENGTH, analyzeRegexPattern } from "../lib/regex-safety";
import {
  PLUGIN_HOOKS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_PERMISSIONS,
  PLUGIN_SCOPES,
  PLUGIN_SLOTS,
  PLUGIN_STATUSES,
  PLUGIN_VISIBILITIES,
  pluginManifestSchema,
  semverSchema,
  type PluginManifest,
  type PluginPostRenderRule,
  type PluginSlotName,
} from "./plugin";
import {
  PLUGIN_TEMPLATE_IDS,
  findPluginTemplate,
  type PluginTemplateDefinition,
  type PluginTemplateId,
} from "../plugin-templates-data";

// ─── テンプレート定義（公開形） ─────────────────────────────────────

export const authoringTemplateParameterTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "boolean",
  "select",
  "stringList",
]);
export type AuthoringTemplateParameterType = z.infer<typeof authoringTemplateParameterTypeSchema>;

/** `constraints` の語彙（報告書 27 §3.0）。フォーム・生成器・検証が共通で使う。 */
export const authoringTemplateParameterConstraintsSchema = z.strictObject({
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  integer: z.boolean().optional(),
  options: z
    .array(z.strictObject({ value: z.string().min(1).max(100), label: z.string().min(1).max(100) }))
    .max(50)
    .optional(),
  maxItems: z.number().int().min(0).optional(),
  itemMaxLength: z.number().int().min(0).optional(),
  placeholder: z.string().max(200).optional(),
  /** name などの形式（正規表現ソース）。生成器が RegExp として評価する。 */
  slugPattern: z.string().max(200).optional(),
  /** 汎用の形式制約（例: storageKey の `^[A-Za-z0-9_-]+$`）。 */
  pattern: z.string().max(200).optional(),
});
export type AuthoringTemplateParameterConstraints = z.infer<
  typeof authoringTemplateParameterConstraintsSchema
>;

export const authoringTemplateParameterSchema = z.strictObject({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  type: authoringTemplateParameterTypeSchema,
  required: z.boolean(),
  default: z.unknown().optional(),
  constraints: authoringTemplateParameterConstraintsSchema.optional(),
});
export type AuthoringTemplateParameter = z.infer<typeof authoringTemplateParameterSchema>;

/**
 * template の既定 manifest。`pluginManifestSchema` の部分形だが、同スキーマは
 * superRefine を持つため `.partial()` すると未指定フィールドで refine が落ちる。
 * そのため既定 manifest 用に独立した strict 部分スキーマを使う。
 */
export const authoringBaseManifestSchema = z.strictObject({
  version: semverSchema.optional(),
  summary: z.string().max(200).optional(),
  description: z.string().max(20_000).optional(),
  scope: z.array(z.enum(PLUGIN_SCOPES)).min(1).max(3).optional(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).optional(),
  slots: z.array(z.enum(PLUGIN_SLOTS)).max(8).optional(),
  hooks: z.array(z.enum(PLUGIN_HOOKS)).max(4).optional(),
  entry: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,100}$/)
    .optional(),
  author: z.string().max(60).optional(),
  license: z.string().max(30).optional(),
  homepage: z.string().max(300).optional(),
});
export type AuthoringBaseManifest = z.infer<typeof authoringBaseManifestSchema>;

/** `authoring.list_templates` の 1 件（報告書 28 §4.3）。 */
export const authoringTemplateInfoSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  parameters: z.array(authoringTemplateParameterSchema).min(1).max(20),
  baseManifest: authoringBaseManifestSchema,
});
export type AuthoringTemplateInfo = z.infer<typeof authoringTemplateInfoSchema>;

/** 内部定義 → 公開形（strict スキーマに通る形）へ射影する。 */
export function toAuthoringTemplateInfo(template: PluginTemplateDefinition): AuthoringTemplateInfo {
  return authoringTemplateInfoSchema.parse({
    id: template.id,
    label: template.label,
    description: template.description,
    parameters: template.parameters,
    baseManifest: template.baseManifest,
  });
}

// ─── テンプレート生成（純粋関数） ──────────────────────────────────

export interface TemplateFieldError {
  key: string;
  message: string;
}

export type TemplateValidationResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; fieldErrors: TemplateFieldError[] };

export type TemplateGenerateResult =
  | { ok: true; templateId: PluginTemplateId; manifest: PluginManifest; code: string }
  | { ok: false; fieldErrors: TemplateFieldError[] };

/** 生成器の内部不変条件が破れたとき（利用者入力のエラーではない）。 */
export class TemplateGenerationError extends Error {
  readonly code = "TEMPLATE_GENERATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "TemplateGenerationError";
  }
}

/** 正規表現メタ文字をエスケープする（利用者に正規表現を書かせないための共通関数）。 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParameterValidationOk {
  ok: true;
  value: unknown;
}
interface ParameterValidationError {
  ok: false;
  message: string;
}
type ParameterValidation = ParameterValidationOk | ParameterValidationError;

function fail(message: string): ParameterValidationError {
  return { ok: false, message };
}

function validateParameter(
  parameter: AuthoringTemplateParameter,
  raw: unknown,
): ParameterValidation {
  const constraints = parameter.constraints ?? {};
  const hasValue = raw !== undefined && raw !== null;

  if (!hasValue) {
    if (parameter.default !== undefined) return { ok: true, value: Array.isArray(parameter.default) ? [...parameter.default] : parameter.default };
    if (parameter.required) return fail("必須項目です");
    return { ok: true, value: undefined };
  }

  switch (parameter.type) {
    case "string":
    case "text": {
      if (typeof raw !== "string") return fail("文字列で入力してください");
      // 本文（quick-reply）は前後の空白を保持する。それ以外は前後を除去する。
      const value = parameter.key === "body" ? raw : raw.trim();
      const length = value.length;
      if (parameter.required && length === 0) return fail("必須項目です");
      if (constraints.minLength !== undefined && length < constraints.minLength) {
        return fail(`${constraints.minLength} 文字以上で入力してください`);
      }
      if (constraints.maxLength !== undefined && length > constraints.maxLength) {
        return fail(`${constraints.maxLength} 文字以内で入力してください`);
      }
      const pattern = constraints.slugPattern ?? constraints.pattern;
      if (pattern !== undefined && length > 0 && !new RegExp(pattern).test(value)) {
        return fail("形式が正しくありません");
      }
      return { ok: true, value };
    }

    case "number": {
      let value: number;
      if (typeof raw === "number") {
        value = raw;
      } else if (typeof raw === "string" && raw.trim() !== "") {
        value = Number(raw);
      } else {
        return fail("数値で入力してください");
      }
      if (!Number.isFinite(value)) return fail("数値で入力してください");
      if (constraints.integer === true && !Number.isInteger(value)) {
        return fail("整数で入力してください");
      }
      if (constraints.min !== undefined && value < constraints.min) {
        return fail(`${constraints.min} 以上の値を入力してください`);
      }
      if (constraints.max !== undefined && value > constraints.max) {
        return fail(`${constraints.max} 以下の値を入力してください`);
      }
      return { ok: true, value };
    }

    case "boolean": {
      if (typeof raw !== "boolean") return fail("true / false で指定してください");
      return { ok: true, value: raw };
    }

    case "select": {
      const options = constraints.options ?? [];
      if (typeof raw !== "string" || !options.some((option) => option.value === raw)) {
        return fail("選択肢が不正です");
      }
      return { ok: true, value: raw };
    }

    case "stringList": {
      let items: string[];
      if (Array.isArray(raw)) {
        if (!raw.every((item): item is string => typeof item === "string")) {
          return fail("文字列の一覧で指定してください");
        }
        items = raw;
      } else if (typeof raw === "string") {
        items = raw.split(/\r?\n/);
      } else {
        return fail("文字列の一覧で指定してください");
      }
      items = items.map((item) => item.trim()).filter((item) => item.length > 0);
      // 重複は入力順を保って除去する（単語リストの重複は意味を持たない）。
      items = [...new Set(items)];
      if (parameter.required && items.length === 0) return fail("1 つ以上入力してください");
      if (constraints.maxItems !== undefined && items.length > constraints.maxItems) {
        return fail(`${constraints.maxItems} 件以内で入力してください`);
      }
      if (
        constraints.itemMaxLength !== undefined &&
        items.some((item) => item.length > constraints.itemMaxLength!)
      ) {
        return fail(`各項目は ${constraints.itemMaxLength} 文字以内で入力してください`);
      }
      if (constraints.options !== undefined && constraints.options.length > 0) {
        const allowed = new Set(constraints.options.map((option) => option.value));
        if (items.some((item) => !allowed.has(item))) return fail("選択肢が不正です");
      }
      return { ok: true, value: items };
    }

    default: {
      return fail("不明な入力種別です");
    }
  }
}

function parseDiceMessages(
  text: string,
  sides: number,
): { ok: true; messages: Record<string, string> } | { ok: false; message: string } {
  const messages: Record<string, string> = {};
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > 10) return { ok: false, message: "コメントは 10 行以内にしてください" };
  for (const line of lines) {
    if (line.length > 40) return { ok: false, message: "各行は 40 文字以内にしてください" };
    const matched = /^(\d{1,3})\s*[:：]\s*(.+)$/.exec(line);
    if (!matched) {
      return { ok: false, message: "「面:文言」の形式で入力してください（例 6:大当たり）" };
    }
    const face = Number(matched[1]);
    if (face < 1 || face > sides) {
      return { ok: false, message: `面は 1〜${sides} で指定してください` };
    }
    const key = String(face);
    if (messages[key] !== undefined) {
      return { ok: false, message: `面 ${face} が重複しています` };
    }
    messages[key] = (matched[2] ?? "").trim();
  }
  return { ok: true, messages };
}

/** 生成後にしか分からない制約（正規表現長・コメント形式）を検証する。 */
function postValidate(template: PluginTemplateDefinition, values: Record<string, unknown>): TemplateFieldError[] {
  if (template.id === "ng-word-mask") {
    const words = values.words as string[];
    const pattern = `(?:${words.map(escapeRegExp).join("|")})`;
    if (pattern.length > REGEX_PATTERN_MAX_LENGTH) {
      return [
        {
          key: "words",
          message: `単語が多すぎます（合計 ${REGEX_PATTERN_MAX_LENGTH} 文字まで）。数を減らしてください`,
        },
      ];
    }
  }
  if (template.id === "dice-button") {
    const parsed = parseDiceMessages(String(values.messages ?? ""), Number(values.sides));
    if (!parsed.ok) return [{ key: "messages", message: parsed.message }];
  }
  return [];
}

/**
 * テンプレート入力を検証して既定値を埋める（フォームのライブ検証と生成の共通経路）。
 * 未知キーはエラーにする（fail-closed）。
 */
export function validateTemplateParams(
  templateId: string,
  params: unknown,
): TemplateValidationResult {
  const template = findPluginTemplate(templateId);
  if (!template) {
    return { ok: false, fieldErrors: [{ key: "templateId", message: "不明なテンプレートです" }] };
  }
  if (params !== undefined && !isPlainObject(params)) {
    return { ok: false, fieldErrors: [{ key: "params", message: "入力が不正です" }] };
  }
  const input = (params ?? {}) as Record<string, unknown>;
  const known = new Set(template.parameters.map((parameter) => parameter.key));
  const fieldErrors: TemplateFieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!known.has(key)) fieldErrors.push({ key, message: "不明な項目です" });
  }

  const values: Record<string, unknown> = {};
  for (const parameter of template.parameters) {
    const result = validateParameter(parameter, input[parameter.key]);
    if (!result.ok) {
      fieldErrors.push({ key: parameter.key, message: result.message });
      continue;
    }
    if (result.value !== undefined) values[parameter.key] = result.value;
  }

  if (fieldErrors.length === 0) fieldErrors.push(...postValidate(template, values));
  if (fieldErrors.length > 0) return { ok: false, fieldErrors };
  return { ok: true, values };
}

/**
 * 既存の静的検査（api `runStaticChecks`）はコードをテキストとして走査するため、
 * JSON 文字列リテラルの中のデータ（例: ラベルに `eval(` を含む）でも「禁止」と判定する。
 * 生成器はデータを失わずに、危険語の先頭文字・`(` を JSON の `\uXXXX` エスケープへ置き換える。
 * JSON.parse すると元の文字列に戻る（＝ロジックには影響しない）。
 */
const STATIC_CHECK_WORDS = [
  "eval",
  "Function",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "document",
  "opener",
  "location",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "alert",
  "fetch",
  "while",
  "for",
  "import",
] as const;

function neutralizeStaticCheckTokens(json: string): string {
  let result = json.replace(/\(/g, "\\u0028");
  for (const word of STATIC_CHECK_WORDS) {
    const escaped = `\\u${word.charCodeAt(0).toString(16).padStart(4, "0")}${word.slice(1)}`;
    result = result.replace(new RegExp(`\\b${word}\\b`, "g"), escaped);
  }
  return result;
}

/** JSON を 1 行のデータリテラルとして安全に埋め込む。 */
function jsonLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TemplateGenerationError("CONFIG データを JSON 化できません");
  return neutralizeStaticCheckTokens(
    json
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029"),
  );
}

function renderRule(
  pattern: string,
  flags: string,
  template: string,
  kind: PluginPostRenderRule["kind"],
): PluginPostRenderRule {
  const safety = analyzeRegexPattern(pattern, flags);
  if (!safety.safe) {
    throw new TemplateGenerationError(
      `生成した正規表現が安全ではありません: ${safety.reason ?? "unknown"}`,
    );
  }
  return { pattern, flags, template, kind };
}

const RENDER_CODE = "register({});";

function buildRenderTemplate(
  template: PluginTemplateDefinition,
  values: Record<string, unknown>,
): { manifest: PluginManifest; code: string } {
  let rules: PluginPostRenderRule[];
  switch (template.id) {
    case "spoiler": {
      const openTag = values.openTag as string;
      const closeTag = values.closeTag as string;
      rules = [
        renderRule(
          `${escapeRegExp(openTag)}([\\s\\S]*?)${escapeRegExp(closeTag)}`,
          "g",
          "$1",
          "spoiler",
        ),
      ];
      break;
    }
    case "ng-word-mask": {
      const words = values.words as string[];
      const mask = values.mask as string;
      const ignoreCase = values.ignoreCase === true;
      const pattern = `(?:${words.map(escapeRegExp).join("|")})`;
      if (pattern.length > REGEX_PATTERN_MAX_LENGTH) {
        throw new TemplateGenerationError("単語の合計長が上限を超えています");
      }
      rules = [renderRule(pattern, ignoreCase ? "gi" : "g", mask, "text")];
      break;
    }
    case "keyword-deco": {
      const keyword = values.keyword as string;
      const deco = values.deco as PluginPostRenderRule["kind"];
      const ignoreCase = values.ignoreCase === true;
      rules = [renderRule(`(${escapeRegExp(keyword)})`, ignoreCase ? "gi" : "g", "$1", deco)];
      break;
    }
    default:
      throw new TemplateGenerationError(`render 系でないテンプレートです: ${template.id}`);
  }

  const manifest = pluginManifestSchema.parse({
    name: values.name,
    version: template.baseManifest.version ?? "1.0.0",
    summary: values.summary,
    description: template.description,
    scope: template.baseManifest.scope ?? [...PLUGIN_SCOPES],
    permissions: [],
    slots: [],
    render: { post: rules },
  });
  return { manifest, code: RENDER_CODE };
}

function slotPermissions(
  template: PluginTemplateDefinition,
  values: Record<string, unknown>,
): string[] {
  const permissions = new Set<string>(template.baseManifest.permissions ?? []);
  if (template.id === "thread-info") {
    const fields = (values.fields as string[] | undefined) ?? [];
    if (fields.includes("board")) permissions.add("data:read:board");
  }
  return [...permissions];
}

function slotNames(
  template: PluginTemplateDefinition,
  values: Record<string, unknown>,
): PluginSlotName[] {
  if (template.id === "dice-button") return [values.slot as PluginSlotName];
  return [...(template.baseManifest.slots ?? [])];
}

/** サイコロ: 乱数は crypto.getRandomValues（公式サンプルと同方式）。 */
function diceCode(slot: string, config: unknown): string {
  return `register({
  slots: {
    "${slot}": function (ctx) {
      var CONFIG = ${jsonLiteral(config)};
      var api = ctx.api;
      var root = ctx.root;
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = CONFIG.label;
      btn.style.cssText = 'font-size:12px;padding:1px 8px;cursor:pointer;';
      var out = document.createElement('span');
      btn.addEventListener('click', function () {
        var buf = new Uint32Array(CONFIG.count);
        crypto.getRandomValues(buf);
        var total = 0;
        for (var i = 0; i < buf.length; i++) total += (buf[i] % CONFIG.sides) + 1;
        out.textContent = '→ ' + total + (CONFIG.messages[total] || '');
        api.ui.resize(Math.max(document.documentElement.scrollHeight, 1));
      });
      wrap.appendChild(btn);
      wrap.appendChild(out);
      root.appendChild(wrap);
    }
  }
});
`;
}

/** カウンタ: storage:shared に現在値を保存する。 */
function counterCode(config: unknown): string {
  return `register({
  slots: {
    "thread-head": function (ctx) {
      var CONFIG = ${jsonLiteral(config)};
      var api = ctx.api;
      var root = ctx.root;
      var box = document.createElement('div');
      box.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px;padding:2px 0;';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = CONFIG.label;
      btn.style.cssText = 'font-size:12px;padding:1px 8px;cursor:pointer;';
      var num = document.createElement('span');
      function paint(v) { num.textContent = ' ' + v; }
      api.storage.get(CONFIG.storageKey).then(function (v) {
        paint(v == null ? CONFIG.start : Number(v));
      }).catch(function () { paint(CONFIG.start); });
      btn.addEventListener('click', function () {
        api.storage.get(CONFIG.storageKey).then(function (v) {
          var cur = (v == null ? CONFIG.start : Number(v)) + CONFIG.step;
          return api.storage.set(CONFIG.storageKey, String(cur)).then(function () { paint(cur); });
        }).catch(function () {});
        api.ui.resize(Math.max(document.documentElement.scrollHeight, 1));
      });
      box.appendChild(btn);
      box.appendChild(num);
      root.appendChild(box);
    }
  }
});
`;
}

/** スレ情報: 読み取り専用。表示項目は CONFIG.fields のデータで決まる。 */
function threadInfoCode(config: unknown): string {
  return `register({
  slots: {
    "thread-head": function (ctx) {
      var CONFIG = ${jsonLiteral(config)};
      var api = ctx.api;
      var root = ctx.root;
      var box = document.createElement('div');
      box.style.cssText = 'font-size:12px;color:#555;padding:2px 0;';
      var threadId = (ctx.data && ctx.data.threadId) || (api.context && api.context.threadId) || undefined;
      var parts = [];
      function render(thread, board) {
        if (CONFIG.fields.indexOf('title') >= 0 && thread && thread.title) parts.push(thread.title);
        if (CONFIG.fields.indexOf('count') >= 0 && thread && typeof thread.postCount === 'number') parts.push('レス ' + thread.postCount);
        if (CONFIG.fields.indexOf('board') >= 0 && board && board.name) parts.push(board.name);
        box.textContent = parts.length ? CONFIG.prefix + ' ' + parts.join(' / ') : '';
        api.ui.resize(Math.max(document.documentElement.scrollHeight, 1));
      }
      var threadPromise = api.data.thread(threadId);
      var boardPromise = CONFIG.fields.indexOf('board') >= 0 ? api.data.board({}) : Promise.resolve(null);
      Promise.all([threadPromise, boardPromise]).then(function (values) {
        render(values[0], values[1]);
      }).catch(function () { box.textContent = ''; });
      root.appendChild(box);
    }
  }
});
`;
}

/** 定型レス: iframe 内の二段階確認（window.confirm は使わない）。 */
function quickReplyCode(config: unknown): string {
  return `register({
  slots: {
    "thread-bottom": function (ctx) {
      var CONFIG = ${jsonLiteral(config)};
      var api = ctx.api;
      var root = ctx.root;
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;padding:2px 0;';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = CONFIG.buttonLabel;
      btn.style.cssText = 'font-size:12px;padding:1px 8px;cursor:pointer;';
      var state = document.createElement('span');
      var confirmBox = document.createElement('span');
      confirmBox.style.cssText = 'display:none;gap:6px;align-items:center;';
      var yes = document.createElement('button');
      yes.type = 'button';
      yes.textContent = 'する';
      var no = document.createElement('button');
      no.type = 'button';
      no.textContent = 'やめる';
      function reset() {
        confirmBox.style.display = 'none';
        state.textContent = '';
      }
      btn.addEventListener('click', function () {
        state.textContent = ' ' + CONFIG.confirmText;
        confirmBox.style.display = 'inline-flex';
        api.ui.resize(Math.max(document.documentElement.scrollHeight, 1));
      });
      no.addEventListener('click', reset);
      yes.addEventListener('click', function () {
        yes.disabled = true;
        var draft = { body: CONFIG.body };
        if (CONFIG.postName) draft.name = CONFIG.postName;
        api.data.createPost(draft).then(function (post) {
          yes.disabled = false;
          reset();
          state.textContent = ' 投稿しました（レス ' + (post && post.num ? post.num : '?') + '）';
          api.notify.show('投稿しました', { level: 'success' });
        }).catch(function (error) {
          yes.disabled = false;
          state.textContent = ' 投稿に失敗しました: ' + ((error && error.message) || error);
          api.notify.show('投稿に失敗しました', { level: 'error' });
        });
      });
      confirmBox.appendChild(yes);
      confirmBox.appendChild(no);
      wrap.appendChild(btn);
      wrap.appendChild(state);
      wrap.appendChild(confirmBox);
      root.appendChild(wrap);
    }
  }
});
`;
}

function buildSlotTemplate(
  template: PluginTemplateDefinition,
  values: Record<string, unknown>,
): { manifest: PluginManifest; code: string } {
  let config: Record<string, unknown>;
  let code: string;
  switch (template.id) {
    case "dice-button": {
      const sides = Number(values.sides);
      const parsed = parseDiceMessages(String(values.messages ?? ""), sides);
      if (!parsed.ok) throw new TemplateGenerationError(parsed.message);
      config = {
        label: values.label,
        sides,
        count: Number(values.count),
        messages: parsed.messages,
      };
      code = diceCode(String(values.slot), config);
      break;
    }
    case "counter": {
      config = {
        label: values.label,
        start: Number(values.start),
        step: Number(values.step),
        storageKey: values.storageKey,
      };
      code = counterCode(config);
      break;
    }
    case "thread-info": {
      config = {
        fields: values.fields ?? [],
        prefix: values.prefix ?? "",
      };
      code = threadInfoCode(config);
      break;
    }
    case "quick-reply": {
      config = {
        buttonLabel: values.buttonLabel,
        body: values.body,
        postName: values.postName ?? "",
        confirmText: values.confirmText ?? "",
      };
      code = quickReplyCode(config);
      break;
    }
    default:
      throw new TemplateGenerationError(`slot 系でないテンプレートです: ${template.id}`);
  }

  const manifest = pluginManifestSchema.parse({
    name: values.name,
    version: template.baseManifest.version ?? "1.0.0",
    summary: values.summary,
    description: template.description,
    scope: template.baseManifest.scope ?? [...PLUGIN_SCOPES],
    permissions: slotPermissions(template, values),
    slots: slotNames(template, values),
  });
  return { manifest, code };
}

/**
 * テンプレート入力から `{ manifest, code }` を生成する（報告書 27 §3.0）。
 * 入力エラーは `{ ok:false, fieldErrors }`。生成物の不変条件違反（ReDoS 自己検査・32KB 超過）は
 * 実装バグなので `TemplateGenerationError` を投げる。
 */
export function generateFromTemplate(
  templateId: PluginTemplateId | string,
  params: unknown,
): TemplateGenerateResult {
  const template = findPluginTemplate(templateId);
  if (!template) {
    return { ok: false, fieldErrors: [{ key: "templateId", message: "不明なテンプレートです" }] };
  }
  const validated = validateTemplateParams(template.id, params);
  if (!validated.ok) return validated;

  let built: { manifest: PluginManifest; code: string };
  try {
    built =
      template.kind === "render"
        ? buildRenderTemplate(template, validated.values)
        : buildSlotTemplate(template, validated.values);
  } catch (error) {
    if (error instanceof TemplateGenerationError) throw error;
    throw new TemplateGenerationError(
      error instanceof Error ? error.message : "テンプレートの生成に失敗しました",
    );
  }

  // 自己検査（render 規則の ReDoS・コード長）。manifest 検証は pluginManifestSchema が済ませている。
  for (const rule of built.manifest.render?.post ?? []) {
    const safety = analyzeRegexPattern(rule.pattern, rule.flags);
    if (!safety.safe) {
      throw new TemplateGenerationError(
        `生成した正規表現が安全ではありません: ${safety.reason ?? "unknown"}`,
      );
    }
  }
  const bytes = new TextEncoder().encode(built.code).byteLength;
  if (bytes > PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES) {
    throw new TemplateGenerationError(
      `生成コードが上限（${PLUGIN_AUTHOR_TEMPLATE_CODE_MAX_BYTES} バイト）を超えています`,
    );
  }

  return { ok: true, templateId: template.id, manifest: built.manifest, code: built.code };
}

// ─── ② 作成用 MCP ツール（authoring.*） ─────────────────────────────

/** /mcp-plugin に登録するツール名（スコープ外のツールは登録しない）。 */
export const AUTHORING_TOOL_NAMES = [
  "authoring.list_templates",
  "authoring.create_draft",
  "authoring.add_version",
  "authoring.check",
  "authoring.preview",
  "authoring.publish",
  "authoring.install_self",
  "authoring.get",
  "authoring.list",
] as const;
export type AuthoringToolName = (typeof AUTHORING_TOOL_NAMES)[number];

/** 共通エラー形式（`{ ok:false, code, message, details? }` を isError で返す）。 */
export const authoringErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(2000),
  details: z.unknown().optional(),
});
export type AuthoringError = z.infer<typeof authoringErrorSchema>;

/** 静的検査結果（`PluginStaticCheckResult` と同形）。 */
export const authoringStaticCheckResultSchema = z.strictObject({
  allowed: z.boolean(),
  reasons: z.array(z.string().max(300)).max(100),
  riskScore: z.number().int().min(0).max(100),
});
export type AuthoringStaticCheckResult = z.infer<typeof authoringStaticCheckResultSchema>;

/** トークン経路のコード上限（64KB）。 */
export const authoringCodeSchema = z
  .string()
  .min(1, "コードが空です")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= PLUGIN_AUTHOR_CODE_MAX_BYTES,
    { message: `コードは ${Math.floor(PLUGIN_AUTHOR_CODE_MAX_BYTES / 1024)}KB 以下にしてください` },
  );

const pluginIdSchema = z.string().min(1).max(64);

/** templateId（① の由来を示す任意メタ。既知の id のみ）。 */
export const authoringTemplateIdSchema = z.enum(PLUGIN_TEMPLATE_IDS);

export const authoringListTemplatesInputSchema = z.strictObject({});
export type AuthoringListTemplatesInput = z.infer<typeof authoringListTemplatesInputSchema>;

export const authoringListTemplatesOutputSchema = z.strictObject({
  ok: z.literal(true),
  templates: z.array(authoringTemplateInfoSchema).max(50),
});
export type AuthoringListTemplatesOutput = z.infer<typeof authoringListTemplatesOutputSchema>;

export const authoringCreateDraftSchema = z.strictObject({
  manifest: pluginManifestSchema,
  code: authoringCodeSchema,
  changelog: z.string().max(2000).optional(),
  visibility: z.enum(["private", "unlisted"]).default("private"),
  templateId: authoringTemplateIdSchema.optional(),
});
export type AuthoringCreateDraftInput = z.infer<typeof authoringCreateDraftSchema>;

export const authoringCreateDraftOutputSchema = z.strictObject({
  ok: z.literal(true),
  pluginId: pluginIdSchema,
  name: z.string().regex(PLUGIN_NAME_PATTERN),
  version: semverSchema,
  checks: authoringStaticCheckResultSchema,
  warnings: z.array(z.string().max(500)).max(50),
});
export type AuthoringCreateDraftOutput = z.infer<typeof authoringCreateDraftOutputSchema>;

export const authoringAddVersionSchema = z.strictObject({
  pluginId: pluginIdSchema,
  version: semverSchema.optional(),
  manifest: pluginManifestSchema.optional(),
  code: authoringCodeSchema,
  changelog: z.string().max(2000).optional(),
  templateId: authoringTemplateIdSchema.optional(),
});
export type AuthoringAddVersionInput = z.infer<typeof authoringAddVersionSchema>;

export const authoringAddVersionOutputSchema = z.strictObject({
  ok: z.literal(true),
  pluginId: pluginIdSchema,
  version: semverSchema,
  checks: authoringStaticCheckResultSchema,
  warnings: z.array(z.string().max(500)).max(50),
});
export type AuthoringAddVersionOutput = z.infer<typeof authoringAddVersionOutputSchema>;

export const authoringCheckSchema = z.strictObject({
  code: authoringCodeSchema,
  manifest: pluginManifestSchema.optional(),
});
export type AuthoringCheckInput = z.infer<typeof authoringCheckSchema>;

export const authoringCheckOutputSchema = z.strictObject({
  ok: z.literal(true),
  checks: authoringStaticCheckResultSchema,
  warnings: z.array(z.string().max(500)).max(50),
});
export type AuthoringCheckOutput = z.infer<typeof authoringCheckOutputSchema>;

export const authoringPreviewSchema = z.strictObject({
  pluginId: pluginIdSchema,
});
export type AuthoringPreviewInput = z.infer<typeof authoringPreviewSchema>;

export const authoringRenderSafetySchema = z.strictObject({
  pattern: z.string().max(500),
  flags: z.string().max(6),
  safe: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type AuthoringRenderSafety = z.infer<typeof authoringRenderSafetySchema>;

export const authoringVersionSummarySchema = z.strictObject({
  version: semverSchema,
  status: z.enum(PLUGIN_STATUSES),
  changelog: z.string().max(2000).optional(),
  createdAt: z.number().int().nonnegative().optional(),
});
export type AuthoringVersionSummary = z.infer<typeof authoringVersionSummarySchema>;

export const authoringReviewSummarySchema = z.strictObject({
  id: z.string().min(1).max(64),
  scope: z.enum(["board", "site"]),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.number().int().nonnegative().optional(),
});
export type AuthoringReviewSummary = z.infer<typeof authoringReviewSummarySchema>;

export const authoringPreviewOutputSchema = z.strictObject({
  ok: z.literal(true),
  pluginId: pluginIdSchema,
  manifest: pluginManifestSchema,
  checks: authoringStaticCheckResultSchema,
  warnings: z.array(z.string().max(500)).max(50),
  regex: z.array(authoringRenderSafetySchema).max(20),
  versions: z.array(authoringVersionSummarySchema).max(100),
  reviews: z.array(authoringReviewSummarySchema).max(50),
  /** ブラウザ確認用 URL（例 `/plugins/new?id=<pluginId>`）。 */
  previewUrl: z.string().min(1).max(300),
});
export type AuthoringPreviewOutput = z.infer<typeof authoringPreviewOutputSchema>;

export const authoringPublishSchema = z.strictObject({
  pluginId: pluginIdSchema,
  scopes: z.array(z.enum(PLUGIN_SCOPES)).min(1).max(3),
  visibility: z.enum(PLUGIN_VISIBILITIES).default("public"),
});
export type AuthoringPublishInput = z.infer<typeof authoringPublishSchema>;

export const authoringPublishOutputSchema = z.strictObject({
  ok: z.literal(true),
  pluginId: pluginIdSchema,
  status: z.enum(PLUGIN_STATUSES),
  /** site を含む場合は true（plugin_reviews の pending 止まり）。 */
  needsReview: z.boolean(),
  reviewId: z.string().min(1).max(64).optional(),
  message: z.string().max(500).optional(),
  checks: authoringStaticCheckResultSchema,
});
export type AuthoringPublishOutput = z.infer<typeof authoringPublishOutputSchema>;

export const authoringInstallSelfSchema = z.strictObject({
  pluginId: pluginIdSchema,
  version: semverSchema.optional(),
  pinned: z.boolean().default(false),
  /** true なら個人導入を解除する。 */
  uninstall: z.boolean().default(false),
});
export type AuthoringInstallSelfInput = z.infer<typeof authoringInstallSelfSchema>;

export const authoringInstallSelfOutputSchema = z.strictObject({
  ok: z.literal(true),
  pluginId: pluginIdSchema,
  scope: z.literal("personal"),
  installed: z.boolean(),
  uninstalled: z.boolean(),
  version: semverSchema.optional(),
  pinned: z.boolean(),
});
export type AuthoringInstallSelfOutput = z.infer<typeof authoringInstallSelfOutputSchema>;

export const authoringGetSchema = z.strictObject({
  pluginId: pluginIdSchema,
});
export type AuthoringGetInput = z.infer<typeof authoringGetSchema>;

export const authoringPluginSummarySchema = z.strictObject({
  id: pluginIdSchema,
  name: z.string().regex(PLUGIN_NAME_PATTERN),
  status: z.enum(PLUGIN_STATUSES),
  visibility: z.enum(PLUGIN_VISIBILITIES),
  version: semverSchema.optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});
export type AuthoringPluginSummary = z.infer<typeof authoringPluginSummarySchema>;

export const authoringGetOutputSchema = z.strictObject({
  ok: z.literal(true),
  plugin: authoringPluginSummarySchema.extend({
    manifest: pluginManifestSchema,
    createdAt: z.number().int().nonnegative().optional(),
  }),
  versions: z.array(authoringVersionSummarySchema).max(100),
  reviews: z.array(authoringReviewSummarySchema).max(50),
});
export type AuthoringGetOutput = z.infer<typeof authoringGetOutputSchema>;

export const authoringListSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().max(300).optional(),
  status: z.enum(PLUGIN_STATUSES).optional(),
  q: z.string().max(100).optional(),
});
export type AuthoringListInput = z.infer<typeof authoringListSchema>;

export const authoringListOutputSchema = z.strictObject({
  ok: z.literal(true),
  plugins: z.array(authoringPluginSummarySchema).max(100),
  nextCursor: z.string().max(300).optional(),
});
export type AuthoringListOutput = z.infer<typeof authoringListOutputSchema>;

// ─── ② トークン管理 REST（/v1/me/plugin-tokens） ───────────────────

export const pluginAuthorTokenCreateSchema = z.strictObject({
  /** 利用者の識別名（例「自宅の Claude Code」）。省略時はサーバーが既定名を付ける。 */
  name: z.string().trim().min(1).max(PLUGIN_TOKEN_NAME_MAX_CHARS).optional(),
});
export type PluginAuthorTokenCreateInput = z.infer<typeof pluginAuthorTokenCreateSchema>;

export const pluginAuthorTokenStatusSchema = z.enum(["active", "revoked"]);
export type PluginAuthorTokenStatus = z.infer<typeof pluginAuthorTokenStatusSchema>;

/** 発行応答（平文 `token` はこの応答で 1 回だけ返す）。 */
export const pluginAuthorTokenCreateResponseSchema = z.strictObject({
  id: z.string().min(1).max(64),
  /** 平文トークン（`ocp_...`）。再表示しない。 */
  token: z.string().min(1).max(200),
  prefix: z.string().min(1).max(40),
  name: z.string().min(1).max(PLUGIN_TOKEN_NAME_MAX_CHARS),
  status: pluginAuthorTokenStatusSchema,
  createdAt: z.number().int().nonnegative(),
  /** Unix 秒。 */
  expiresAt: z.number().int().nonnegative(),
});
export type PluginAuthorTokenCreateResponse = z.infer<
  typeof pluginAuthorTokenCreateResponseSchema
>;

/** 一覧の 1 件（平文・ハッシュは含めない）。 */
export const pluginAuthorTokenSummarySchema = z.strictObject({
  id: z.string().min(1).max(64),
  prefix: z.string().min(1).max(40),
  name: z.string().min(1).max(PLUGIN_TOKEN_NAME_MAX_CHARS),
  status: pluginAuthorTokenStatusSchema,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().optional(),
  /** 期限切れ（サーバー判定）。 */
  expired: z.boolean().optional(),
});
export type PluginAuthorTokenSummary = z.infer<typeof pluginAuthorTokenSummarySchema>;

export const pluginAuthorTokenListResponseSchema = z.strictObject({
  items: z.array(pluginAuthorTokenSummarySchema).max(20),
});
export type PluginAuthorTokenListResponse = z.infer<typeof pluginAuthorTokenListResponseSchema>;

export const pluginAuthorTokenRevokeResponseSchema = z.strictObject({
  ok: z.literal(true),
  id: z.string().min(1).max(64),
});
export type PluginAuthorTokenRevokeResponse = z.infer<typeof pluginAuthorTokenRevokeResponseSchema>;

export const pluginAuthorTokenRevokeAllResponseSchema = z.strictObject({
  ok: z.literal(true),
  revoked: z.number().int().min(0).max(1000),
});
export type PluginAuthorTokenRevokeAllResponse = z.infer<
  typeof pluginAuthorTokenRevokeAllResponseSchema
>;