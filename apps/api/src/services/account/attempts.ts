// ログイン/登録試行の短期記録（IP+メール毎の HMAC キー）。
// 生 IP・生メールは保存しない。レート制限と Turnstile 段階要求の判定に使う。

import { sha256Hex, ulid } from "shared";

export type AttemptKind =
  | "login_failed"
  | "login_ok"
  | "register"
  | "totp_failed"
  /** 就任キー accept の TOTP 失敗（キー単位・IP 単位の総当たり対策 / H-1） */
  | "invite_failed"
  /** prepare-totp の発行（無制限発行の抑止 / H-1） */
  | "invite_prepare";

export async function attemptKey(ipHash: string, identifier: string): Promise<string> {
  return sha256Hex(`${ipHash}|${identifier.trim().toLowerCase()}`);
}

export async function recordAttempt(
  db: D1Database,
  kind: AttemptKind,
  keyHash: string,
  accountId?: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("INSERT INTO auth_attempts (id, kind, key_hash, account_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(ulid(), kind, keyHash, accountId ?? null, now)
    .run();
}

export async function countAttemptsSince(
  db: D1Database,
  kinds: AttemptKind[],
  keyHash: string,
  since: number,
): Promise<number> {
  const placeholders = kinds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM auth_attempts WHERE kind IN (${placeholders}) AND key_hash = ? AND created_at > ?`,
    )
    .bind(...kinds, keyHash, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 古い試行記録を削除する（24時間より前）。リクエストの waitUntil から呼ぶ。 */
export async function cleanupOldAttempts(db: D1Database): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 86_400;
  await db.prepare("DELETE FROM auth_attempts WHERE created_at < ?").bind(cutoff).run();
}