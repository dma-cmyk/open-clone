// アップローダの共有型（`components/uploader/*` と差し込み側 WP2 の境界）。
// API の入出力は `packages/shared/src/schemas/upload.ts` を正とする。ここでは UI が扱う
// 最小限の添付表現だけを持ち、WP2 の `AttachmentRef`（構造的に同一）と相互運用できる。

import type { AttachmentKind } from "shared";

/** 添付の表示用最小情報。WP2 の `AttachmentRef` と構造互換（id 以外は任意）。 */
export interface UploadedAttachment {
  id?: string;
  url: string;
  contentType?: string;
  size?: number;
  name?: string;
  filename?: string;
  kind?: AttachmentKind;
}

/** 進捗コールバックに渡す状態。`phase` は prepare → 転送 → commit のどこか。 */
export interface UploadProgress {
  file: File;
  /** 0 始まりのファイル番号（複数選択時） */
  index: number;
  /** 今回のバッチに含まれるファイル数 */
  total: number;
  phase: "preparing" | "uploading" | "committing";
  /** 転送済みバイト数（prepare/commit 中は 0） */
  loaded: number;
  /** ファイル全体のバイト数 */
  totalBytes: number;
}

/** `UploaderButton` が `ref` で公開する命令的 API（WP2 の `UploaderHandle` と互換）。 */
export interface UploaderButtonHandle {
  uploadFiles: (files: File[]) => Promise<UploadedAttachment[]>;
  uploadBlob: (blob: Blob, filename: string) => Promise<UploadedAttachment | null>;
}

/** アップロードに失敗した 1 ファイル分の情報。 */
export interface UploadFailure {
  name: string;
  message: string;
}

/** 表示中の 1 ファイルの進捗。 */
export interface UploadingFile {
  name: string;
  size: number;
  phase: UploadProgress["phase"];
  loaded: number;
}