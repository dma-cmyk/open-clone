// 検索（スレタイ / 全文 / ID / 画像）。FTS5 trigram を主経路とし、
// trigram が使えない 2 文字以下の語だけ LIKE にフォールバックする（DESIGN §A-3）。
// D1 の LIKE パターンは 50 バイト上限のため、LIKE は必ず短い語（<3 文字）に限定する。

import { Hono } from "hono";
import { ApiError, likeContains, likePrefix, ok } from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { assertReadRateLimit } from "../lib/do";
import { resolveBoardRow } from "../services/board/store";

const app = new Hono<AppEnv>();

const SEARCH_TYPES: Record<string, true> = { thread: true, full: true, id: true, image: true };

/** FTS5 の実用上限。これを超える検索語のみ 400（LIKE の 50 バイト制限とは無関係）。 */
const SEARCH_QUERY_MAX_CHARS = 200;
/** 短語 LIKE の最大語数（1 語 2 文字以下なのでパターンは常に 50 バイト未満）。 */
const SEARCH_LIKE_MAX_TERMS = 10;
/** 表示 ID は 4 文字。前方一致検索の暴走を防ぐ。 */
const SEARCH_ID_MAX_CHARS = 16;

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64").toString("utf8"));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function encodeOffset(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64");
}

interface ParsedSearchQuery {
  /** FTS5 に渡す式（3 文字以上の語のみ。`-` は除外） */
  ftsExpression: string;
  hasFtsTerms: boolean;
  /** trigram で扱えない 2 文字以下の語（LIKE 用） */
  likeTerms: string[];
}

/**
 * ユーザー入力を FTS5 式と短語 LIKE 語に分解する。
 * 3 文字以上の語が 1 つでもあれば FTS を使い、短語は無視する（trigram の制約）。
 * 全て 2 文字以下なら LIKE に回す（パターンは最大でも数バイト）。
 */
function parseSearchQuery(query: string, column?: string): ParsedSearchQuery {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const ftsParts: string[] = [];
  const likeTerms: string[] = [];
  for (const raw of terms) {
    const exclude = raw.startsWith("-");
    const term = (exclude ? raw.slice(1) : raw).replaceAll('"', "");
    if (term.length === 0) continue;
    if (Array.from(term).length >= 3) {
      const prefix = column ? `${column} : ` : "";
      ftsParts.push(`${exclude ? "NOT " : ""}${prefix}"${term}"`);
    } else if (!exclude) {
      likeTerms.push(term);
    }
  }
  return {
    ftsExpression: ftsParts.join(" AND "),
    hasFtsTerms: ftsParts.length > 0,
    likeTerms: likeTerms.slice(0, SEARCH_LIKE_MAX_TERMS),
  };
}



interface ThreadSearchRow {
  id: number;
  title: string;
  post_count: number;
  last_post_at: number;
  created_at: number;
  board_slug: string;
  board_name: string;
}

function finishThreadSearch(rows: ThreadSearchRow[], limit: number, offset: number, type: string) {
  const items = rows.slice(0, limit).map((row) => ({
    type: "thread" as const,
    thread: {
      id: row.id,
      title: row.title,
      postCount: row.post_count,
      lastPostAt: row.last_post_at,
      createdAt: row.created_at,
      boardSlug: row.board_slug,
      boardName: row.board_name,
    },
  }));
  const hasMore = rows.length > limit;
  return { ok: true as const, data: { type, items, nextCursor: hasMore ? encodeOffset(offset + limit) : null } };
}

/** 検索。`type=thread|full|id|image`。 */
app.get("/", async (c) => {
  // 読み取り系も IP 単位で抑制する（LIKE 全走査・D1 rows_read の枯渇対策 / H-3）。
  const reqCtx = getReqCtx(c);
  await assertReadRateLimit(c.env, "readSearch", reqCtx.device.ipHash);

  const db = c.env.DB;
  const rawQuery = (c.req.query("q") ?? "").trim();
  const type = c.req.query("type") ?? "thread";
  if (!SEARCH_TYPES[type]) throw ApiError.validation("type が不正です");
  if (rawQuery.length === 0) return c.json(ok({ items: [], nextCursor: null, type }));
  if (Array.from(rawQuery).length > SEARCH_QUERY_MAX_CHARS) {
    throw ApiError.validation(`検索語が長すぎます（${SEARCH_QUERY_MAX_CHARS} 文字以内）`);
  }
  if (type === "id" && Array.from(rawQuery).length > SEARCH_ID_MAX_CHARS) {
    throw ApiError.validation(`ID が長すぎます（${SEARCH_ID_MAX_CHARS} 文字以内）`);
  }

  const boardParam = c.req.query("board");
  const board = boardParam ? await resolveBoardRow(db, boardParam) : null;
  if (boardParam && !board) throw ApiError.notFound("板が見つかりません");
  const boardId = board?.id ?? null;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30), 1), 100);
  const offset = decodeOffset(c.req.query("cursor") ?? undefined);
  const boardCondition = boardId === null ? "" : " AND p.board_id = ?";
  const boardBindings = boardId === null ? [] : [boardId];
  const threadBoardCondition = boardId === null ? "" : " AND t.board_id = ?";

  if (type === "thread") {
    const parsed = parseSearchQuery(rawQuery, "title");
    if (parsed.hasFtsTerms) {
      try {
        const result = await db
          .prepare(
            `SELECT t.id, t.title, t.post_count, t.last_post_at, t.created_at, b.slug AS board_slug, b.name AS board_name
             FROM posts_fts
             JOIN posts p ON p.id = posts_fts.rowid
             JOIN threads t ON t.id = p.thread_id
             JOIN boards b ON b.id = t.board_id
             WHERE posts_fts MATCH ? AND p.num = 1 AND t.status = 'active'${boardCondition}
             ORDER BY rank LIMIT ? OFFSET ?`,
          )
          .bind(parsed.ftsExpression, ...boardBindings, limit + 1, offset)
          .all<ThreadSearchRow>();
        return c.json(finishThreadSearch(result.results, limit, offset, type));
      } catch (error) {
        // 不正な FTS 式でも 500 にしない（空結果を返す。サーバログに残す）。
        console.warn("thread FTS query failed", String(error));
        return c.json(ok({ type, items: [], nextCursor: null }));
      }
    }

    if (parsed.likeTerms.length === 0) return c.json(ok({ type, items: [], nextCursor: null }));
    const conditions = parsed.likeTerms.map(() => "t.title LIKE ? ESCAPE '\\'").join(" AND ");
    const bindings = parsed.likeTerms.map(likeContains);
    const result = await db
      .prepare(
        `SELECT t.id, t.title, t.post_count, t.last_post_at, t.created_at, b.slug AS board_slug, b.name AS board_name
         FROM threads t JOIN boards b ON b.id = t.board_id
         WHERE t.status = 'active' AND ${conditions}${threadBoardCondition}
         ORDER BY t.bump_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, ...(boardId === null ? [] : [boardId]), limit + 1, offset)
      .all<ThreadSearchRow>();
    return c.json(finishThreadSearch(result.results, limit, offset, type));
  }

  if (type === "id") {
    const result = await db
      .prepare(
        `SELECT p.id, p.thread_id, p.num, p.name, p.body, p.created_at, p.post_id_hash, t.title, b.slug AS board_slug, b.name AS board_name
         FROM posts p JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.id = p.board_id
         WHERE p.kind = 'post' AND p.hidden = 0 AND p.deleted = 0
           AND (p.post_id_hash = ? OR p.post_id_hash LIKE ? ESCAPE '\\')${boardCondition}
         ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(rawQuery, likePrefix(rawQuery), ...boardBindings, limit + 1, offset)
      .all<SearchPostRow>();
    return c.json(finishPostSearch(result.results, limit, offset, type));
  }

  if (type === "image") {
    const parsed = parseSearchQuery(rawQuery);
    if (parsed.hasFtsTerms) {
      try {
        const result = await db
          .prepare(
            `SELECT p.id, p.thread_id, p.num, p.name, p.body, p.created_at, p.post_id_hash, t.title, b.slug AS board_slug, b.name AS board_name
             FROM posts_fts
             JOIN posts p ON p.id = posts_fts.rowid
             JOIN threads t ON t.id = p.thread_id
             JOIN boards b ON b.id = p.board_id
             WHERE posts_fts MATCH ? AND p.kind = 'post' AND p.hidden = 0 AND p.deleted = 0
               AND p.attachments IS NOT NULL AND p.attachments != '[]'${boardCondition}
             ORDER BY rank LIMIT ? OFFSET ?`,
          )
          .bind(parsed.ftsExpression, ...boardBindings, limit + 1, offset)
          .all<SearchPostRow>();
        return c.json(finishPostSearch(result.results, limit, offset, type));
      } catch (error) {
        console.warn("image FTS query failed", String(error));
        return c.json(ok({ type, items: [], nextCursor: null }));
      }
    }
    if (parsed.likeTerms.length === 0) return c.json(ok({ type, items: [], nextCursor: null }));
    const conditions = parsed.likeTerms
      .map(() => "(p.body LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')")
      .join(" AND ");
    const bindings = parsed.likeTerms.flatMap((term) => [likeContains(term), likeContains(term)]);
    const result = await db
      .prepare(
        `SELECT p.id, p.thread_id, p.num, p.name, p.body, p.created_at, p.post_id_hash, t.title, b.slug AS board_slug, b.name AS board_name
         FROM posts p JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.id = p.board_id
         WHERE p.hidden = 0 AND p.deleted = 0 AND p.attachments IS NOT NULL AND p.attachments != '[]'
           AND ${conditions}${boardCondition}
         ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bindings, ...boardBindings, limit + 1, offset)
      .all<SearchPostRow>();
    return c.json(finishPostSearch(result.results, limit, offset, type));
  }

  // 全文検索: 3 文字以上は FTS5 trigram、全て 2 文字以下なら LIKE（短いパターンのみ）
  const parsed = parseSearchQuery(rawQuery);
  if (parsed.hasFtsTerms) {
    try {
      const result = await db
        .prepare(
          `SELECT p.id, p.thread_id, p.num, p.name, p.body, p.created_at, p.post_id_hash, t.title, b.slug AS board_slug, b.name AS board_name
           FROM posts_fts
           JOIN posts p ON p.id = posts_fts.rowid
           JOIN threads t ON t.id = p.thread_id
           JOIN boards b ON b.id = p.board_id
           WHERE posts_fts MATCH ? AND p.kind = 'post' AND p.hidden = 0 AND p.deleted = 0${boardCondition}
           ORDER BY rank LIMIT ? OFFSET ?`,
        )
        .bind(parsed.ftsExpression, ...boardBindings, limit + 1, offset)
        .all<SearchPostRow>();
      return c.json(finishPostSearch(result.results, limit, offset, type));
    } catch (error) {
      console.warn("full FTS query failed", String(error));
      return c.json(ok({ type, items: [], nextCursor: null }));
    }
  }

  if (parsed.likeTerms.length === 0) return c.json(ok({ type, items: [], nextCursor: null }));
  const conditions = parsed.likeTerms.map(() => "p.body LIKE ? ESCAPE '\\'").join(" AND ");
  const result = await db
    .prepare(
      `SELECT p.id, p.thread_id, p.num, p.name, p.body, p.created_at, p.post_id_hash, t.title, b.slug AS board_slug, b.name AS board_name
       FROM posts p JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.id = p.board_id
       WHERE p.kind = 'post' AND p.hidden = 0 AND p.deleted = 0 AND ${conditions}${boardCondition}
       ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...parsed.likeTerms.map(likeContains), ...boardBindings, limit + 1, offset)
    .all<SearchPostRow>();

  // 人気検索語（サジェスト）を遅延加算（レスポンスを待たせない）
  const normalized = rawQuery.slice(0, 60);
  c.executionCtx.waitUntil(
    db
      .prepare(
        `INSERT INTO counters (name, value, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at`,
      )
      .bind(`search:${normalized}`, Math.floor(Date.now() / 1000))
      .run()
      .catch(() => undefined),
  );

  return c.json(finishPostSearch(result.results, limit, offset, type));
});

interface SearchPostRow {
  id: number;
  thread_id: number;
  num: number;
  name: string;
  body: string;
  created_at: number;
  post_id_hash: string;
  title: string;
  board_slug: string;
  board_name: string;
}

function finishPostSearch(rows: SearchPostRow[], limit: number, offset: number, type: string, more?: boolean) {
  const items = rows.slice(0, limit).map((row) => ({
    type: "post" as const,
    post: {
      id: row.id,
      threadId: row.thread_id,
      num: row.num,
      name: row.name,
      body: row.body,
      createdAt: row.created_at,
      idHash: row.post_id_hash,
    },
    thread: {
      id: row.thread_id,
      title: row.title,
      boardSlug: row.board_slug,
      boardName: row.board_name,
    },
  }));
  const hasMore = more ?? rows.length > limit;
  return { ok: true as const, data: { type, items, nextCursor: hasMore ? encodeOffset(offset + limit) : null } };
}

/** 人気検索語（サジェスト）。 */
app.get("/suggest", async (c) => {
  const db = c.env.DB;
  const result = await db
    .prepare("SELECT name, value FROM counters WHERE name LIKE 'search:%' ORDER BY value DESC, updated_at DESC LIMIT 10")
    .all<{ name: string; value: number }>();
  return c.json(
    ok({
      items: result.results.map((row) => ({ term: row.name.slice("search:".length), count: row.value })),
    }),
  );
});

/** 検索対象の概要（UI のヒント用）。 */
app.get("/stats", async (c) => {
  const db = c.env.DB;
  const [threads, posts, boards] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM threads WHERE status = 'active'").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'post' AND deleted = 0").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM boards WHERE status = 'active'").first<{ n: number }>(),
  ]);
  void getReqCtx;
  return c.json(ok({ threads: threads?.n ?? 0, posts: posts?.n ?? 0, boards: boards?.n ?? 0 }));
});

export default app;