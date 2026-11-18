// 板・投稿の内部サービス（CONTRACTS §12）。
// 投稿・スレ作成・つぶやきは `lib/pipeline.ts` を AI 運営（WP5）とルートが直接呼ぶ。
// ここには管理操作（非表示・削除）だけを公開し、契約文書と実装を一致させる。

import { ApiError } from "shared";
import type { Env } from "../../lib/env";
import type { WaitUntilContext } from "../../lib/pipeline";
import { publishToThreadAndBoard } from "./realtime";
import { POST_COLUMNS, assertThreadActive, getThreadRow, type PostRow } from "./store";

/** 内部サービス呼び出しに必要なバインディング。`ctx` があれば Realtime publisher を waitUntil で実行する。 */
export interface BoardServiceDeps {
  env: Env;
  ctx?: WaitUntilContext;
}

async function loadPostRow(db: D1Database, postId: number): Promise<PostRow> {
  const row = await db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).bind(postId).first<PostRow>();
  if (!row) throw ApiError.notFound("レスが見つかりません");
  return row;
}

/**
 * 削除板（`boards.status !== 'active'`）の内容は変更しない（K2 / T11-04）。
 * ルート・通報処理・AI など、呼び出し元によらず同じ結果にするため mutation の直前で検査する。
 */
export async function assertBoardContentWritable(db: D1Database, boardId: number): Promise<void> {
  const row = await db.prepare("SELECT status FROM boards WHERE id = ?").bind(boardId).first<{ status: string }>();
  if (!row) throw ApiError.notFound("板が見つかりません");
  if (row.status !== "active") throw ApiError.conflict("この板は削除されています");
}

/** レスを非表示にする（可逆・medium リスク）。 */
export async function hidePost(postId: number, deps: BoardServiceDeps): Promise<void> {
  const row = await loadPostRow(deps.env.DB, postId);
  await assertBoardContentWritable(deps.env.DB, row.board_id);
  // 削除済みスレの内容も変更しない（削除板と同じ 409。レビュー M2）。
  await assertThreadActive(await getThreadRow(deps.env.DB, row.thread_id));
  await deps.env.DB.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(postId).run();
  await publishToThreadAndBoard(deps.env, deps.ctx, row.thread_id, row.board_id, "post.hidden", {
    postId,
    threadId: row.thread_id,
    num: row.num,
  });
}

/** 非表示を解除する。 */
export async function unhidePost(postId: number, deps: BoardServiceDeps): Promise<void> {
  const row = await loadPostRow(deps.env.DB, postId);
  await assertBoardContentWritable(deps.env.DB, row.board_id);
  // 削除済みスレでは再表示もしない（非表示にする操作と同じ判定。レビュー M2）。
  await assertThreadActive(await getThreadRow(deps.env.DB, row.thread_id));
  await deps.env.DB.prepare("UPDATE posts SET hidden = 0 WHERE id = ?").bind(postId).run();
  await publishToThreadAndBoard(deps.env, deps.ctx, row.thread_id, row.board_id, "post.updated", {
    postId,
    threadId: row.thread_id,
    num: row.num,
    hidden: false,
  });
}

/** レスを削除する（不可逆・high リスク）。>>1 の削除はスレ削除になる。 */
export async function deletePost(postId: number, deps: BoardServiceDeps): Promise<void> {
  const db = deps.env.DB;
  const row = await loadPostRow(db, postId);
  await assertBoardContentWritable(db, row.board_id);
  const statements = [
    db.prepare("UPDATE posts SET deleted = 1, hidden = 1 WHERE id = ?").bind(postId),
    // スタッフ削除も不可逆: 履歴の旧本文を消す（本人削除と同じ扱い。履歴 API のガードと二重に防ぐ）。
    db.prepare("DELETE FROM post_edit_history WHERE post_id = ?").bind(postId),
  ];
  if (row.num === 1) {
    statements.push(db.prepare("UPDATE threads SET status = 'deleted' WHERE id = ?").bind(row.thread_id));
  } else if (row.kind === "post") {
    statements.push(
      db.prepare("UPDATE threads SET post_count = MAX(post_count - 1, 1) WHERE id = ?").bind(row.thread_id),
    );
  }
  await db.batch(statements);
  await publishToThreadAndBoard(deps.env, deps.ctx, row.thread_id, row.board_id, "post.deleted", {
    postId,
    threadId: row.thread_id,
    num: row.num,
  });
}