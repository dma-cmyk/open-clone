// スレ一覧・レス取得（範囲指定 / since / ID 抽出 / ワード抽出 / 画像のみ）。

import {
  PAGE_LIMIT_MAX,
  likeContains,
  likePrefix,
  parsePostRange,
  type Post,
  type ThreadPostsQuery,
  type ThreadSummary,
} from "shared";
import {
  POST_COLUMNS,
  THREAD_COLUMNS,
  loadBacklinks,
  loadReactionStats,
  loadSubHashes,
  mapPost,
  mapThread,
  type PostRow,
  type ThreadRow,
} from "./store";

export interface ThreadListQuery {
  sort: "bump" | "speed" | "created" | "posts";
  q?: string | undefined;
  tag?: string | undefined;
  cursor?: string | undefined;
  limit: number;
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

/** 板内スレ一覧（カーソルページング）。 */
export async function listThreads(
  db: D1Database,
  boardId: number,
  query: ThreadListQuery,
): Promise<{ items: ThreadSummary[]; nextCursor: string | null }> {
  const conditions = ["t.board_id = ?", "t.status = 'active'"];
  const bindings: unknown[] = [boardId];
  let orderBy = "t.pinned DESC, t.bump_at DESC, t.id DESC";
  if (query.sort === "created") orderBy = "t.pinned DESC, t.created_at DESC, t.id DESC";
  if (query.sort === "posts") orderBy = "t.pinned DESC, t.post_count DESC, t.id DESC";
  if (query.sort === "speed") {
    orderBy = "t.pinned DESC, (t.post_count * 3600.0 / MAX(1, ? - t.created_at)) DESC, t.id DESC";
    bindings.push(Math.floor(Date.now() / 1000));
  }

  if (query.q) {
    conditions.push("t.title LIKE ? ESCAPE '\\'");
    bindings.push(likeContains(query.q));
  }
  if (query.tag) {
    conditions.push(
      "EXISTS (SELECT 1 FROM thread_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.thread_id = t.id AND g.name = ?)",
    );
    bindings.push(query.tag.toLowerCase());
  }

  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    const at = Number(cursor["at"] ?? 0);
    const id = Number(cursor["id"] ?? 0);
    if (query.sort === "created") {
      conditions.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
      bindings.push(at, at, id);
    } else if (query.sort === "posts") {
      conditions.push("(t.post_count < ? OR (t.post_count = ? AND t.id < ?))");
      bindings.push(at, at, id);
    } else {
      conditions.push("(t.bump_at < ? OR (t.bump_at = ? AND t.id < ?))");
      bindings.push(at, at, id);
    }
  }

  const limit = Math.min(Math.max(query.limit, 1), PAGE_LIMIT_MAX);
  const result = await db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM threads t JOIN boards b ON b.id = t.board_id
       WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`,
    )
    .bind(...bindings, limit + 1)
    .all<ThreadRow>();

  const rows = result.results.slice(0, limit);
  const items: ThreadSummary[] = rows.map((row) => {
    const thread = mapThread(row);
    return {
      id: thread.id,
      boardId: thread.boardId,
      boardSlug: thread.boardSlug,
      boardName: thread.boardName,
      title: thread.title,
      postCount: thread.postCount,
      lastPostAt: thread.lastPostAt,
      createdAt: thread.createdAt,
      live: thread.live,
      pinned: thread.pinned,
      status: thread.status,
    };
  });

  let nextCursor: string | null = null;
  if (result.results.length > limit && rows.length > 0) {
    const last = rows[rows.length - 1]!;
    const at = query.sort === "created" ? last.created_at : query.sort === "posts" ? last.post_count : last.bump_at;
    nextCursor = encodeCursor({ at, id: last.id });
  }
  return { items, nextCursor };
}

export interface LoadedPosts {
  posts: Post[];
  hasMore: boolean;
}

/** スレ内のレスを範囲指定で取得し、いいね・逆参照・副主表示を付与する。 */
export async function loadThreadPosts(
  db: D1Database,
  thread: ThreadRow,
  query: ThreadPostsQuery,
  identityHash: string,
): Promise<LoadedPosts> {
  const conditions = ["thread_id = ?", "kind = 'post'", "hidden = 0", "deleted = 0"];
  const bindings: unknown[] = [thread.id];
  let orderBy = "num ASC";
  let limit = Math.min(query.limit ?? 50, PAGE_LIMIT_MAX);
  let hasMore = false;

  if (query.since !== undefined) {
    conditions.push("id > ?");
    bindings.push(query.since);
    orderBy = "id ASC";
    limit = Math.min(query.limit ?? PAGE_LIMIT_MAX, PAGE_LIMIT_MAX);
  } else {
    const range = parsePostRange(query.r, thread.post_count);
    if (range.nums) {
      conditions.push(`num IN (${range.nums.map(() => "?").join(",")})`);
      bindings.push(...range.nums);
      limit = range.nums.length;
    } else if (range.mode === "last") {
      orderBy = "num DESC";
      limit = range.limit;
    } else if (range.from !== null) {
      conditions.push("num >= ?");
      bindings.push(range.from);
      if (range.to !== null) {
        conditions.push("num <= ?");
        bindings.push(range.to);
      }
      limit = range.limit;
    }
  }

  if (query.id) {
    conditions.push("(post_id_hash = ? OR post_id_hash LIKE ? ESCAPE '\\')");
    bindings.push(query.id, likePrefix(query.id));
  }
  if (query.q) {
    conditions.push("body LIKE ? ESCAPE '\\'");
    bindings.push(likeContains(query.q));
  }
  if (query.images) {
    conditions.push("attachments IS NOT NULL AND attachments != '[]'");
  }

  const result = await db
    .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`)
    .bind(...bindings, limit + 1)
    .all<PostRow>();

  const rows = result.results.slice(0, limit);
  if (orderBy === "num DESC") rows.reverse();
  hasMore = result.results.length > limit;

  const ids = rows.map((row) => row.id);
  const [subHashes, reactions, backlinks] = await Promise.all([
    loadSubHashes(db, thread.id),
    loadReactionStats(db, ids, identityHash),
    loadBacklinks(db, ids),
  ]);

  const posts = rows.map((row) => {
    const post = mapPost(row, { subHashes, likedIds: reactions.liked, backlinks });
    return { ...post, likeCount: reactions.counts.get(row.id) ?? 0 };
  });

  return { posts, hasMore };
}