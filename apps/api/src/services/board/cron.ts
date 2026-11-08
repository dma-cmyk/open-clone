// Cron ハンドラ（cron.ts から呼ばれる）。
// ①ランキング snapshot（毎時 5 分） ②板自動削除/prune（毎日 3:15）。
// 無料枠ガード: SELECT + 少量書込のみ（DESIGN §3.3）。

import { BOARD_AUTODELETE_DAYS, threadChannel } from "shared";
import type { Env } from "../../lib/env";
import { realtimeStub } from "../../lib/do";

interface SnapshotItem {
  threadId: number;
  connections: number;
}

/** RealtimeHub DO から同時接続数を取得する（失敗時は 0）。 */
async function readConnections(env: Env, threadId: number): Promise<number> {
  try {
    const response = await realtimeStub(env, threadChannel(threadId)).fetch(
      `https://do/stats?channel=${encodeURIComponent(threadChannel(threadId))}`,
    );
    if (!response.ok) return 0;
    const data = (await response.json()) as { connections?: number };
    return data.connections ?? 0;
  } catch {
    return 0;
  }
}

/** ランキング snapshot を作成する（period = hour / day）。 */
export async function runRankingSnapshot(env: Env): Promise<{ written: number; threads: number }> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const top = await db
    .prepare(
      `SELECT t.id AS thread_id, COUNT(p.id) AS recent
       FROM posts p JOIN threads t ON t.id = p.thread_id
       WHERE p.created_at >= ? AND p.kind = 'post' AND p.hidden = 0 AND p.deleted = 0 AND t.status = 'active'
       GROUP BY t.id ORDER BY recent DESC LIMIT 50`,
    )
    .bind(now - 3600)
    .all<{ thread_id: number; recent: number }>();

  const items: SnapshotItem[] = [];
  for (const row of top.results) {
    items.push({ threadId: row.thread_id, connections: await readConnections(env, row.thread_id) });
  }

  const payload = JSON.stringify({ items, capturedAt: now });
  const statements = [
    db.prepare("INSERT INTO ranking_snapshots (period, board_id, captured_at, payload) VALUES ('hour', NULL, ?, ?)").bind(now, payload),
    db.prepare("INSERT INTO ranking_snapshots (period, board_id, captured_at, payload) VALUES ('day', NULL, ?, ?)").bind(now, payload),
    db.prepare("DELETE FROM ranking_snapshots WHERE captured_at < ?").bind(now - 7 * 86_400),
  ];
  await db.batch(statements);
  return { written: 2, threads: items.length };
}

/** 板の自動削除と期限切れデータの prune。 */
export async function runPrune(env: Env): Promise<{
  deletedBoards: number;
  closedThreads: number;
  expiredBans: number;
}> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const boardThreshold = now - BOARD_AUTODELETE_DAYS * 86_400;

  const boards = await db
    .prepare(
      `UPDATE boards SET status = 'deleted'
       WHERE status = 'active' AND COALESCE(last_post_at, created_at) < ?`,
    )
    .bind(boardThreshold)
    .run();

  // `!timer` スレは作成 1 時間で消滅
  const threads = await db
    .prepare(
      `UPDATE threads SET status = 'deleted'
       WHERE status = 'active' AND title_flags LIKE '%"timer":true%' AND created_at < ?`,
    )
    .bind(now - 3600)
    .run();

  const bans = await db
    .prepare("DELETE FROM board_bans WHERE expires_at IS NOT NULL AND expires_at < ?")
    .bind(now)
    .run();

  return {
    deletedBoards: boards.meta.changes ?? 0,
    closedThreads: threads.meta.changes ?? 0,
    expiredBans: bans.meta.changes ?? 0,
  };
}