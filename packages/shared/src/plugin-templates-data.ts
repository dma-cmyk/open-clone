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
  "tally",
  "choice",
  "entries",
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
    risk: "medium",
    label: "サイコロ（レスに書き込む）",
    description:
      "スレ上部か下部にサイコロボタンを追加します。押すと `!NdM` 付きのレスを書き込むので、出目はサーバーが振り、スレに残って全員に見えます（書き込み前にホストが内容と Bot 確認を出します）。",
    parameters: [
      nameParameter("dice-button"),
      summaryParameter("サーバーのサイコロでレスする"),
      {
        key: "slot",
        label: "表示場所",
        type: "select",
        required: false,
        default: "thread-bottom",
        constraints: {
          options: [
            { value: "thread-bottom", label: "スレ下部に 1 つ" },
            { value: "thread-head", label: "スレ上部に 1 つ" },
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
        key: "count",
        label: "振る個数",
        type: "number",
        required: false,
        default: 1,
        constraints: { min: 1, max: 10, integer: true },
      },
      {
        key: "sides",
        label: "面の数",
        type: "number",
        required: false,
        default: 6,
        constraints: { min: 2, max: 1000, integer: true },
      },
      {
        key: "body",
        label: "一緒に書く本文（任意）",
        type: "text",
        required: false,
        default: "",
        constraints: { maxLength: 2000, placeholder: "空なら「（サイコロ）」" },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot", "data:write:post"],
      slots: ["thread-bottom", "thread-head"],
    },
  },
  {
    id: "tally",
    kind: "slot",
    risk: "medium",
    label: "人数カウンタ（参加・いいね）",
    description:
      "スレ上部に参加ボタンを置きます。押した人の分だけ数が増え、同じ人がもう一度押すと取り消せます（1 人 1 回）。スレごとに別々に数えます。",
    parameters: [
      nameParameter("tally"),
      summaryParameter("押した人数をスレごとに数える"),
      {
        key: "label",
        label: "ボタンの文字（未参加）",
        type: "string",
        required: false,
        default: "🙋 参加する",
        constraints: { minLength: 1, maxLength: 20 },
      },
      {
        key: "onLabel",
        label: "ボタンの文字（参加済み）",
        type: "string",
        required: false,
        default: "✅ 参加済み",
        constraints: { minLength: 1, maxLength: 20 },
      },
      {
        key: "who",
        label: "押せる人",
        type: "select",
        required: false,
        default: "anyone",
        constraints: {
          options: [
            { value: "anyone", label: "誰でも（未ログインも可）" },
            { value: "login", label: "ログインした人だけ" },
          ],
        },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot", "storage:thread"],
      slots: ["thread-head"],
    },
  },
  {
    id: "choice",
    kind: "slot",
    risk: "medium",
    label: "スレのアンケート",
    description:
      "スレ上部に 2〜10 択のアンケートを表示します。1 人 1 票で、選び直し・取り消しができます。結果は票数の棒で表示します。",
    parameters: [
      nameParameter("choice"),
      summaryParameter("スレごとのアンケート"),
      {
        key: "question",
        label: "質問",
        type: "string",
        required: true,
        default: "どれが好き？",
        constraints: { minLength: 1, maxLength: 60 },
      },
      {
        key: "options",
        label: "選択肢（1 行 1 件・2〜10 件）",
        type: "stringList",
        required: true,
        default: ["はい", "いいえ", "わからない"],
        constraints: {
          maxItems: 10,
          itemMaxLength: 30,
          placeholder: "選択肢を 1 行に 1 つ入力",
        },
      },
      {
        key: "who",
        label: "投票できる人",
        type: "select",
        required: false,
        default: "anyone",
        constraints: {
          options: [
            { value: "anyone", label: "誰でも（未ログインも可）" },
            { value: "login", label: "ログインした人だけ" },
          ],
        },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot", "storage:thread"],
      slots: ["thread-head"],
    },
  },
  {
    id: "entries",
    kind: "slot",
    risk: "medium",
    label: "参加表明・一言リスト",
    description:
      "スレ下部に一言を書き込めるリストを追加します。書いた本人は取り消せます。表示名はレスと同じ ID で、アカウント名やメールは出ません。",
    parameters: [
      nameParameter("entries"),
      summaryParameter("スレごとの参加表明リスト"),
      {
        key: "buttonLabel",
        label: "ボタンの文字",
        type: "string",
        required: false,
        default: "✍️ ひとこと書く",
        constraints: { minLength: 1, maxLength: 20 },
      },
      {
        key: "inputHint",
        label: "入力欄の説明",
        type: "string",
        required: false,
        default: "ひとことを入力（100 文字まで）",
        constraints: { minLength: 1, maxLength: 60 },
      },
      {
        key: "maxPerActor",
        label: "1 人の上限（件）",
        type: "number",
        required: false,
        default: 1,
        constraints: { min: 1, max: 10, integer: true },
      },
      {
        key: "who",
        label: "書ける人",
        type: "select",
        required: false,
        default: "anyone",
        constraints: {
          options: [
            { value: "anyone", label: "誰でも（未ログインも可）" },
            { value: "login", label: "ログインした人だけ" },
          ],
        },
      },
    ],
    baseManifest: {
      version: "1.0.0",
      scope: [...SCOPES],
      permissions: ["ui:slot", "storage:thread"],
      slots: ["thread-bottom"],
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
      "スレ下部に定型文の返信ボタンを追加します。押した人の名義で投稿されるため、ホストが書き込み内容の確認 UI を挟みます。",
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