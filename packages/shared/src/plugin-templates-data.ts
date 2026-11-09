// プラグイン作成テンプレートの定義データ（報告書 27 §3 / 28 §6.1）。
// D1 ではなくコード同梱。web（① フォーム）と api（② authoring.list_templates）が
// この 1 つの定義を import する（生成物ではなく定義だけを共有する）。
//
// 入力項目・既定値・制約・説明文のみをデータとして持ち、実際の manifest/code の組み立ては
// `schemas/plugin-authoring.ts` の `generateFromTemplate()` が行う（入力は必ず zod 相当の
// 検証を通り、コードにはデータとしてしか埋め込まれない）。
//
// このファイルは型 import のみで他モジュールに依存する（循環 import を作らない）。

import type { AuthoringTemplateInfo } from "./schemas/plugin-authoring";

/** テンプレート id（新規追加はここに足す。既存 id は変更しない）。 */
export const PLUGIN_TEMPLATE_IDS = [
  "spoiler",
  "ng-word-mask",
  "keyword-deco",
  "dice-button",
  "counter",
  "thread-info",
  "quick-reply",
] as const;
export type PluginTemplateId = (typeof PLUGIN_TEMPLATE_IDS)[number];

/**
 * 内部向けのテンプレート定義。`authoringTemplateInfoSchema`（公開形）に、
 * 生成方式（render / slot）とリスク表示だけを足したもの。
 */
export interface PluginTemplateDefinition extends AuthoringTemplateInfo {
  id: PluginTemplateId;
  /** render = manifest.render.post のみ（コード固定）/ slot = ui:slot のコード生成。 */
  kind: "render" | "slot";
  /** 画面のリスクバッジ用（manifest.permissions から導出してもよいが、明示を持つ）。 */
  risk: "low" | "medium";
}

/** 全テンプレート共通のプラグイン名パラメータ。 */
function nameParameter(defaultName: string): AuthoringTemplateInfo["parameters"][number] {
  return {
    key: "name",
    label: "プラグイン名",
    type: "string",
    required: true,
    default: defaultName,
    constraints: {
      minLength: 3,
      maxLength: 41,
      slugPattern: "^[a-z][a-z0-9-]{2,40}$",
      placeholder: "my-plugin",
    },
  };
}

/** 全テンプレート共通の概要パラメータ。 */
function summaryParameter(defaultSummary: string): AuthoringTemplateInfo["parameters"][number] {
  return {
    key: "summary",
    label: "概要",
    type: "string",
    required: true,
    default: defaultSummary,
    constraints: { minLength: 1, maxLength: 200 },
  };
}

const SCOPES = ["personal", "board", "site"] as const;

export const PLUGIN_TEMPLATES: readonly PluginTemplateDefinition[] = [
  {
    id: "spoiler",
    kind: "render",
    risk: "low",
    label: "ネタバレ伏せ",
    description:
      "指定した開始タグと終了タグで囲んだ部分を、クリックで開く黒塗り表示にします。権限は不要です。",
    parameters: [
      nameParameter("my-spoiler"),
      summaryParameter("囲んだ部分をネタバレ伏せにする"),
      {
        key: "openTag",
        label: "開始タグ",
        type: "string",
        required: true,
        default: "[sp]",
        constraints: { minLength: 1, maxLength: 10, placeholder: "[sp]" },
      },
      {
        key: "closeTag",
        label: "終了タグ",
        type: "string",
        required: true,
        default: "[/sp]",
        constraints: { minLength: 1, maxLength: 10, placeholder: "[/sp]" },
      },
      {
        key: "style",
        label: "伏せ方",
        type: "select",
        required: false,
        default: "spoiler",
        constraints: {
          options: [{ value: "spoiler", label: "黒塗り（クリックで開く）" }],
        },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: [],
      slots: [],
    },
  },
  {
    id: "ng-word-mask",
    kind: "render",
    risk: "low",
    label: "NG ワード表示置換",
    description:
      "指定した単語をレス表示の上だけ伏せ字に置換します。投稿内容そのものは変更されません（表示側の機能です）。",
    parameters: [
      nameParameter("ng-word-mask"),
      summaryParameter("指定した単語を表示上伏せ字にする"),
      {
        key: "words",
        label: "伏せたい単語（1 行 1 語）",
        type: "stringList",
        required: true,
        default: [],
        constraints: {
          maxItems: 50,
          itemMaxLength: 30,
          placeholder: "単語を 1 行に 1 つ入力",
        },
      },
      {
        key: "mask",
        label: "置換後の文字",
        type: "string",
        required: false,
        default: "＊＊＊",
        constraints: { minLength: 1, maxLength: 20, placeholder: "＊＊＊" },
      },
      {
        key: "ignoreCase",
        label: "大文字小文字を区別しない",
        type: "boolean",
        required: false,
        default: true,
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: [],
      slots: [],
    },
  },
  {
    id: "keyword-deco",
    kind: "render",
    risk: "low",
    label: "キーワード装飾",
    description:
      "指定した語をレス内で目立つ装飾にします。装飾はホストが用意した固定スタイルから選びます。",
    parameters: [
      nameParameter("keyword-deco"),
      summaryParameter("キーワードを目立たせる"),
      {
        key: "keyword",
        label: "目立たせたい語",
        type: "string",
        required: true,
        default: "重要",
        constraints: { minLength: 1, maxLength: 30, placeholder: "重要" },
      },
      {
        key: "deco",
        label: "装飾スタイル",
        type: "select",
        required: false,
        default: "dice",
        constraints: {
          options: [
            { value: "dice", label: "太枠で強調" },
            { value: "link", label: "緑＋下線" },
            { value: "image", label: "緑" },
            { value: "spoiler", label: "黒塗り（クリックで開く）" },
          ],
        },
      },
      {
        key: "ignoreCase",
        label: "大文字小文字を区別しない",
        type: "boolean",
        required: false,
        default: false,
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: [],
      slots: [],
    },
  },
  {
    id: "dice-button",
    kind: "slot",
    risk: "low",
    label: "サイコロ／占いボタン",
    description:
      "レスごと、またはスレ下部にサイコロボタンを追加します。押すと乱数と任意のコメントを表示します。",
    parameters: [
      nameParameter("dice-button"),
      summaryParameter("レスにサイコロボタンを追加"),
      {
        key: "slot",
        label: "表示場所",
        type: "select",
        required: false,
        default: "thread-post-footer",
        constraints: {
          options: [
            { value: "thread-post-footer", label: "各レスの下" },
            { value: "thread-bottom", label: "スレ下部に 1 つ" },
          ],
        },
      },
      {
        key: "label",
        label: "ボタンの文字",
        type: "string",
        required: false,
        default: "🎲 1d6",
        constraints: { minLength: 1, maxLength: 20 },
      },
      {
        key: "sides",
        label: "面の数",
        type: "number",
        required: false,
        default: 6,
        constraints: { min: 2, max: 100, integer: true },
      },
      {
        key: "count",
        label: "振る個数",
        type: "number",
        required: false,
        default: 1,
        constraints: { min: 1, max: 10, integer: true },
      },
      {
        key: "messages",
        label: "結果コメント（任意・「面:文言」を 1 行 1 件）",
        type: "text",
        required: false,
        default: "",
        constraints: { maxLength: 400, placeholder: "6:大当たり" },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot"],
      slots: ["thread-post-footer"],
    },
  },
  {
    id: "counter",
    kind: "slot",
    risk: "low",
    label: "カウンタ",
    description:
      "押すと数が増える共有カウンタをスレ上部に表示します。保存範囲は導入した範囲（個人・板・サイト）に従います。",
    parameters: [
      nameParameter("counter"),
      summaryParameter("押すと増えるカウンタ"),
      {
        key: "label",
        label: "ラベル",
        type: "string",
        required: false,
        default: "👍 カウント",
        constraints: { minLength: 1, maxLength: 20 },
      },
      {
        key: "start",
        label: "初期値",
        type: "number",
        required: false,
        default: 0,
        constraints: { min: 0, max: 999_999, integer: true },
      },
      {
        key: "step",
        label: "増加量",
        type: "number",
        required: false,
        default: 1,
        constraints: { min: 1, max: 100, integer: true },
      },
      {
        key: "storageKey",
        label: "保存キー（内部用）",
        type: "string",
        required: false,
        default: "count",
        constraints: {
          minLength: 1,
          maxLength: 40,
          pattern: "^[A-Za-z0-9_-]+$",
          placeholder: "count",
        },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot", "storage:shared"],
      slots: ["thread-head"],
    },
  },
  {
    id: "thread-info",
    kind: "slot",
    risk: "low",
    label: "スレ情報表示",
    description:
      "スレ上部にタイトル・レス数・板名などの情報を表示します（読み取り専用）。",
    parameters: [
      nameParameter("thread-info"),
      summaryParameter("スレの情報を表示"),
      {
        key: "fields",
        label: "表示する項目",
        type: "stringList",
        required: false,
        default: ["title", "count"],
        constraints: {
          maxItems: 3,
          itemMaxLength: 10,
          options: [
            { value: "title", label: "タイトル" },
            { value: "count", label: "レス数" },
            { value: "board", label: "板名" },
          ],
        },
      },
      {
        key: "prefix",
        label: "先頭の文字",
        type: "string",
        required: false,
        default: "📊",
        constraints: { maxLength: 8 },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot", "data:read:thread"],
      slots: ["thread-head"],
    },
  },
  {
    id: "quick-reply",
    kind: "slot",
    risk: "medium",
    label: "定型レスボタン",
    description:
      "スレ下部に定型文の返信ボタンを追加します。押した人の名義で投稿されるため、確認 UI を挟みます。",
    parameters: [
      nameParameter("quick-reply"),
      summaryParameter("定型文をワンタップで返信"),
      {
        key: "buttonLabel",
        label: "ボタンの文字",
        type: "string",
        required: false,
        default: "📝 定型レス",
        constraints: { minLength: 1, maxLength: 20 },
      },
      {
        key: "body",
        label: "投稿する本文",
        type: "text",
        required: true,
        default: "",
        constraints: { minLength: 1, maxLength: 2000 },
      },
      {
        key: "postName",
        label: "投稿名義（任意）",
        type: "string",
        required: false,
        default: "",
        constraints: { maxLength: 100, placeholder: "空なら板の既定名" },
      },
      {
        key: "confirmText",
        label: "確認メッセージ",
        type: "string",
        required: false,
        default: "この内容で投稿しますか？",
        constraints: { maxLength: 60 },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot", "data:write:post", "notify"],
      slots: ["thread-bottom"],
    },
  },
];

/** id からテンプレート定義を返す（未知 id は undefined）。 */
export function findPluginTemplate(id: string): PluginTemplateDefinition | undefined {
  return PLUGIN_TEMPLATES.find((template) => template.id === id);
}