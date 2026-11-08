// ランキング（勢い・レス数・同時接続）とヘッドライン。
// index.ts が同じサブアプリを `/v1/ranking` と `/v1/headline` の両方に mount するため、
// ハンドラは `c.req.path` でどちらのマウントかを判定する。

import { Hono, type Context } from "hono";
import { ApiError, ok } from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { assertReadRateLimit } from "../lib/do";
import { resolveBoardRow } from "../services/board/store";

const app = new Hono<AppEnv>();

const PERIOD_SECONDS: Record<string, number> = {
  hour: 3600,
  day: 86_400,
  all: 0,
  "3h": 3 * 3600,
  "24h": 86_400,
  "7d": 7 * 86_400,
  "30d": 30 * 86_400,
};

interface RankingRow {
  id: number;
  title: string;
  post_count: number;
  last_post_at: number;
  created_at: number;
  board_slug: string;
  board_name: string;
  recent_posts: number;
}

interface SnapshotItem {
  threadId: number;
  connections: number;
}

async function loadConnectionSnapshot(db: D1Database, period: string): Promise<{ items: Map<number, number>; capturedAt: number | null }> {
  const row = await db
    .prepare("SELECT payload, captured_at FROM ranking_snapshots WHERE period = ? ORDER BY captured_at DESC LIMIT 1")
    .bind(period)
    .first<{ payload: string; captured_at: number }>();
  if (!row) return { items: new Map(), capturedAt: null };
  try {
    const parsed = JSON.parse(row.payload) as { items?: SnapshotItem[] };
    const items = new Map<number, number>();
    for (const item of parsed.items ?? []) items.set(item.threadId, item.connections);
    return { items, capturedAt: row.captured_at };
  } catch {
    return { items: new Map(), capturedAt: row.captured_at };
  }
}

/** ランキング（時間別・日別・総合）。指標はレス数 / 勢い / 同時接続。 */
async function handleRanking(c: Context<AppEnv>) {
  const db = c.env.DB;
  const period = c.req.query("period") ?? "day";
  if (!(period in PERIOD_SECONDS)) throw ApiError.validation("period が不正です");
  const metric = c.req.query("metric") ?? "speed";
  if (!["speed", "posts", "connections"].includes(metric)) throw ApiError.validation("metric が不正です");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const boardParam = c.req.query("board");
  const board = boardParam ? await resolveBoardRow(db, boardParam) : null;
  if (boardParam && !board) throw ApiError.notFound("板が見つかりません");

  const now = Math.floor(Date.now() / 1000);
  const since = PERIOD_SECONDS[period] === 0 ? 0 : now - PERIOD_SECONDS[period]!;
  const conditions = ["p.kind = 'post'", "p.hidden = 0", "p.deleted = 0", "t.status = 'active'"];
  const bindings: unknown[] = [];
  if (since > 0) {
    conditions.push("p.created_at >= ?");
    bindings.push(since);
  }
  if (board) {
    conditions.push("p.board_id = ?");
    bindings.push(board.id);
  }

  const result = await db
    .prepare(
      `SELECT t.id, t.title, t.post_count, t.last_post_at, t.created_at,
              b.slug AS board_slug, b.name AS board_name, COUNT(p.id) AS recent_posts
       FROM posts p JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.id = t.board_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY t.id
       ORDER BY recent_posts DESC, t.post_count DESC
       LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<RankingRow>();

  const snapshot = await loadConnectionSnapshot(db, period === "all" ? "day" : period);
  const items = result.results.map((row, index) => {
    const elapsedHours = Math.max(1, (now - Math.max(since, row.created_at)) / 3600);
    return {
      rank: index + 1,
      threadId: row.id,
      title: row.title,
      boardSlug: row.board_slug,
      boardName: row.board_name,
      postCount: row.post_count,
      recentPosts: row.recent_posts,
      speed: Math.round((row.recent_posts / elapsedHours) * 100) / 100,
      connections: snapshot.items.get(row.id) ?? 0,
      lastPostAt: row.last_post_at,
      createdAt: row.created_at,
    };
  });

  if (metric === "connections") items.sort((a, b) => b.connections - a.connections || b.recentPosts - a.recentPosts);
  if (metric === "posts") items.sort((a, b) => b.recentPosts - a.recentPosts || b.postCount - a.postCount);
  if (metric === "speed") items.sort((a, b) => b.speed - a.speed || b.recentPosts - a.recentPosts);
  items.forEach((item, index) => {
    item.rank = index + 1;
  });

  return c.json(
    ok({
      period,
      metric,
      boardId: board?.id ?? null,
      capturedAt: snapshot.capturedAt,
      items,
    }),
  );
}

/** ヘッドライン（板別・全体、期間・レス数フィルタ、ソート）。 */
async function handleHeadline(c: Context<AppEnv>) {
  const db = c.env.DB;
  const period = c.req.query("period") ?? "24h";
  if (!(period in PERIOD_SECONDS)) throw ApiError.validation("period が不正です");
  const sort = c.req.query("sort") ?? "bump";
  if (!["bump", "created", "posts", "speed"].includes(sort)) throw ApiError.validation("sort が不正です");
  const minPosts = Math.max(Number(c.req.query("minPosts") ?? 0), 0);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30), 1), 100);
  const boardParam = c.req.query("board");
  const board = boardParam ? await resolveBoardRow(db, boardParam) : null;
  if (boardParam && !board) throw ApiError.notFound("板が見つかりません");

  const now = Math.floor(Date.now() / 1000);
  const since = PERIOD_SECONDS[period] === 0 ? 0 : now - PERIOD_SECONDS[period]!;
  const conditions = ["t.status = 'active'"];
  const bindings: unknown[] = [];
  if (since > 0) {
    conditions.push("t.last_post_at >= ?");
    bindings.push(since);
  }
  if (board) {
    conditions.push("t.board_id = ?");
    bindings.push(board.id);
  }
  if (minPosts > 0) {
    conditions.push("t.post_count >= ?");
    bindings.push(minPosts);
  }

  let orderBy = "t.bump_at DESC";
  if (sort === "created") orderBy = "t.created_at DESC";
  if (sort === "posts") orderBy = "t.post_count DESC";
  if (sort === "speed") {
    orderBy = "(t.post_count * 3600.0 / MAX(1, ? - t.created_at)) DESC";
    bindings.push(now);
  }

  const result = await db
    .prepare(
      `SELECT t.id, t.title, t.post_count, t.last_post_at, t.created_at, t.live, t.pinned,
              b.slug AS board_slug, b.name AS board_name
       FROM threads t JOIN boards b ON b.id = t.board_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${orderBy} LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<{
      id: number;
      title: string;
      post_count: number;
      last_post_at: number;
      created_at: number;
      live: number;
      pinned: number;
      board_slug: string;
      board_name: string;
    }>();

  return c.json(
    ok({
      period,
      sort,
      boardId: board?.id ?? null,
      items: result.results.map((row) => ({
        threadId: row.id,
        title: row.title,
        boardSlug: row.board_slug,
        boardName: row.board_name,
        postCount: row.post_count,
        lastPostAt: row.last_post_at,
        createdAt: row.created_at,
        live: row.live === 1,
        pinned: row.pinned === 1,
        speed: Math.round((row.post_count * 3600 * 100) / Math.max(1, now - row.created_at)) / 100,
      })),
    }),
  );
}

app.get("/", async (c) => {
  // ランキング/ヘッドラインはトップ画面のポーリング対象。IP 単位で上限を付ける（H-3）。
  const reqCtx = getReqCtx(c);
  await assertReadRateLimit(c.env, "readRanking", reqCtx.device.ipHash);
  return c.req.path.startsWith("/v1/headline") ? handleHeadline(c) : handleRanking(c);
});

export default app;