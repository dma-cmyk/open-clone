// アカウント/端末の規制（suspensions）。
// site スコープは accounts.status と連動（停止時セッション失効・解除で復帰）。所有者は対象外。

import { ApiError, ulid, type Suspension, type SuspensionCreateRequest } from "shared";
import { revokeAllSessions } from "./session";

export interface SuspensionRow {
  id: string;
  account_id: string | null;
  email: string | null;
  device_hash: string | null;
  scope: "site" | "board";
  board_id: number | null;
  reason: string;
  by: string;
  expires_at: number | null;
  lifted_at: number | null;
  created_at: number;
}

function toSuspension(row: SuspensionRow, now: number): Suspension {
  const active = row.lifted_at === null && (row.expires_at === null || row.expires_at > now);
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    deviceHash: row.device_hash,
    scope: row.scope,
    boardId: row.board_id,
    reason: row.reason,
    by: row.by,
    expiresAt: row.expires_at,
    liftedAt: row.lifted_at,
    createdAt: row.created_at,
    active,
  };
}

export async function createSuspension(
  db: D1Database,
  input: SuspensionCreateRequest,
  by: string,
): Promise<Suspension> {
  const now = Math.floor(Date.now() / 1000);
  let accountId = input.accountId ?? null;
  let email = input.email ?? null;

  if (accountId) {
    const account = await db
      .prepare("SELECT id, email, role FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ id: string; email: string | null; role: string }>();
    if (!account) throw ApiError.notFound("アカウントが見つかりません");
    if (account.role === "owner") throw ApiError.forbidden("サイト所有者は停止できません");
    email = email ?? account.email;
  } else if (email) {
    const account = await db
      .prepare("SELECT id, email, role FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string | null; role: string }>();
    if (account) {
      if (account.role === "owner") throw ApiError.forbidden("サイト所有者は停止できません");
      accountId = account.id;
    }
  }

  const expiresAt =
    input.expiresAt ?? (input.durationHours !== undefined ? now + input.durationHours * 3600 : null);
  const id = ulid();
  await db
    .prepare(
      "INSERT INTO suspensions (id, account_id, email, device_hash, scope, board_id, reason, by, expires_at, lifted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(
      id,
      accountId,
      email,
      input.deviceHash ?? null,
      input.scope,
      input.boardId ?? null,
      input.reason,
      by,
      expiresAt,
      now,
    )
    .run();

  if (input.scope === "site" && accountId) {
    await db.prepare("UPDATE accounts SET status = 'suspended' WHERE id = ?").bind(accountId).run();
    await revokeAllSessions(db, accountId);
  }

  const row = await db.prepare("SELECT * FROM suspensions WHERE id = ?").bind(id).first<SuspensionRow>();
  if (!row) throw new Error("Failed to read created suspension");
  return toSuspension(row, now);
}

export async function liftSuspension(db: D1Database, id: string): Promise<Suspension | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT * FROM suspensions WHERE id = ?").bind(id).first<SuspensionRow>();
  if (!row) return null;
  if (row.lifted_at === null) {
    await db.prepare("UPDATE suspensions SET lifted_at = ? WHERE id = ? AND lifted_at IS NULL").bind(now, id).run();
  }
  if (row.scope === "site" && row.account_id) {
    const other = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM suspensions WHERE account_id = ? AND scope = 'site' AND id != ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      )
      .bind(row.account_id, id, now)
      .first<{ n: number }>();
    if ((other?.n ?? 0) === 0) {
      await db.prepare("UPDATE accounts SET status = 'active' WHERE id = ? AND role != 'owner'").bind(row.account_id).run();
    }
  }
  return toSuspension({ ...row, lifted_at: row.lifted_at ?? now }, now);
}

export interface SuspensionListOptions {
  page?: number;
  limit?: number;
  activeOnly?: boolean;
  accountId?: string;
}

export async function listSuspensions(
  db: D1Database,
  options: SuspensionListOptions = {},
): Promise<{ items: Suspension[]; total: number }> {
  const now = Math.floor(Date.now() / 1000);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const page = Math.max(options.page ?? 1, 1);
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];
  if (options.activeOnly) {
    conditions.push("lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)");
    bindings.push(now);
  }
  if (options.accountId) {
    conditions.push("account_id = ?");
    bindings.push(options.accountId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM suspensions ${where}`)
    .bind(...bindings)
    .first<{ n: number }>();
  const { results } = await db
    .prepare(`SELECT * FROM suspensions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, (page - 1) * limit)
    .all<SuspensionRow>();
  return { items: results.map((row) => toSuspension(row, now)), total: totalRow?.n ?? 0 };
}

/** ログイン時などの有効なサイト停止を探す（アカウント・メール・端末）。 */
export async function findActiveSiteSuspension(
  db: D1Database,
  params: { accountId?: string | null; email?: string | null; deviceHash?: string | null },
): Promise<SuspensionRow | null> {
  const now = Math.floor(Date.now() / 1000);
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  if (params.accountId) {
    clauses.push("account_id = ?");
    bindings.push(params.accountId);
  }
  if (params.email) {
    clauses.push("email = ?");
    bindings.push(params.email);
  }
  if (params.deviceHash) {
    clauses.push("device_hash = ?");
    bindings.push(params.deviceHash);
  }
  if (clauses.length === 0) return null;
  return db
    .prepare(
      `SELECT * FROM suspensions
       WHERE scope = 'site' AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (${clauses.join(" OR ")})
       LIMIT 1`,
    )
    .bind(now, ...bindings)
    .first<SuspensionRow>();
}

export async function countActiveSuspensions(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM suspensions WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
    .bind(now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}