// リカバリーコード（10個・単回使用・SHA-256 ハッシュ保存）。
// 表示用コードは発行レスポンスでのみ返し、DB に平文は残さない。

import { batch } from "../../lib/db";
import { generateRecoveryCode, RECOVERY_CODE_COUNT, sha256Hex, ulid } from "shared";

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return sha256Hex(normalizeRecoveryCode(code));
}

/** 未使用コードを破棄して新しい 10 個を発行する（平文は戻り値のみ）。 */
export async function generateRecoveryCodes(db: D1Database, accountId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM recovery_codes WHERE account_id = ? AND used_at IS NULL").bind(accountId),
  ];
  for (const code of codes) {
    statements.push(
      db
        .prepare("INSERT INTO recovery_codes (id, account_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)")
        .bind(ulid(), accountId, await hashRecoveryCode(code), now),
    );
  }
  await batch(db, statements);
  return codes;
}

/** コードを単回消費する。成功時 true。 */
export async function consumeRecoveryCode(db: D1Database, accountId: string, code: string): Promise<boolean> {
  const codeHash = await hashRecoveryCode(code);
  const row = await db
    .prepare("SELECT id FROM recovery_codes WHERE account_id = ? AND code_hash = ? AND used_at IS NULL")
    .bind(accountId, codeHash)
    .first<{ id: string }>();
  if (!row) return false;
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(now, row.id)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function countRemainingRecoveryCodes(db: D1Database, accountId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE account_id = ? AND used_at IS NULL")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function clearRecoveryCodes(db: D1Database, accountId: string): Promise<void> {
  await db.prepare("DELETE FROM recovery_codes WHERE account_id = ?").bind(accountId).run();
}