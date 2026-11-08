// AI API キーの生成・ハッシュ・抽出。
// 平文キーは発行/ローテーション応答に一度だけ含め、DB には SHA-256 ハッシュと表示用 prefix のみ保存する。

import { randomToken, sha256Hex } from "shared";

export const AI_KEY_PREFIX = "ocai_";

/** `ocai_<43 文字の base64url>` を生成する（256 bit 乱数）。 */
export function generateApiKey(): string {
  return `${AI_KEY_PREFIX}${randomToken(32)}`;
}

export async function hashApiKey(apiKey: string): Promise<string> {
  return sha256Hex(apiKey);
}

/** 一覧表示用の識別子（キー全体は再表示しない）。 */
export function apiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, AI_KEY_PREFIX.length + 8);
}

/** `Authorization: Bearer ocai_...` からキーを取り出す。形式不正は null。 */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]!;
  return token.startsWith(AI_KEY_PREFIX) ? token : null;
}