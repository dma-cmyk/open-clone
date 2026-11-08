// 添付メタデータの読み書き（D1 には URL とメタだけ。本体は保存しない）。

import { ulid, type AttachmentMeta } from "shared";
import { attachmentKindOf, type AttachmentDto } from "shared/schemas/upload";

export interface AttachmentRow {
  id: string;
  post_id: number | null;
  uploader_account_id: string | null;
  device_hash: string;
  board_id: number | null;
  adapter: string;
  external_url: string;
  delete_url: string | null;
  content_type: string;
  size: number;
  filename: string;
  kind: "image" | "video" | "audio" | "text" | "file";
  meta: string | null;
  status: "active" | "dead" | "deleted";
  last_verified_at: number | null;
  expires_at: number | null;
  ticket_id: string | null;
  created_at: number;
}

const SELECT_COLUMNS = `id, post_id, uploader_account_id, device_hash, board_id, adapter, external_url,
  delete_url, content_type, size, filename, kind, meta, status, last_verified_at, expires_at, ticket_id, created_at`;

export function toAttachmentDto(row: AttachmentRow, canDelete = false): AttachmentDto {
  return {
    id: row.id,
    postId: row.post_id,
    adapter: row.adapter,
    url: row.external_url,
    contentType: row.content_type,
    kind: row.kind,
    size: row.size,
    filename: row.filename,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    canDelete,
  };
}

export interface InsertAttachmentInput {
  postId?: number | null;
  accountId: string | null;
  deviceHash: string;
  boardId: number | null;
  adapterId: string;
  filename: string;
  meta: AttachmentMeta;
  ticketId: string;
  /** null = 恒久 */
  expiresAt?: number | null;
}

/** 添付メタを 1 行だけ書き込む。ticket_id の UNIQUE 制約で冪等（二重 commit は既存を返す）。 */
export async function insertAttachment(
  db: D1Database,
  input: InsertAttachmentInput,
): Promise<{ attachment: AttachmentDto; created: boolean }> {
  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
  const kind = attachmentKindOf(input.meta.contentType);
  try {
    await db
      .prepare(
        `INSERT INTO attachments
           (id, post_id, uploader_account_id, device_hash, board_id, adapter, external_url, delete_url,
            content_type, size, filename, kind, meta, status, expires_at, ticket_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .bind(
        id,
        input.postId ?? null,
        input.accountId,
        input.deviceHash,
        input.boardId,
        input.adapterId,
        input.meta.externalUrl,
        input.meta.deleteUrl ?? null,
        input.meta.contentType,
        input.meta.size,
        input.filename.slice(0, 200),
        kind,
        input.meta.meta ? JSON.stringify(input.meta.meta) : null,
        input.expiresAt ?? null,
        input.ticketId,
        now,
      )
      .run();
  } catch (error) {
    const existing = await db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM attachments WHERE ticket_id = ?`)
      .bind(input.ticketId)
      .first<AttachmentRow>();
    if (existing) return { attachment: toAttachmentDto(existing), created: false };
    throw error;
  }

  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM attachments WHERE id = ?`)
    .bind(id)
    .first<AttachmentRow>();
  if (!row) throw new Error("添付の書き込みを確認できませんでした");
  return { attachment: toAttachmentDto(row), created: true };
}

export async function getAttachmentRow(db: D1Database, id: string): Promise<AttachmentRow | null> {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM attachments WHERE id = ?`).bind(id).first<AttachmentRow>();
}

export async function getAttachmentByTicketId(db: D1Database, ticketId: string): Promise<AttachmentRow | null> {
  return db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM attachments WHERE ticket_id = ?`)
    .bind(ticketId)
    .first<AttachmentRow>();
}

export interface HistoryQuery {
  accountId: string | null;
  deviceHash: string;
  limit: number;
  boardId?: number;
  unattachedOnly?: boolean;
}

/** 自分のアップロード履歴（アカウント or 端末）。open2ch の画像履歴相当。 */
export async function listHistory(db: D1Database, query: HistoryQuery): Promise<AttachmentRow[]> {
  const conditions: string[] = ["status = 'active'"];
  const bindings: unknown[] = [];
  if (query.accountId) {
    conditions.push("uploader_account_id = ?");
    bindings.push(query.accountId);
  } else {
    conditions.push("device_hash = ?");
    bindings.push(query.deviceHash);
  }
  if (query.boardId) {
    conditions.push("board_id = ?");
    bindings.push(query.boardId);
  }
  if (query.unattachedOnly) conditions.push("post_id IS NULL");

  const result = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM attachments
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(...bindings, query.limit)
    .all<AttachmentRow>();
  return result.results;
}

/** 複数投稿の添付をまとめて取得する（WP1/WP2 のレス表示用。N+1 を避ける）。 */
export async function listAttachmentsForPosts(
  db: D1Database,
  postIds: number[],
): Promise<Record<number, AttachmentDto[]>> {
  const grouped: Record<number, AttachmentDto[]> = {};
  if (postIds.length === 0) return grouped;
  const placeholders = postIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM attachments
       WHERE post_id IN (${placeholders}) AND status = 'active'
       ORDER BY created_at ASC`,
    )
    .bind(...postIds)
    .all<AttachmentRow>();
  for (const row of result.results) {
    if (row.post_id === null) continue;
    (grouped[row.post_id] ??= []).push(toAttachmentDto(row));
  }
  return grouped;
}

export async function setAttachmentStatus(
  db: D1Database,
  id: string,
  status: "active" | "dead" | "deleted",
): Promise<void> {
  await db.prepare("UPDATE attachments SET status = ? WHERE id = ?").bind(status, id).run();
}

/** cron で死活確認する対象（未確認 or 24時間以上前の確認済み。期限切れは除外）。 */
export async function listAttachmentsForVerification(db: D1Database, limit: number): Promise<AttachmentRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const staleBefore = now - 24 * 3600;
  const result = await db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM attachments
       WHERE status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
         AND (last_verified_at IS NULL OR last_verified_at < ?)
       ORDER BY last_verified_at IS NOT NULL, last_verified_at ASC
       LIMIT ?`,
    )
    .bind(now, staleBefore, limit)
    .all<AttachmentRow>();
  return result.results;
}

export async function recordVerification(db: D1Database, id: string, alive: boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (alive) {
    await db.prepare("UPDATE attachments SET last_verified_at = ? WHERE id = ?").bind(now, id).run();
    return;
  }
  await db
    .prepare("UPDATE attachments SET status = 'dead', last_verified_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
}

/** 端末/アカウントあたりの直近アップロード数（RateLimiter DO が使えない場合のフォールバック）。 */
export async function countRecentUploads(
  db: D1Database,
  viewer: { accountId: string | null; deviceHash: string },
  since: number,
): Promise<number> {
  const statement = viewer.accountId
    ? db
        .prepare("SELECT COUNT(*) AS count FROM upload_tickets WHERE account_id = ? AND created_at >= ?")
        .bind(viewer.accountId, since)
    : db
        .prepare(
          "SELECT COUNT(*) AS count FROM upload_tickets WHERE account_id IS NULL AND device_hash = ? AND created_at >= ?",
        )
        .bind(viewer.deviceHash, since);
  const row = await statement.first<{ count: number }>();
  return row?.count ?? 0;
}