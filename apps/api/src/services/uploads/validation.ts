// アップロード前の共通検証（MIME・拡張子・サイズ・マジックバイト）。
// services.md §1.5「ファイル名・MIME・マジックバイト・サイズを検証」。

import { ApiError, ErrorCode, type UploadRequest } from "shared";
import {
  attachmentKindOf,
  contentTypeMatches,
  isBlockedUploadFilename,
  sniffContentType,
} from "shared/schemas/upload";
import type { ServerUploaderAdapter } from "./types";

const BINARY_DECLARATIONS = ["image/", "video/", "audio/", "application/pdf", "application/zip"];

function isBinaryDeclaration(contentType: string): boolean {
  return BINARY_DECLARATIONS.some((prefix) =>
    prefix.endsWith("/") ? contentType.startsWith(prefix) : contentType === prefix,
  );
}

function isCompatibleSniff(sniffed: string, declared: string): boolean {
  if (sniffed === declared) return true;
  if (sniffed === "image/jpeg" && declared === "image/jpg") return true;
  if (sniffed === "video/mp4" && declared === "audio/mp4") return true;
  if (sniffed === "video/webm" && declared === "audio/webm") return true;
  return false;
}

/** prepare 時点の宣言値検証（サイズ・MIME・拡張子）。 */
export function assertUploadRequest(adapter: ServerUploaderAdapter, req: UploadRequest): void {
  if (!Number.isInteger(req.size) || req.size <= 0) {
    throw ApiError.validation("ファイルサイズが不正です");
  }
  if (req.size > adapter.limits.maxBytes) {
    throw new ApiError(
      413,
      ErrorCode.PAYLOAD_TOO_LARGE,
      `${adapter.label} の上限（${Math.floor(adapter.limits.maxBytes / 1024 / 1024)}MB）を超えています`,
    );
  }

  const contentType = req.contentType.split(";")[0]!.trim().toLowerCase();
  if (contentType === "image/svg+xml") {
    throw ApiError.validation("SVG はアップロードできません（スクリプト混入の危険があるため）");
  }
  if (!contentTypeMatches(contentType, adapter.limits.types)) {
    throw ApiError.validation(`${contentType} は ${adapter.label} では扱えません`);
  }

  if (req.filename.length > 200) throw ApiError.validation("ファイル名が長すぎます");
  if (/[\u0000-\u001f\u007f]/.test(req.filename)) throw ApiError.validation("ファイル名に制御文字は使えません");
  if (isBlockedUploadFilename(req.filename)) {
    throw ApiError.validation("実行ファイル・文書ファイルの拡張子はアップロードできません");
  }
  // 追加アダプタが極端に短い/長い MIME を許可していないか（多層防御）
  if (attachmentKindOf(contentType) === "file" && !contentType.includes("/")) {
    throw ApiError.validation("Content-Type が不正です");
  }
}

/**
 * ストリーム先頭のマジックバイトと宣言 MIME の整合を検証する。
 * 判定不能（テキスト等）で宣言がバイナリ系なら拒否する。
 */
export function assertSniffedContent(head: Uint8Array, contentType: string): void {
  const declared = contentType.split(";")[0]!.trim().toLowerCase();
  if (head.byteLength === 0) return;

  const sniffed = sniffContentType(head);
  if (sniffed) {
    if (isBinaryDeclaration(declared) && !isCompatibleSniff(sniffed, declared)) {
      throw ApiError.validation(`ファイル内容（${sniffed}）が宣言された形式（${declared}）と一致しません`);
    }
    return;
  }
  if (isBinaryDeclaration(declared)) {
    throw ApiError.validation(`ファイル内容が宣言された形式（${declared}）と一致しません`);
  }
}

/** proxy 中継で許可する上限（アダプタ上限とチケット宣言サイズの小さい方）。 */
export function proxyMaxBytes(adapter: ServerUploaderAdapter, declaredSize: number): number {
  return Math.min(adapter.limits.maxBytes, declaredSize);
}