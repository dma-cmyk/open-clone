// アップロード許可証（ticket）。
// prepare で発行し、proxy / commit で消費する。ファイル本体は保存せず、許可した内容のメタだけを持つ。
// proxy の token は URL に載るため、D1 には SHA-256 のみ保存する。

import { ApiError, ErrorCode, randomToken, sha256Hex, ulid } from "shared";

export const UPLOAD_TICKET_TTL_SECONDS = 600;

export interface UploadTicketRow {
  id: string;
  adapter_id: string;
  mode: "direct" | "proxy-stream";
  device_hash: string;
  account_id: string | null;
  board_id: number | null;
  filename: string;
  content_type: string;
  size: number;
  purpose: string | null;
  status: "prepared" | "used" | "committed" | "expired";
  expires_at: number;
  used_at: number | null;
  result_url: string | null;
  result_delete_url: string | null;
  result_meta: string | null;
  created_at: number;
}

export interface CreateTicketInput {
  adapterId: string;
  mode: "direct" | "proxy-stream";
  deviceHash: string;
  accountId: string | null;
  boardId: number | null;
  filename: string;
  contentType: string;
  size: number;
  purpose: string | null;
}

export interface CreatedTicket {
  ticket: UploadTicketRow;
  /** proxy 用の一度きりトークン（D1 にはハッシュのみ） */
  token: string;
}

export async function createTicket(db: D1Database, input: CreateTicketInput): Promise<CreatedTicket> {
  const now = Math.floor(Date.now() / 1000);
  const id = ulid();
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const expiresAt = now + UPLOAD_TICKET_TTL_SECONDS;

  await db
    .prepare(
      `INSERT INTO upload_tickets
         (id, token_hash, adapter_id, mode, device_hash, account_id, board_id, filename, content_type,
          size, purpose, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
    )
    .bind(
      id,
      tokenHash,
      input.adapterId,
      input.mode,
      input.deviceHash,
      input.accountId,
      input.boardId,
      input.filename,
      input.contentType,
      input.size,
      input.purpose,
      expiresAt,
      now,
    )
    .run();

  return {
    ticket: {
      id,
      adapter_id: input.adapterId,
      mode: input.mode,
      device_hash: input.deviceHash,
      account_id: input.accountId,
      board_id: input.boardId,
      filename: input.filename,
      content_type: input.contentType,
      size: input.size,
      purpose: input.purpose,
      status: "prepared",
      expires_at: expiresAt,
      used_at: null,
      result_url: null,
      result_delete_url: null,
      result_meta: null,
      created_at: now,
    },
    token,
  };
}

export async function loadTicket(db: D1Database, ticketId: string): Promise<UploadTicketRow | null> {
  return db
    .prepare(
      `SELECT id, adapter_id, mode, device_hash, account_id, board_id, filename, content_type, size,
              purpose, status, expires_at, used_at, result_url, result_delete_url, result_meta, created_at
       FROM upload_tickets WHERE id = ?`,
    )
    .bind(ticketId)
    .first<UploadTicketRow>();
}

/** チケットの所有者（アカウント or 端末）を検証する。 */
export function assertTicketOwner(
  ticket: UploadTicketRow,
  viewer: { accountId: string | null; deviceHash: string },
): void {
  if (ticket.account_id) {
    if (viewer.accountId !== ticket.account_id) {
      throw ApiError.forbidden("このアップロードは別のアカウントのものです");
    }
    return;
  }
  if (ticket.device_hash !== viewer.deviceHash) {
    throw ApiError.forbidden("このアップロードは別の端末のものです");
  }
}

export function assertTicketUsable(ticket: UploadTicketRow, now = Math.floor(Date.now() / 1000)): void {
  if (ticket.status === "expired" || ticket.expires_at <= now) {
    throw new ApiError(410, ErrorCode.NOT_FOUND, "アップロードの有効期限が切れています。もう一度やり直してください");
  }
  if (ticket.status === "committed") {
    throw ApiError.conflict("このアップロードは既に確定しています");
  }
}

/** proxy の token を検証する（URL に載るためハッシュ比較）。 */
export async function assertTicketToken(db: D1Database, ticketId: string, token: string): Promise<void> {
  const row = await db
    .prepare("SELECT token_hash FROM upload_tickets WHERE id = ?")
    .bind(ticketId)
    .first<{ token_hash: string }>();
  if (!row) throw ApiError.notFound("アップロードが見つかりません");
  const hash = await sha256Hex(token);
  if (hash !== row.token_hash) throw ApiError.forbidden("アップロードトークンが不正です");
}

/** proxy 完了時に結果を保存し、チケットを used にする（二重使用は 409）。 */
export async function markTicketUsed(
  db: D1Database,
  ticketId: string,
  result: { url: string; deleteUrl?: string; meta?: Record<string, unknown> },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const response = await db
    .prepare(
      `UPDATE upload_tickets
       SET status = 'used', used_at = ?, result_url = ?, result_delete_url = ?, result_meta = ?
       WHERE id = ? AND status = 'prepared'`,
    )
    .bind(now, result.url, result.deleteUrl ?? null, result.meta ? JSON.stringify(result.meta) : null, ticketId)
    .run();
  if ((response.meta.changes ?? 0) === 0) {
    throw ApiError.conflict("このアップロードは既に使用されています");
  }
}

export async function markTicketCommitted(db: D1Database, ticketId: string): Promise<void> {
  await db
    .prepare("UPDATE upload_tickets SET status = 'committed' WHERE id = ? AND status IN ('prepared', 'used')")
    .bind(ticketId)
    .run();
}

/** 期限切れチケットの掃除（cron）。 */
export async function expireStaleTickets(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const response = await db
    .prepare("UPDATE upload_tickets SET status = 'expired' WHERE status = 'prepared' AND expires_at <= ?")
    .bind(now)
    .run();
  return response.meta.changes ?? 0;
}