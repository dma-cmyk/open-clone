// 一回限りの就任キー（invites）。
// 生キーは発行時のみ返し、DB には SHA-256 ハッシュのみ保存する。使用は原子的に 1 回だけ。

import { INVITE_TTL_HOURS, randomToken, sha256Hex, ulid } from "shared";
import type {
  InviteInspect,
  InviteIssueResult,
  InviteKind,
  InviteSummary,
} from "shared";

export interface InviteRow {
  id: string;
  kind: InviteKind;
  key_hash: string;
  issued_by: string;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
  revoked_at: number | null;
  meta: string | null;
  created_at: number;
}

export interface InviteMeta {
  note?: string;
  accountId?: string;
  boardId?: number;
  level?: "admin" | "deputy" | "moderator";
}

export interface InviteOptions {
  expiresInHours?: number;
  note?: string;
  accountId?: string;
  boardId?: number;
  level?: "admin" | "deputy" | "moderator";
}

function parseMeta(raw: string | null): InviteMeta {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null ? (value as InviteMeta) : {};
  } catch {
    return {};
  }
}

export async function issueInvite(
  db: D1Database,
  kind: InviteKind,
  issuedBy: string,
  options: InviteOptions = {},
): Promise<InviteIssueResult> {
  const hours = options.expiresInHours ?? INVITE_TTL_HOURS;
  const key = `oc_inv_${randomToken(24)}`;
  const keyHash = await sha256Hex(key);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + hours * 3600;
  const id = ulid();
  const meta: InviteMeta = {};
  if (options.note !== undefined) meta.note = options.note;
  if (options.accountId !== undefined) meta.accountId = options.accountId;
  if (options.boardId !== undefined) meta.boardId = options.boardId;
  if (options.level !== undefined) meta.level = options.level;

  await db
    .prepare(
      "INSERT INTO invites (id, kind, key_hash, issued_by, expires_at, used_at, used_by, revoked_at, meta, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
    )
    .bind(id, kind, keyHash, issuedBy, expiresAt, Object.keys(meta).length ? JSON.stringify(meta) : null, now)
    .run();

  return {
    id,
    key,
    kind,
    expiresAt,
    acceptPath: `/admin/invites/accept?key=${encodeURIComponent(key)}`,
  };
}

export async function findInviteByKey(db: D1Database, key: string): Promise<InviteRow | null> {
  const keyHash = await sha256Hex(key.trim());
  return db.prepare("SELECT * FROM invites WHERE key_hash = ?").bind(keyHash).first<InviteRow>();
}

export function inviteState(row: InviteRow, now: number): InviteSummary["state"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.used_at !== null) return "used";
  if (row.expires_at <= now) return "expired";
  return "pending";
}

export function inviteSummary(row: InviteRow, now: number): InviteSummary {
  const meta = parseMeta(row.meta);
  return {
    id: row.id,
    kind: row.kind,
    note: meta.note ?? null,
    issuedBy: row.issued_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    state: inviteState(row, now),
  };
}

/** 就任フォームの事前確認。アカウント作成前は氏名・メールを一切返さない。 */
export async function inspectInvite(db: D1Database, key: string): Promise<InviteInspect> {
  const row = await findInviteByKey(db, key);
  const now = Math.floor(Date.now() / 1000);
  if (!row) {
    return {
      valid: false,
      kind: null,
      expiresAt: null,
      note: null,
      accountName: null,
      email: null,
      reason: "キーが存在しません",
    };
  }
  const state = inviteState(row, now);
  const meta = parseMeta(row.meta);
  const base: InviteInspect = {
    valid: state === "pending",
    kind: row.kind,
    expiresAt: row.expires_at,
    note: meta.note ?? null,
    accountName: null,
    email: null,
    reason:
      state === "used"
        ? "このキーは既に使用済みです"
        : state === "revoked"
          ? "このキーは失効しています"
          : state === "expired"
            ? "このキーの有効期限が切れています"
            : null,
  };
  if (state === "pending" && meta.accountId) {
    const account = await db
      .prepare("SELECT name, email FROM accounts WHERE id = ?")
      .bind(meta.accountId)
      .first<{ name: string; email: string | null }>();
    if (account) {
      base.accountName = account.name;
      base.email = account.email;
    }
  }
  return base;
}

/** キーを原子的に消費する。既に使用済み・失効・期限切れなら false。 */
export async function consumeInvite(db: D1Database, inviteId: string, usedBy: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .bind(now, usedBy, inviteId, now)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function listInvites(db: D1Database, limit = 100): Promise<InviteRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM invites ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<InviteRow>();
  return results;
}

export async function revokeInvite(db: D1Database, id: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL")
    .bind(now, id)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function countPendingInvites(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .bind(now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 再招待（既存アカウント復旧）時に meta.boardId / level を参照するためのヘルパ。 */
export function inviteMeta(row: InviteRow): InviteMeta {
  return parseMeta(row.meta);
}