// セッション（乱数トークン・SHA-256 保存・30日スライディング）。
// WP0 の requestContext と互換の形（sessions テーブル + accounts join）で検証結果を返す。

import { randomToken, SESSION_TTL_DAYS, sha256Hex, type AuthAccount } from "shared";

export const SESSION_SECONDS = SESSION_TTL_DAYS * 86_400;

export interface SessionVerification {
  tokenHash: string;
  account: AuthAccount;
  expiresAt: number;
}

export interface CreatedSession {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

export async function createSession(
  db: D1Database,
  accountId: string,
  userAgent: string | null,
): Promise<CreatedSession> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + SESSION_SECONDS;
  await db
    .prepare("INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(tokenHash, accountId, expiresAt, userAgent, now, now)
    .run();
  return { token, tokenHash, expiresAt };
}

/** 生トークンを検証する。無効・期限切れなら null。 */
export async function verifySession(db: D1Database, token: string): Promise<SessionVerification | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `SELECT s.expires_at, a.id, a.name, a.email, a.role, a.status
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, now)
    .first<{
      expires_at: number;
      id: string;
      name: string;
      email: string | null;
      role: AuthAccount["role"];
      status: AuthAccount["status"];
    }>();
  if (!row) return null;
  return {
    tokenHash,
    expiresAt: row.expires_at,
    account: { id: row.id, name: row.name, email: row.email, role: row.role, status: row.status },
  };
}

export async function revokeSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash),
    db.prepare("DELETE FROM session_stepup WHERE token_hash = ?").bind(tokenHash),
  ]);
}

/** 指定アカウントのセッションを全失効する（現在のセッションを残す場合は except を渡す）。 */
export async function revokeAllSessions(
  db: D1Database,
  accountId: string,
  exceptTokenHash?: string,
): Promise<number> {
  const result = exceptTokenHash
    ? await db.prepare("DELETE FROM sessions WHERE account_id = ? AND token_hash != ?").bind(accountId, exceptTokenHash).run()
    : await db.prepare("DELETE FROM sessions WHERE account_id = ?").bind(accountId).run();
  await db.prepare("DELETE FROM session_stepup WHERE account_id = ?").bind(accountId).run();
  return result.meta.changes ?? 0;
}

export interface SessionRow {
  token_hash: string;
  ua: string | null;
  created_at: number;
  touched_at: number;
  expires_at: number;
}

export async function listSessions(db: D1Database, accountId: string): Promise<SessionRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await db
    .prepare(
      "SELECT token_hash, ua, created_at, touched_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY touched_at DESC",
    )
    .bind(accountId, now)
    .all<SessionRow>();
  return results;
}

export async function countActiveSessions(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?")
    .bind(now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}