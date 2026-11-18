// プラグインの権限と表示場所（スロット）の説明表。
//
// 利用者向けの日本語名・説明・危険度を 1 か所だけに置き、web（詳細画面・導入画面・
// エディタ・ヘルプ）と api（MCP authoring の instructions）が同じ文面を参照する。
// 権限の危険度は `PLUGIN_PERMISSION_RISK` を正本とし、ここでは二重に持たない。
// 足し忘れは `Record<PluginPermission, …>` / `Record<PluginSlotName, …>` により
// コンパイルエラーになる（PLUGIN_PERMISSIONS / PLUGIN_SLOTS を増やしたら必ずここも直す）。

import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERMISSION_RISK,
  PLUGIN_SLOTS,
  type PluginPermission,
  type PluginSlotName,
} from "./schemas/plugin";

/** 権限の危険度（PLUGIN_PERMISSION_RISK の値と同じ）。 */
export type PluginRisk = (typeof PLUGIN_PERMISSION_RISK)[PluginPermission];

/** 危険度の日本語表示（色だけでなく文字でも示す）。 */
export const PLUGIN_RISK_LABEL: Readonly<Record<PluginRisk, string>> = {
  low: "低",
  medium: "中",
  high: "高",
};

/** 危険度ごとの補足（一覧の見出しに出す 1 行）。 */
export const PLUGIN_RISK_NOTE: Readonly<Record<PluginRisk, string>> = {
  low: "できることの範囲は小さめです",
  medium: "書き込みや外部通信を伴います",
  high: "外部サービスへの書き込みを伴います。内容を確認してから入れてください",
};

export interface PluginPermissionText {
  /** 利用者向けの日本語名。 */
  name: string;
  /** 「このプラグインは〜できます」の形の 1 行説明。 */
  description: string;
}

/** 権限の文言（危険度は含めない。正本は PLUGIN_PERMISSION_RISK）。 */
const PERMISSION_TEXT: Readonly<Record<PluginPermission, PluginPermissionText>> = {
  "ui:slot": {
    name: "画面に表示",
    description: "決められた場所に、プラグインの部品を表示します。",
  },
  "data:read:thread": {
    name: "スレの読み取り",
    description: "表示中のスレのタイトルやレスを読みます（あなたが見られる範囲だけ）。",
  },
  "data:read:board": {
    name: "板の読み取り",
    description: "板の名前や設定を読みます。",
  },
  "data:write:post": {
    name: "書き込み",
    description: "あなたの名前でレスを書き込みます。書き込む前に必ず確認の窓が出ます。",
  },
  "storage:shared": {
    name: "保存領域",
    description: "プラグインの設定などを保存します（板やサイトごとに 64KB まで）。",
  },
  "storage:thread": {
    name: "スレごとの共有値",
    description:
      "スレごとに人数・投票・一言を記録します。1 人 1 回などの決まりはサイトが守らせます。",
  },
  "net:fetch": {
    name: "外部との通信",
    description: "作者が指定した外部サイトと通信します（通信先は詳細画面に表示されます）。",
  },
  "upload:start": {
    name: "ファイル添付",
    description: "ファイルのアップロード画面を開きます。",
  },
  "github:gist": {
    name: "GitHub（Gist）",
    description: "GitHub と連携済みのとき、あなたの Gist に書き込みます（その都度確認）。",
  },
  "github:repo": {
    name: "GitHub（リポジトリ）",
    description: "GitHub と連携済みのとき、あなたのリポジトリに書き込みます（その都度確認）。",
  },
  "events:subscribe": {
    name: "更新の受け取り",
    description: "新しいレスなどの更新を受け取ります。",
  },
  notify: {
    name: "通知",
    description: "画面にお知らせを出します。",
  },
  "ai:complete": {
    name: "AI 連携",
    description: "サイトの AI に文章を送って結果を受け取ります（その都度確認）。",
  },
};

export interface PluginPermissionInfo extends PluginPermissionText {
  permission: PluginPermission;
  risk: PluginRisk;
}

/** 権限 1 件分の表示情報（名前・説明・危険度）。 */
export function pluginPermissionInfo(permission: PluginPermission): PluginPermissionInfo {
  return {
    permission,
    ...PERMISSION_TEXT[permission],
    risk: PLUGIN_PERMISSION_RISK[permission],
  };
}

/** 全権限の表示情報（PLUGIN_PERMISSIONS の順）。 */
export const PLUGIN_PERMISSION_INFOS: readonly PluginPermissionInfo[] = PLUGIN_PERMISSIONS.map(
  pluginPermissionInfo,
);

/** 実際に画面へ置かれている場所（ホスト側スロット）10 個。エディタはこの順で並べる。 */
export const PLUGIN_PLACED_SLOTS = [
  "site-header",
  "site-top",
  "board-top",
  "board-sidebar",
  "thread-top",
  "thread-nav",
  "post-actions",
  "post-form-extra",
  "thread-bottom",
  "board-manage",
] as const satisfies readonly PluginSlotName[];

export interface PluginSlotText {
  /** 場所の日本語名（別名も置き先の名前を使う）。 */
  label: string;
  /** 1 行説明。 */
  description: string;
  /** 実際に置かれる場所。`null` は通常の画面に置き場所が無いもの。 */
  host: PluginSlotName | null;
}

/** スロットの文言と置き先（全スロット分。足し忘れは型エラー）。 */
const SLOT_TEXT: Readonly<Record<PluginSlotName, PluginSlotText>> = {
  "site-header": {
    label: "サイトのヘッダー",
    description: "ロゴや検索欄が並ぶ、全ページ共通の上部です。",
    host: "site-header",
  },
  "site-top": {
    label: "サイトの上部",
    description: "トップ（板一覧）の、板一覧のすぐ上です。",
    host: "site-top",
  },
  "board-top": {
    label: "板の上",
    description: "板ページの板名・説明の下、スレ一覧の上です。",
    host: "board-top",
  },
  "board-sidebar": {
    label: "板の横（スマホでは表示されません）",
    description: "板一覧の横のサイドバーです。幅の狭い画面（900px 以下）ではサイドバーごと表示されません。",
    host: "board-sidebar",
  },
  "thread-top": {
    label: "スレの上",
    description: "スレのタイトル・本文の下、レス一覧の上です。",
    host: "thread-top",
  },
  "thread-nav": {
    label: "スレ内メニュー",
    description: "スレ内の範囲リンク（1-100・最新50 など）の下にある、移動用の帯です。",
    host: "thread-nav",
  },
  "post-actions": {
    label: "各レスの下",
    description: "各レスの引用・通報ボタンの並びです。",
    host: "post-actions",
  },
  "post-form-extra": {
    label: "書き込み欄の下",
    description: "名前・本文の入力欄と投稿ボタンの下です。",
    host: "post-form-extra",
  },
  "thread-bottom": {
    label: "スレの下",
    description: "レス一覧の下、書き込み欄の上です。",
    host: "thread-bottom",
  },
  "board-manage": {
    label: "板の管理画面",
    description: "板の管理タブ（設定・スタッフ・AI など）の中です。",
    host: "board-manage",
  },
  // ─── 別名（既存プラグイン互換。値は変えずに置き先の場所名で表示する） ───
  "thread-head": {
    label: "スレの上",
    description: "スレ画面上部の別名です。実際は「スレの上」に表示されます。",
    host: "thread-top",
  },
  "thread-post-inline": {
    label: "各レスの下",
    description: "各レスの中の別名です。実際は「各レスの下」に表示されます。",
    host: "post-actions",
  },
  "thread-post-footer": {
    label: "各レスの下",
    description: "各レスの下部の別名です。実際は「各レスの下」に表示されます。",
    host: "post-actions",
  },
  "post-form-after": {
    label: "書き込み欄の下",
    description: "投稿フォーム直下の別名です。実際は「書き込み欄の下」に表示されます。",
    host: "post-form-extra",
  },
  "board-head": {
    label: "板の上",
    description: "板画面上部の別名です。実際は「板の上」に表示されます。",
    host: "board-top",
  },
  sidebar: {
    label: "板の横（スマホでは表示されません）",
    description:
      "サイドバーの別名です。実際は「板の横（スマホでは表示されません）」に表示されます。",
    host: "board-sidebar",
  },
  "plugin-page": {
    label: "表示場所なし",
    description:
      "通常の画面には表示されません（スレ表示デモ /plugins/demo/ とエディタのプレビューだけで動きます）。",
    host: null,
  },
};

export interface PluginSlotInfo extends PluginSlotText {
  slot: PluginSlotName;
  /** 置き先が別名のとき、その別名の対象（置き先と同じなら null）。 */
  aliasOf: PluginSlotName | null;
  /** 通常の画面に置き場所があるか。 */
  placed: boolean;
}

/** スロット 1 件分の表示情報。 */
export function pluginSlotInfo(slot: PluginSlotName): PluginSlotInfo {
  const text = SLOT_TEXT[slot];
  return {
    slot,
    ...text,
    aliasOf: text.host !== null && text.host !== slot ? text.host : null,
    placed: text.host !== null,
  };
}

/** 全スロットの表示情報（PLUGIN_SLOTS の順）。 */
export const PLUGIN_SLOT_INFOS: readonly PluginSlotInfo[] = PLUGIN_SLOTS.map(pluginSlotInfo);

/** スロットが実際に置かれる場所（置き場所が無ければ null）。 */
export function pluginSlotHost(slot: PluginSlotName): PluginSlotName | null {
  return SLOT_TEXT[slot].host;
}

/** その場所へ割り当てられている別名（スロット名そのものは含めない）。 */
export function pluginSlotAliases(host: PluginSlotName): readonly PluginSlotName[] {
  return PLUGIN_SLOTS.filter((slot) => slot !== host && SLOT_TEXT[slot].host === host);
}

/**
 * 別名の対応（別名 → 置き先）。ホスト側のスロット解決はこれを使う。
 * 例: `thread-head` → `thread-top`。
 */
export const PLUGIN_SLOT_ALIAS_HOSTS: Readonly<Partial<Record<PluginSlotName, PluginSlotName>>> =
  Object.fromEntries(
    PLUGIN_SLOTS.filter((slot) => SLOT_TEXT[slot].host !== slot)
      .filter((slot) => SLOT_TEXT[slot].host !== null)
      .map((slot) => [slot, SLOT_TEXT[slot].host]),
  ) as Readonly<Partial<Record<PluginSlotName, PluginSlotName>>>;