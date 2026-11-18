// 全員から非表示にしたレスの一覧（板の管理画面・サイト管理画面）。
// 対象は `hidden = 1 AND deleted = 0`。削除は `hidden = 1, deleted = 1` になるため含めない。
// 非表示にした日時・した人は監査ログ（post.hide / post.restore）から引く。
// 監査ログを書き始める前の非表示は記録が無いので null（画面は「不明」と表示する）。

import { HIDDEN_POST_EXCERPT_CHARS, type HiddenPostItem } from "shared";

export interface HiddenPostListOptions {
  /** 板で絞り込む（板の管理画面は必須、サイト管理画面は任意）。 */
  boardId?: number;
  limit: number;
  cursor?: string | undefined;
}

interface HiddenPostRow {
  id: number;
  board_id: number;
  thread_id: number;
  num: number;
  name: string;
  body: string;
  created_at: number;
  board_slug: string;
  board_name: string;
  board_status: "active" | "deleted";
  thread_title: string;
}

interface HiddenAuditRow {
  target: string | null;
  action: string;
  created_at: number;
  actor_name: string | null;
}

function encodeCursor(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 200 文字に切る（絵文字などのサロゲートペアの途中では切らない）。 */
function excerptOf(body: string): string {
  if (body.length <= HIDDEN_POST_EXCERPT_CHARS) return body;
  return body.slice(0, HIDDEN_POST_EXCERPT_CHARS).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * 指定 post id 群について、最後に記録された hide / restore を引く。
 * D1 のバインド上限を超えないよう 50 件ずつに分ける。
 */
async function loadHiddenAudit(
  db: D1Database,
  postIds: number[],
): Promise<Map<number, HiddenAuditRow>> {
  const latest = new Map<number, HiddenAuditRow>();
  for (let offset = 0; offset < postIds.length; offset += 50) {
    const chunk = postIds.slice(offset, offset + 50);
    if (chunk.length === 0) continue;
    const result = await db
      .prepare(
        `SELECT a.target, a.action, a.created_at, acc.name AS actor_name
         FROM audit_log a LEFT JOIN accounts acc ON acc.id = a.actor_id
         WHERE a.action IN ('post.hide', 'post.restore') AND a.target IN (${chunk.map(() => "?").join(",")})
         ORDER BY a.created_at DESC, a.id DESC`,
      )
      .bind(...chunk.map((id) => String(id)))
      .all<HiddenAuditRow>();
    for (const row of result.results) {
      const postId = Number(row.target);
      if (!Number.isInteger(postId) || latest.has(postId)) continue;
      latest.set(postId, row);
    }
  }
  return latest;
}

/** 非表示レス一覧（新しい順・カーソルページング）。 */
export async function listHiddenPosts(
  db: D1Database,
  options: HiddenPostListOptions,
): Promise<{ items: HiddenPostItem[]; nextCursor: string | null }> {
  const conditions = [
    "p.hidden = 1",
    "p.deleted = 0",
    // 本人削除は本文を消して「投稿者により削除されました」に置き換える（self_delete）。
    // 再表示しても意味が無いため一覧に出さない（deleted=1 と同じ扱い。レビュー M1）。
    "p.self_deleted = 0",
    // 削除済みスレは GET /v1/threads/:id がスタッフにも 409 を返す（削除板と違い
    // K2 の「スタッフは読める」例外が無い）。一覧にも出さない（レビュー M2）。
    "t.status != 'deleted'",
  ];
  const bindings: unknown[] = [];
  if (options.boardId !== undefined) {
    conditions.push("p.board_id = ?");
    bindings.push(options.boardId);
  }
  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    const at = Number(cursor["at"] ?? 0);
    const id = Number(cursor["id"] ?? 0);
    conditions.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
    bindings.push(at, at, id);
  }

  const result = await db
    .prepare(
      `SELECT p.id, p.board_id, p.thread_id, p.num, p.name, p.body, p.created_at,
              b.slug AS board_slug, b.name AS board_name, b.status AS board_status,
              t.title AS thread_title
       FROM posts p
       JOIN boards b ON b.id = p.board_id
       JOIN threads t ON t.id = p.thread_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ?`,
    )
    .bind(...bindings, options.limit + 1)
    .all<HiddenPostRow>();

  const rows = result.results.slice(0, options.limit);
  const audit = await loadHiddenAudit(
    db,
    rows.map((row) => row.id),
  );
  const items: HiddenPostItem[] = rows.map((row) => {
    // 最後の操作が restore なら、現在の hidden=1 は記録より前の非表示（または記録外）なので不明扱い。
    const entry = audit.get(row.id);
    const hide = entry?.action === "post.hide" ? entry : null;
    return {
      postId: row.id,
      boardId: row.board_id,
      boardSlug: row.board_slug,
      boardName: row.board_name,
      boardStatus: row.board_status,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      num: row.num,
      name: row.name,
      excerpt: excerptOf(row.body),
      createdAt: row.created_at,
      hiddenAt: hide?.created_at ?? null,
      hiddenByName: hide?.actor_name ?? null,
    };
  });

  let nextCursor: string | null = null;
  const last = rows[rows.length - 1];
  if (result.results.length > options.limit && last) {
    nextCursor = encodeCursor({ at: last.created_at, id: last.id });
  }
  return { items, nextCursor };
}