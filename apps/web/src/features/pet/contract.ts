// AI ペットの画面側の共通契約（ツール・確認カード・設定）。
//
// 担当の分け方（設計書 00 §4）:
// - 会話の画面・設定・会話の進行・音声入力（`ui/*`、`agent.ts`、`relay-client.ts`、`prompt.ts`、`settings.ts`）: PetUI
// - ツール（`tools/*`）: PetTools
// このファイルは両者の境界。変更はオーケストレーター経由で行う。

import type { PetProviderId } from "shared";

// ─── ツール ───

/**
 * - `read`: 読むだけ（確認なしで実行）
 * - `navigate`: 画面を移動する（確認なし。会話の進行役は、このツールをその回の最後に実行し、実行前に履歴を保存する。
 *   フルページ遷移で会話の進行が途切れても履歴が残るようにするため）
 * - `write`: 掲示板に何かを残す・変える操作。会話の進行役が **必ず** 確認カードを出し、利用者が「実行」を押した場合だけ
 *   `run` を呼ぶ。ツール側で確認を省略する手段は無い。
 */
export type PetToolKind = "read" | "navigate" | "write";

export type PetToolResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; error: string };

export interface PetPageContext {
  /** location.pathname + search */
  path: string;
  title: string;
  boardSlug: string | null;
  threadId: number | null;
  /** 画面で選択中の文字（最大 2000 文字）。 */
  selectionText: string;
}

export interface PetToolContext {
  signal: AbortSignal;
  page: PetPageContext;
  /** 同一オリジンのパスだけ受け付ける（`/` で始まり `//` で始まらない）。 */
  navigate(path: string): void;
}

export interface PetConfirmRequest {
  /** 例「このスレに書き込みます」 */
  title: string;
  /** 本文などはそのまま表示する（改行保持・HTML として解釈しない）。 */
  details: { label: string; value: string }[];
  /** 削除・管理操作など取り消しにくい操作。カードを警告色にし、「実行」の文言を「実行する（取り消せません）」にする。 */
  danger?: boolean;
  /** true ならカードに Turnstile を出し、通過するまで「実行」を押せない（30 分パスが有効なら出さない）。 */
  turnstile?: boolean;
}

export interface PetApproval {
  /** `turnstile: true` のときの通過トークン（30 分パス有効時は null）。ツールはこれをプラグインやモデルへ渡さない。 */
  turnstileToken: string | null;
}

interface PetToolBase {
  /** `PET_TOOL_NAME_RE`（shared）に合う名前。 */
  name: string;
  /** 実行中の表示（例「スレを読んでいます」）。 */
  label: string;
  /** モデルに渡す説明（日本語・1000 文字以内）。 */
  description: string;
  /** JSON Schema（type: "object"）。 */
  parameters: Record<string, unknown>;
}

export interface PetReadTool extends PetToolBase {
  kind: "read" | "navigate";
  run(args: unknown, ctx: PetToolContext): Promise<PetToolResult>;
}

export interface PetWriteTool extends PetToolBase {
  kind: "write";
  /**
   * 引数を検証し、確認カードの中身を作る（対象のレス本文の取得など読むだけの通信は可）。
   * 引数が不正・権限が無いと分かっている場合は `PetToolResult`（ok:false）を返す。
   */
  prepare(args: unknown, ctx: PetToolContext): Promise<PetConfirmRequest | PetToolResult>;
  /** 利用者が「実行」を押した後だけ呼ばれる。 */
  run(args: unknown, ctx: PetToolContext, approval: PetApproval): Promise<PetToolResult>;
}

export type PetTool = PetReadTool | PetWriteTool;

// ─── 設定（ブラウザにだけ保存。サーバーには送らない。API キーは中継の 1 回ごとにヘッダーで送るだけ） ───

export interface PetConfig {
  provider: PetProviderId;
  /** provider が custom のときだけ使う。 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** false ならタブを閉じるまで（sessionStorage）。true ならこの端末に保存（localStorage）。 */
  remember: boolean;
  petName: string;
  /** `PET_CHARACTERS` の id、または "custom"（利用者がアップロードした画像）。 */
  characterId: string;
}
