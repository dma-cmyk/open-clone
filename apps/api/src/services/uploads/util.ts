// アダプタ共通の小さなユーティリティ（URL 抽出・base64url・ホスト検証）。

import { ApiError, ErrorCode } from "shared";

const URL_PATTERN = /https?:\/\/[^\s"'<>\\]+/i;

/** 応答テキストから最初の http(s) URL を取り出す（Catbox/Litterbox は URL を平文で返す）。 */
export function extractFirstUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text.trim());
  if (!match) return null;
  return match[0].replace(/[.,)]+$/, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

/** URL のホストが許可リストに完全一致することを検証する（commit の URL 偽装防止）。 */
export function assertAllowedHost(url: string, allowedHosts: readonly string[], label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ApiError.validation(`${label} の URL が不正です`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw ApiError.validation("http(s) 以外の URL は保存できません");
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw ApiError.validation(`${label} の保存先ホスト（${parsed.hostname}）は許可されていません`);
  }
}

/**
 * 上流応答が失敗なら ApiError に変換する。
 * 外部サービスの生メッセージは details に短く載せる（内部情報は含めない）。
 */
export function assertUpstreamOk(response: Response, label: string): void {
  if (response.ok) return;
  const status = response.status;
  if (status === 413) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, `${label} がファイルサイズ上限を超えています`);
  }
  if (status === 429) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, `${label} 側のレート制限に達しました。時間をおいて再試行してください`);
  }
  throw new ApiError(502, ErrorCode.BAD_GATEWAY, `${label} へのアップロードに失敗しました（HTTP ${status}）`);
}

/** JSON からドットパス（`data.url` 等）を取り出す。 */
export function readJsonPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** ブラウザ直送向けのヘッダから、Worker が付与してはいけないものを除去する（CORS 制約の回避）。 */
export function publicHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowered = key.toLowerCase();
    if (lowered === "host" || lowered === "content-length" || lowered === "origin") continue;
    result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}