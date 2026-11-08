// AI の読み取り経路（WP1 のテーブルに対する読み取り専用 SQL）。
// 書き込みは WP1 の内部関数（createPost/hidePost/deletePost/setBoardStaff）を通す。
// 投稿本文はすべて `<untrusted_content>` で包み、AI への応答で「データ」であることを明示する
// （DESIGN §10.5-1）。

import {
  ApiError,
  likeContains,
  wrapUntrustedContent,
  type AiActionName,
} from "shared";
import type { Env } from "../../lib/env";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

interface Cursor {
  id?: number;
  bump?: number;
  at?: number;
}

export function encodeCursor(value: Cursor): string {
  return btoa(JSON.stringify(value));
}

function decodeCursor(cursor: string | undefined): Cursor {
  if (!cursor) return {};
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    if (!parsed || typeof parsed !== "object") return {};
    const result: Cursor = {};
    if ("id" in parsed && typeof parsed.id === "number") result.id = parsed.id;
    if ("bump" in parsed && typeof parsed.bump === "number") result.bump = parsed.bump;
    if ("at" in parsed && typeof parsed.at === "number") result.at = parsed.at;
    return result;
  } catch {
    return {};
  }
}

/** WP1 のスキーマ未適用を、内部情報を漏らさない 503 に変換する。 */
function dependencyError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table|no such column/i.test(message)) {
    console.error("AI_READ_DEPENDENCY", message);
    throw new ApiError(503, "MISCONFIGURED", "掲示板コアのスキーマが未適用です（WP1 のマイグレーションを適用してください）");
  }
  throw error;
}

async function query<T>(env: Env, sql: string, ...bindings: unknown[]): Promise<T[]> {
  try {
    const result = await env.DB.prepare(sql)
      .bind(...bindings)
      .all<T>();
    return result.results ?? [];
  } catch (error) {
    dependencyError(error);
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
}

function wrapBody(body: unknown, postId: number): string {
  return wrapUntrustedContent(typeof body === "string" ? body : "", { type: "post", id: postId });
}

// ─────────────────────────── 板 ───────────────────────────

interface BoardRow {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  rules_md: string | null;
  settings: string | null;
  last_post_at: number | null;
  created_at: number | null;
}

const BOARD_COLUMNS = "id, slug, name, category, description, rules_md, settings, last_post_at, created_at";

export interface BoardView {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  rules: string | null;
  settings: string | null;
  lastPostAt: number | null;
  createdAt: number | null;
}

function mapBoard(row: BoardRow): BoardView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    description: row.description,
    rules: row.rules_md,
    settings: row.settings,
    lastPostAt: row.last_post_at,
    createdAt: row.created_at,
  };
}

export async function listBoards(
  env: Env,
  input: { category?: string; limit?: number; cursor?: string },
): Promise<{ items: BoardView[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const bindings: unknown[] = [];
  let where = "WHERE 1 = 1";
  if (input.category) {
    where += " AND category = ?";
    bindings.push(input.category);
  }
  if (cursor.id !== undefined) {
    where += " AND id > ?";
    bindings.push(cursor.id);
  }
  const rows = await query<BoardRow>(
    env,
    `SELECT ${BOARD_COLUMNS} FROM boards ${where} ORDER BY id ASC LIMIT ?`,
    ...bindings,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map(mapBoard),
    nextCursor: rows.length > limit ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
  };
}

export async function getBoard(env: Env, input: { boardId?: number; slug?: string }): Promise<BoardView> {
  const row = input.boardId
    ? await query<BoardRow>(env, `SELECT ${BOARD_COLUMNS} FROM boards WHERE id = ?`, input.boardId)
    : input.slug
      ? await query<BoardRow>(env, `SELECT ${BOARD_COLUMNS} FROM boards WHERE slug = ?`, input.slug)
      : [];
  if (row.length === 0) throw ApiError.notFound("板が見つかりません");
  return mapBoard(row[0]!);
}

// ─────────────────────────── スレッド ───────────────────────────

interface ThreadRow {
  id: number;
  board_id: number;
  title: string;
  post_count: number | null;
  last_post_at: number | null;
  bump_at: number | null;
  pinned: number | null;
  status: string | null;
  live: number | null;
  max_posts: number | null;
}

const THREAD_COLUMNS = "id, board_id, title, post_count, last_post_at, bump_at, pinned, status, live, max_posts";

export interface ThreadView {
  id: number;
  boardId: number;
  title: string;
  postCount: number | null;
  lastPostAt: number | null;
  bumpAt: number | null;
  pinned: boolean;
  status: string | null;
  live: boolean;
  maxPosts: number | null;
}

function mapThread(row: ThreadRow): ThreadView {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    postCount: row.post_count,
    lastPostAt: row.last_post_at,
    bumpAt: row.bump_at,
    pinned: Boolean(row.pinned),
    status: row.status,
    live: Boolean(row.live),
    maxPosts: row.max_posts,
  };
}

export async function listThreads(
  env: Env,
  boardId: number,
  input: { limit?: number; cursor?: string },
): Promise<{ items: ThreadView[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const rows = await query<ThreadRow>(
    env,
    `SELECT ${THREAD_COLUMNS} FROM threads
     WHERE board_id = ? AND (? = 0 OR bump_at < ? OR (bump_at = ? AND id < ?))
     ORDER BY bump_at DESC, id DESC LIMIT ?`,
    boardId,
    cursor.bump ?? 0,
    cursor.bump ?? 0,
    cursor.bump ?? 0,
    cursor.id ?? Number.MAX_SAFE_INTEGER,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(mapThread),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ bump: last.bump_at ?? 0, id: last.id })
        : null,
  };
}

export async function getThread(env: Env, threadId: number): Promise<ThreadView> {
  const rows = await query<ThreadRow>(env, `SELECT ${THREAD_COLUMNS} FROM threads WHERE id = ?`, threadId);
  if (rows.length === 0) throw ApiError.notFound("スレッドが見つかりません");
  return mapThread(rows[0]!);
}

// ─────────────────────────── レス ───────────────────────────

interface PostRow {
  id: number;
  thread_id: number;
  board_id: number;
  num: number | null;
  name: string | null;
  mail: string | null;
  trip: string | null;
  body: string | null;
  post_id_hash: string | null;
  kind: string | null;
  parent_post_id: number | null;
  attachments: string | null;
  created_at: number | null;
}

const POST_COLUMNS =
  "id, thread_id, board_id, num, name, mail, trip, body, post_id_hash, kind, parent_post_id, attachments, created_at";

export interface PostView {
  id: number;
  threadId: number;
  boardId: number;
  num: number | null;
  name: string | null;
  mail: string | null;
  trip: string | null;
  body: string;
  displayId: string | null;
  kind: string | null;
  parentPostId: number | null;
  attachments: string | null;
  createdAt: number | null;
}

function mapPost(row: PostRow): PostView {
  return {
    id: row.id,
    threadId: row.thread_id,
    boardId: row.board_id,
    num: row.num,
    name: row.name,
    mail: row.mail,
    trip: row.trip,
    body: wrapBody(row.body, row.id),
    displayId: row.post_id_hash,
    kind: row.kind,
    parentPostId: row.parent_post_id,
    attachments: row.attachments,
    createdAt: row.created_at,
  };
}

export async function listPosts(
  env: Env,
  threadId: number,
  input: { afterPostId?: number; limit?: number },
): Promise<PostView[]> {
  const limit = clampLimit(input.limit);
  return (
    await query<PostRow>(
      env,
      `SELECT ${POST_COLUMNS} FROM posts WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      threadId,
      input.afterPostId ?? 0,
      limit,
    )
  ).map(mapPost);
}

export async function getPost(env: Env, postId: number): Promise<PostView> {
  const rows = await query<PostRow>(env, `SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`, postId);
  if (rows.length === 0) throw ApiError.notFound("レスが見つかりません");
  return mapPost(rows[0]!);
}

export async function searchPosts(
  env: Env,
  input: { q: string; boardId?: number; threadId?: number; limit?: number; cursor?: string },
): Promise<{ items: PostView[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const bindings: unknown[] = [likeContains(input.q)];
  let where = "WHERE body LIKE ? ESCAPE '\\'";
  if (input.boardId !== undefined) {
    where += " AND board_id = ?";
    bindings.push(input.boardId);
  }
  if (input.threadId !== undefined) {
    where += " AND thread_id = ?";
    bindings.push(input.threadId);
  }
  if (cursor.id !== undefined) {
    where += " AND id < ?";
    bindings.push(cursor.id);
  }
  const rows = await query<PostRow>(
    env,
    `SELECT ${POST_COLUMNS} FROM posts ${where} ORDER BY id DESC LIMIT ?`,
    ...bindings,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(mapPost),
    nextCursor: rows.length > limit && last ? encodeCursor({ id: last.id }) : null,
  };
}

// ─────────────────────────── 投稿監視フィード ───────────────────────────

export async function monitorFeed(
  env: Env,
  input: { boardId?: number; limit?: number; cursor?: string },
): Promise<{ items: (PostView & { event: string })[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const bindings: unknown[] = [];
  let where = "WHERE 1 = 1";
  if (input.boardId !== undefined) {
    where += " AND board_id = ?";
    bindings.push(input.boardId);
  }
  if (cursor.id !== undefined) {
    where += " AND id > ?";
    bindings.push(cursor.id);
  }
  const rows = await query<PostRow>(
    env,
    `SELECT ${POST_COLUMNS} FROM posts ${where} ORDER BY id ASC LIMIT ?`,
    ...bindings,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({ ...mapPost(row), event: "post.created" })),
    nextCursor: rows.length > limit ? encodeCursor({ id: page[page.length - 1]!.id }) : null,
  };
}

// ─────────────────────────── 通報 ───────────────────────────

interface ReportRow {
  id: string;
  board_id?: number | null;
  status?: string | null;
  reason?: string | null;
  post_id?: number | null;
  thread_id?: number | null;
  created_at?: number | null;
}

export interface ReportView {
  id: string;
  boardId: number | null;
  status: string | null;
  postId: number | null;
  threadId: number | null;
  createdAt: number | null;
  reason: string | null;
  triage: { priority: string; verdict: string | null; note: string | null } | null;
}

function mapReport(
  row: ReportRow,
  triage?: { priority: string; verdict: string | null; note: string | null },
): ReportView {
  return {
    id: row.id,
    boardId: row.board_id ?? null,
    status: row.status ?? null,
    postId: row.post_id ?? null,
    threadId: row.thread_id ?? null,
    createdAt: row.created_at ?? null,
    reason:
      typeof row.reason === "string" ? wrapUntrustedContent(row.reason, { type: "report", id: row.id }) : null,
    triage: triage ?? null,
  };
}

export async function listReports(
  env: Env,
  input: { boardId?: number; status?: string; limit?: number; cursor?: string },
): Promise<{ items: ReportView[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const bindings: unknown[] = [];
  let where = "WHERE 1 = 1";
  if (input.boardId !== undefined) {
    where += " AND r.board_id = ?";
    bindings.push(input.boardId);
  }
  if (input.status) {
    where += " AND r.status = ?";
    bindings.push(input.status);
  }
  if (cursor.id !== undefined) {
    where += " AND r.rowid > ?";
    bindings.push(cursor.id);
  }
  const rows = await query<ReportRow & { rowid: number; triage_priority: string | null; triage_verdict: string | null; triage_note: string | null }>(
    env,
    `SELECT r.*, r.rowid AS rowid, t.priority AS triage_priority, t.verdict AS triage_verdict, t.note AS triage_note
     FROM reports r LEFT JOIN ai_report_triage t ON t.report_id = r.id
     ${where} ORDER BY r.rowid ASC LIMIT ?`,
    ...bindings,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) =>
      mapReport(
        row,
        row.triage_priority
          ? { priority: row.triage_priority, verdict: row.triage_verdict, note: row.triage_note }
          : undefined,
      ),
    ),
    nextCursor: rows.length > limit ? encodeCursor({ id: page[page.length - 1]!.rowid }) : null,
  };
}

export async function getReport(env: Env, reportId: string): Promise<ReportView> {
  const rows = await query<ReportRow & { triage_priority: string | null; triage_verdict: string | null; triage_note: string | null }>(
    env,
    `SELECT r.*, t.priority AS triage_priority, t.verdict AS triage_verdict, t.note AS triage_note
     FROM reports r LEFT JOIN ai_report_triage t ON t.report_id = r.id WHERE r.id = ?`,
    reportId,
  );
  if (rows.length === 0) throw ApiError.notFound("通報が見つかりません");
  const row = rows[0]!;
  return mapReport(
    row,
    row.triage_priority
      ? { priority: row.triage_priority, verdict: row.triage_verdict, note: row.triage_note }
      : undefined,
  );
}

// ─────────────────────────── 統計 ───────────────────────────

export async function boardStats(
  env: Env,
  boardId?: number,
): Promise<{ boardId: number | null; posts: number; threads: number }> {
  const scope = boardId === undefined ? "" : "WHERE board_id = ?";
  const bindings = boardId === undefined ? [] : [boardId];
  const posts = await query<{ count: number }>(
    env,
    `SELECT COUNT(*) AS count FROM posts ${scope}`,
    ...bindings,
  );
  const threads = await query<{ count: number }>(
    env,
    `SELECT COUNT(*) AS count FROM threads ${scope}`,
    ...bindings,
  );
  return { boardId: boardId ?? null, posts: posts[0]?.count ?? 0, threads: threads[0]?.count ?? 0 };
}

/**
 * action の対象板を解決する（boardId を持たない action 用）。
 * 対象レコードが存在しない場合は 404、WP1 スキーマ未適用なら 503。
 */
export async function resolveTargetBoard(
  env: Env,
  action: AiActionName,
  params: Record<string, unknown>,
): Promise<number | null> {
  const boardId = params.boardId;
  if (typeof boardId === "number") return boardId;

  if (action === "post.create" || action === "post.reply") {
    if (typeof params.threadId === "number") {
      const rows = await query<{ board_id: number }>(
        env,
        "SELECT board_id FROM threads WHERE id = ?",
        params.threadId,
      );
      if (rows.length === 0) throw ApiError.notFound("スレッドが見つかりません");
      return rows[0]!.board_id;
    }
    return null;
  }
  if (
    action === "post.get" ||
    action === "post.hide" ||
    action === "post.mark_spam" ||
    action === "post.delete"
  ) {
    if (typeof params.postId !== "number") return null;
    const rows = await query<{ board_id: number }>(
      env,
      "SELECT board_id FROM posts WHERE id = ?",
      params.postId,
    );
    if (rows.length === 0) throw ApiError.notFound("レスが見つかりません");
    return rows[0]!.board_id;
  }
  if (action === "thread.get" || action === "thread.live_off" || action === "thread.delete") {
    if (typeof params.threadId !== "number") return null;
    const rows = await query<{ board_id: number }>(
      env,
      "SELECT board_id FROM threads WHERE id = ?",
      params.threadId,
    );
    if (rows.length === 0) throw ApiError.notFound("スレッドが見つかりません");
    return rows[0]!.board_id;
  }
  if (action === "post.list") {
    if (typeof params.threadId !== "number") return null;
    const rows = await query<{ board_id: number }>(
      env,
      "SELECT board_id FROM threads WHERE id = ?",
      params.threadId,
    );
    if (rows.length === 0) throw ApiError.notFound("スレッドが見つかりません");
    return rows[0]!.board_id;
  }
  if (action === "report.get" && typeof params.reportId === "string") {
    const rows = await query<{ board_id: number | null }>(
      env,
      "SELECT board_id FROM reports WHERE id = ?",
      params.reportId,
    );
    if (rows.length > 0 && typeof rows[0]!.board_id === "number") return rows[0]!.board_id;
    return null;
  }
  return null;
}