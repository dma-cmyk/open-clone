// プラグイン作成トークン（`ocp_`）の発行・照合・失効。
//
// AI 運営キー（`services/ai/keys.ts` / `ocai_`）とは接頭辞で相互に区別する。
// 平文は発行応答に一度だけ含め、DB には SHA-256 ハッシュと表示用 prefix のみ保存する。
// 認証は「ハッシュ照合 → status → 期限 → アカウント状態」の順で、どの失敗も 401/403 に丸める。

import {
  ApiError,
  ErrorCode,
  PLUGIN_TOKEN_MAX_PER_ACCOUNT,
  PLUGIN_TOKEN_PREFIX,
  PLUGIN_TOKEN_PREFIX_DISPLAY_CHARS,
  PLUGIN_TOKEN_TTL_DAYS,
  randomToken,
  sha256Hex,
  ulid,
} from "shared";
import type { Env } from "../../lib/env";

const DAY_SECONDS = 86_400;

export interface PluginAuthorTokenRow {
  id: string;
  account_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  status: "active" | "revoked";
  expires_at: number;
  created_at: number;
  last_used_at: number | null;
}

export interface AuthenticatedPluginToken {
  id: string;
  accountId: string;
  name: string;
  prefix: string;
}

const TOKEN_COLUMNS = `id, account_id, name, token_hash, token_prefix, status, expires_at, created_at, last_used_at`;

/** `ocp_<43 文字の base64url>`（256 bit 乱数）。 */
export function generatePluginToken(): string {
  return `${PLUGIN_TOKEN_PREFIX}${randomToken(32)}`;
}

export function hashPluginToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** `Authorization: Bearer ocp_...` からトークンを取り出す（`ocai_` は受け付けない）。 */
export function parsePluginToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]!;
  return token.startsWith(PLUGIN_TOKEN_PREFIX) ? token : null;
}

/** 一覧表示用の prefix（`ocp_` + 8 文字）。トークン全体は再表示しない。 */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, PLUGIN_TOKEN_PREFIX.length + PLUGIN_TOKEN_PREFIX_DISPLAY_CHARS);
}

export interface CreatedPluginToken {
  row: PluginAuthorTokenRow;
  token: string;
}

/** 発行。上限（同時 5 本）超過は 409。平文は戻り値にのみ含まれる。 */
export async function createPluginToken(
  env: Env,
  accountId: string,
  name?: string,
): Promise<CreatedPluginToken> {
  const now = Math.floor(Date.now() / 1000);
  const token = generatePluginToken();
  const row: PluginAuthorTokenRow = {
    id: ulid(),
    account_id: accountId,
    name: name?.trim() || "プラグイン作成トークン",
    token_hash: await hashPluginToken(token),
    token_prefix: tokenDisplayPrefix(token),
    status: "active",
    expires_at: now + PLUGIN_TOKEN_TTL_DAYS * DAY_SECONDS,
    created_at: now,
    last_used_at: null,
  };

  // 上限判定と INSERT を 1 ステートメントにする。COUNT → INSERT の 2 文だと
  // 同時発行のリクエストがどれも同じ COUNT を見て上限を超える（M-1）。
  // SQLite/D1 は 1 ステートメントを直列化するため、条件付き INSERT なら
  // 有効本数が上限に達した後の行は挿入されない。
  const result = await env.DB.prepare(
    `INSERT INTO plugin_author_tokens (${TOKEN_COLUMNS})
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (
       SELECT COUNT(*) FROM plugin_author_tokens
       WHERE account_id = ? AND status = 'active' AND expires_at > ?
     ) < ?`,
  )
    .bind(
      row.id,
      row.account_id,
      row.name,
      row.token_hash,
      row.token_prefix,
      row.status,
      row.expires_at,
      row.created_at,
      row.last_used_at,
      accountId,
      now,
      PLUGIN_TOKEN_MAX_PER_ACCOUNT,
    )
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(
      409,
      ErrorCode.CONFLICT,
      `有効なトークンは ${PLUGIN_TOKEN_MAX_PER_ACCOUNT} 本までです。不要なトークンを失効してから発行してください`,
    );
  }

  return { row, token };
}

export async function listPluginTokens(env: Env, accountId: string): Promise<PluginAuthorTokenRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${TOKEN_COLUMNS} FROM plugin_author_tokens WHERE account_id = ? ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(accountId)
    .all<PluginAuthorTokenRow>();
  return result.results ?? [];
}

/** 個別失効。本人のトークンでなければ false（呼び出し側が 404 にする）。 */
export async function revokePluginToken(env: Env, accountId: string, id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE plugin_author_tokens SET status = 'revoked' WHERE id = ? AND account_id = ? AND status = 'active'",
  )
    .bind(id, accountId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 全失効（有効なもののみ）。失効した本数を返す。 */
export async function revokeAllPluginTokens(env: Env, accountId: string): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE plugin_author_tokens SET status = 'revoked' WHERE account_id = ? AND status = 'active'",
  )
    .bind(accountId)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * `/mcp-plugin` の Bearer 認証。
 * 失敗はすべて 401（存在を隠す）。アカウント停止のみ 403（利用者に理由を伝える必要がある）。
 */
export async function authenticatePluginToken(env: Env, token: string): Promise<AuthenticatedPluginToken> {
  const tokenHash = await hashPluginToken(token);
  const row = await env.DB.prepare(
    `SELECT t.*, a.status AS account_status
     FROM plugin_author_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE t.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<PluginAuthorTokenRow & { account_status: string }>();

  if (!row) throw ApiError.unauthorized("プラグイン作成トークンが不正です");
  if (row.status !== "active") {
    throw ApiError.unauthorized("このプラグイン作成トークンは失効しています");
  }
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at <= now) throw ApiError.unauthorized("このプラグイン作成トークンは期限切れです");
  if (row.account_status !== "active") {
    throw ApiError.forbidden("アカウントが利用停止中のため、このトークンは使えません");
  }

  // 監査・不審検知用。毎リクエストの書込を避けるため 60 秒に 1 回だけ更新する（AI キーと同じ）。
  if (row.last_used_at === null || now - row.last_used_at > 60) {
    await env.DB.prepare("UPDATE plugin_author_tokens SET last_used_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();
  }

  return { id: row.id, accountId: row.account_id, name: row.name, prefix: row.token_prefix };
}