// 特別管理人の権限停止・復旧（所有者が最終権限を持つ）。
// role は accounts に保持し、停止フラグで管理 API を全拒否する。停止中も所有者は復旧できる。

import type { SpecialAdmin } from "shared";

export interface SpecialAdminState {
  accountId: string;
  stoppedAt: number | null;
  stoppedBy: string | null;
  reason: string | null;
  updatedAt: number;
}

interface SpecialAdminStateRow {
  account_id: string;
  stopped_at: number | null;
  stopped_by: string | null;
  reason: string | null;
  updated_at: number;
}

function toState(row: SpecialAdminStateRow): SpecialAdminState {
  return {
    accountId: row.account_id,
    stoppedAt: row.stopped_at,
    stoppedBy: row.stopped_by,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

export async function ensureSpecialAdminState(db: D1Database, accountId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO special_admin_state (account_id, stopped_at, stopped_by, reason, updated_at) VALUES (?, NULL, NULL, NULL, ?) ON CONFLICT(account_id) DO NOTHING",
    )
    .bind(accountId, now)
    .run();
}

export async function getSpecialAdminState(db: D1Database, accountId: string): Promise<SpecialAdminState | null> {
  const row = await db
    .prepare("SELECT * FROM special_admin_state WHERE account_id = ?")
    .bind(accountId)
    .first<SpecialAdminStateRow>();
  return row ? toState(row) : null;
}

/** 停止中なら停止理由を返す。稼働中・行なしは null。 */
export async function getSpecialAdminStop(db: D1Database, accountId: string): Promise<SpecialAdminState | null> {
  const state = await getSpecialAdminState(db, accountId);
  return state && state.stoppedAt !== null ? state : null;
}

export async function stopSpecialAdmin(
  db: D1Database,
  accountId: string,
  by: string,
  reason: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO special_admin_state (account_id, stopped_at, stopped_by, reason, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         stopped_at = excluded.stopped_at,
         stopped_by = excluded.stopped_by,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, now, by, reason, now)
    .run();
}

export async function restoreSpecialAdmin(db: D1Database, accountId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO special_admin_state (account_id, stopped_at, stopped_by, reason, updated_at)
       VALUES (?, NULL, NULL, NULL, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         stopped_at = NULL,
         stopped_by = NULL,
         reason = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, now)
    .run();
}

interface SpecialAdminListRow {
  id: string;
  name: string;
  email: string | null;
  status: "active" | "suspended";
  created_at: number;
  stopped_at: number | null;
  stopped_by: string | null;
  stop_reason: string | null;
  totp_verified: number | null;
  recovery_remaining: number;
}

export async function listSpecialAdmins(db: D1Database): Promise<SpecialAdmin[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.email, a.status, a.created_at,
              s.stopped_at, s.stopped_by, s.reason AS stop_reason,
              t.verified AS totp_verified,
              (SELECT COUNT(*) FROM recovery_codes rc WHERE rc.account_id = a.id AND rc.used_at IS NULL) AS recovery_remaining
       FROM accounts a
       LEFT JOIN special_admin_state s ON s.account_id = a.id
       LEFT JOIN account_totp t ON t.account_id = a.id
       WHERE a.role = 'special_admin'
       ORDER BY a.created_at DESC`,
    )
    .all<SpecialAdminListRow>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    stoppedAt: row.stopped_at,
    stoppedBy: row.stopped_by,
    stopReason: row.stop_reason,
    totpEnabled: row.totp_verified === 1,
    recoveryRemaining: row.recovery_remaining,
    createdAt: row.created_at,
  }));
}