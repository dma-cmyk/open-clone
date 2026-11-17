// パスワード再設定の失敗記録（auth_password_reset_attempts。migration 0616）。
// 鍵は「対象」単位（存在しないメールは入力を正規化した識別子）で、IP を変えた連打も数える。
// 生のメールは保存せず、auth_attempts と同じく HMAC(ID_SALT, ...) を使う。

import { hmacSha256Hex, randomToken, sha256Hex, ulid } from "shared";
import { normalizeEmail } from "../../lib/email";

/** 対象の識別子（存在しないメールは正規化したメール。ログインの照合と同じ正規化を使う）。 */
function passwordResetTargetKey(identifier: string): string {
  return `pwreset:${normalizeEmail(identifier)}`;
}

export async function passwordResetAttemptKey(idSalt: string, identifier: string): Promise<string> {
  return hmacSha256Hex(idSalt, passwordResetTargetKey(identifier));
}

export async function countPasswordResetFailures(
  db: D1Database,
  keyHash: string,
  since: number,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM auth_password_reset_attempts WHERE key_hash = ? AND created_at > ?")
    .bind(keyHash, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function recordPasswordResetFailure(
  db: D1Database,
  keyHash: string,
  id: string,
  now: number,
): Promise<void> {
  await db
    .prepare("INSERT INTO auth_password_reset_attempts (id, key_hash, created_at) VALUES (?, ?, ?)")
    .bind(id, keyHash, now)
    .run();
}

/** 期限切れ（24 時間）の試行記録を削除する。リクエストの waitUntil から呼ぶ。 */
export async function cleanupPasswordResetFailures(db: D1Database, now: number): Promise<void> {
  await db
    .prepare("DELETE FROM auth_password_reset_attempts WHERE created_at < ?")
    .bind(now - 86_400)
    .run();
}

// --- 運営が発行する 1 回限りの再設定 URL（password_reset_tokens） ------

export interface PasswordResetTokenRow {
  id: string;
  account_id: string;
  token_hash: string;
  issued_by: string;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface IssuedPasswordResetToken {
  id: string;
  /** 生トークン。この時点（発行レスポンス）だけで返し、DB にはハッシュしか残さない。 */
  token: string;
  expiresAt: number;
}

const TOKEN_PREFIX = "oc_pwr_";

/**
 * 新しい再設定トークンを発行する。
 * 同じアカウントの未使用トークンは発行時に失効させる（古い URL を無効化）。
 */
export async function issuePasswordResetToken(
  db: D1Database,
  accountId: string,
  issuedBy: string,
  now: number,
  ttlSeconds: number,
): Promise<IssuedPasswordResetToken> {
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const tokenHash = await sha256Hex(token);
  const id = ulid();
  const expiresAt = now + ttlSeconds;
  await db.batch([
    db
      .prepare(
        "UPDATE password_reset_tokens SET revoked_at = ? WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL",
      )
      .bind(now, accountId),
    db
      .prepare(
        "INSERT INTO password_reset_tokens (id, account_id, token_hash, issued_by, expires_at, used_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)",
      )
      .bind(id, accountId, tokenHash, issuedBy, expiresAt, now),
  ]);
  return { id, token, expiresAt };
}

/** 生トークンから行を引く（照合はハッシュ）。 */
export async function findPasswordResetToken(
  db: D1Database,
  token: string,
): Promise<PasswordResetTokenRow | null> {
  const tokenHash = await sha256Hex(token.trim());
  return db
    .prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<PasswordResetTokenRow>();
}

export type PasswordResetTokenState = "pending" | "used" | "revoked" | "expired";

export function passwordResetTokenState(row: PasswordResetTokenRow, now: number): PasswordResetTokenState {
  if (row.used_at !== null) return "used";
  if (row.revoked_at !== null) return "revoked";
  if (row.expires_at <= now) return "expired";
  return "pending";
}

/** 原子的に 1 回だけ消費する。既に使用済み・失効・期限切れなら false。 */
export async function consumePasswordResetToken(
  db: D1Database,
  id: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(now, id, now)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** 手動失効。未使用・未失効のときだけ true。 */
export async function revokePasswordResetToken(
  db: D1Database,
  id: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE password_reset_tokens SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
    )
    .bind(now, id)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function countOutstandingPasswordResetTokens(
  db: D1Database,
  accountId: string,
  now: number,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM password_reset_tokens WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(accountId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listOutstandingPasswordResetTokens(
  db: D1Database,
  accountId: string,
  now: number,
): Promise<PasswordResetTokenRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM password_reset_tokens WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    )
    .bind(accountId, now)
    .all<PasswordResetTokenRow>();
  return results;
}

/** 再設定 URL を組み立てる（web の静的ページ。トークンはクエリで渡す）。 */
export function buildPasswordResetUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/account/password-reset/confirm?token=${encodeURIComponent(token)}`;
}

/**
 * 所有者のメールソフトから送るための mailto: 雛形。
 * メールが届く＝そのアドレスの持ち主、という本人確認に使う（サイトからは自動送信しない）。
 */
export function buildPasswordResetMailto(email: string, url: string, expiresAt: number): string {
  const expires = new Date(expiresAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const subject = "【おーぷんクローン】パスワード再設定のご案内";
  const body = [
    "パスワード再設定のご依頼を受け付けました。",
    "",
    "次の URL を開いて、新しいパスワードを設定してください（1 回だけ使えます）。",
    url,
    "",
    `有効期限: ${expires}（この URL は 1 回だけ使えます）`,
    "",
    "お心当たりがない場合は、このメールを破棄してください。パスワードは変更されません。",
  ].join("\n");
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
