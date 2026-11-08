// 板・スレ・レス・スタッフ・アク禁の行マッパと基本クエリ。
// ルート/サービス双方が使う（D1 の生行 → shared の DTO）。

import {
  ApiError,
  boardDesignSchema,
  boardSettingsSchema,
  threadStateSchema,
  threadTitleFlagsSchema,
  type AttachmentSummary,
  type Board,
  type BoardDesign,
  type BoardSettings,
  type Post,
  type Thread,
  type ThreadState,
  type ThreadTitleFlags,
} from "shared";

export interface BoardRow {
  id: number;
  slug: string;
  name: string;
  category: string;
  description: string;
  rules_md: string;
  design: string;
  settings: string;
  owner_account_id: string | null;
  status: string;
  last_post_at: number | null;
  created_at: number;
}

export interface ThreadRow {
  id: number;
  board_id: number;
  title: string;
  title_flags: string;
  owner_device_hash: string | null;
  owner_account_id: string | null;
  live: number;
  post_count: number;
  max_posts: number;
  last_post_at: number;
  bump_at: number;
  pinned: number;
  status: string;
  created_at: number;
  board_slug: string;
  board_name: string;
}

export interface PostRow {
  id: number;
  thread_id: number;
  board_id: number;
  num: number;
  title: string | null;
  name: string;
  mail: string;
  trip: string | null;
  cap: string | null;
  body: string;
  sage: number;
  post_id_hash: string;
  device_hash: string;
  ip_hash: string;
  ninja_lv: number;
  kind: string;
  parent_post_id: number | null;
  attachments: string | null;
  hashtags: string | null;
  ai_agent_id: string | null;
  hidden: number;
  deleted: number;
  created_at: number;
}

export const BOARD_COLUMNS =
  "id, slug, name, category, description, rules_md, design, settings, owner_account_id, status, last_post_at, created_at";

export const THREAD_COLUMNS =
  "t.id, t.board_id, t.title, t.title_flags, t.owner_device_hash, t.owner_account_id, t.live, t.post_count, t.max_posts, t.last_post_at, t.bump_at, t.pinned, t.status, t.created_at, b.slug AS board_slug, b.name AS board_name";

export const POST_COLUMNS =
  "id, thread_id, board_id, num, title, name, mail, trip, cap, body, sage, post_id_hash, device_hash, ip_hash, ninja_lv, kind, parent_post_id, attachments, hashtags, ai_agent_id, hidden, deleted, created_at";

export const DEFAULT_SETTINGS: BoardSettings = boardSettingsSchema.parse({});
export const DEFAULT_DESIGN: BoardDesign = boardDesignSchema.parse({});
export const DEFAULT_THREAD_FLAGS: ThreadTitleFlags = threadTitleFlagsSchema.parse({});
export const DEFAULT_THREAD_STATE: ThreadState = threadStateSchema.parse({});

/** JSON カラムを安全にパースする（壊れたデータは既定値へフォールバック）。 */
export function parseJsonColumn<T>(raw: string | null, parse: (value: unknown) => T, fallback: T): T {
  if (!raw) return fallback;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return fallback;
  }
}

export function boardSettingsOf(row: BoardRow): BoardSettings {
  return parseJsonColumn(row.settings, (value) => boardSettingsSchema.parse(value), DEFAULT_SETTINGS);
}

export function boardDesignOf(row: BoardRow): BoardDesign {
  return parseJsonColumn(row.design, (value) => boardDesignSchema.parse(value), DEFAULT_DESIGN);
}

export function mapBoard(row: BoardRow): Board {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    description: row.description,
    rulesMd: row.rules_md,
    design: boardDesignOf(row),
    settings: boardSettingsOf(row),
    ownerAccountId: row.owner_account_id,
    status: row.status === "deleted" ? "deleted" : "active",
    lastPostAt: row.last_post_at,
    createdAt: row.created_at,
  };
}

export function mapThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    boardId: row.board_id,
    boardSlug: row.board_slug,
    boardName: row.board_name,
    title: row.title,
    titleFlags: parseJsonColumn(row.title_flags, (value) => threadTitleFlagsSchema.parse(value), DEFAULT_THREAD_FLAGS),
    live: row.live === 1,
    postCount: row.post_count,
    maxPosts: row.max_posts,
    lastPostAt: row.last_post_at,
    bumpAt: row.bump_at,
    pinned: row.pinned === 1,
    status: row.status === "deleted" ? "deleted" : row.status === "closed" ? "closed" : "active",
    createdAt: row.created_at,
  };
}

export function attachmentsOf(row: PostRow): AttachmentSummary[] {
  if (!row.attachments) return [];
  try {
    const parsed = JSON.parse(row.attachments) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        id: typeof item["id"] === "string" ? item["id"] : undefined,
        url: typeof item["url"] === "string" ? item["url"] : "",
        contentType: typeof item["contentType"] === "string" ? item["contentType"] : "application/octet-stream",
        size: typeof item["size"] === "number" ? item["size"] : 0,
        name: typeof item["name"] === "string" ? item["name"] : undefined,
      }));
  } catch {
    return [];
  }
}

export interface PostDecoration {
  /** スレの副主（device_hash）集合 */
  subHashes: ReadonlySet<string>;
  /** リクエスト主体が「いいね」した post id 集合 */
  likedIds: ReadonlySet<number>;
  /** post id → 逆参照元のレス番号 */
  backlinks: ReadonlyMap<number, number[]>;
}

export const EMPTY_DECORATION: PostDecoration = {
  subHashes: new Set(),
  likedIds: new Set(),
  backlinks: new Map(),
};

export function mapPost(row: PostRow, decoration: PostDecoration = EMPTY_DECORATION): Post {
  return {
    id: row.id,
    threadId: row.thread_id,
    boardId: row.board_id,
    num: row.num,
    kind: row.kind === "kome" ? "kome" : "post",
    name: row.name,
    mail: row.mail,
    trip: row.trip,
    cap: row.cap,
    body: row.body,
    createdAt: row.created_at,
    idHash: row.post_id_hash,
    sage: row.sage === 1,
    isOp: row.num === 1,
    isSub: decoration.subHashes.has(row.device_hash),
    attachments: attachmentsOf(row),
    likeCount: 0,
    liked: decoration.likedIds.has(row.id),
    backlinks: decoration.backlinks.get(row.id) ?? [],
    hidden: row.hidden === 1,
    aiAgentId: row.ai_agent_id,
  };
}

export async function getBoardRow(db: D1Database, id: number): Promise<BoardRow | null> {
  return db.prepare(`SELECT ${BOARD_COLUMNS} FROM boards WHERE id = ?`).bind(id).first<BoardRow>();
}

/** 数値 ID でもスラッグでも板を解決する（フロントはスラッグを使う）。 */
export async function resolveBoardRow(db: D1Database, idOrSlug: string | number): Promise<BoardRow | null> {
  const raw = String(idOrSlug);
  if (/^\d+$/.test(raw)) {
    return db.prepare(`SELECT ${BOARD_COLUMNS} FROM boards WHERE id = ?`).bind(Number(raw)).first<BoardRow>();
  }
  return db.prepare(`SELECT ${BOARD_COLUMNS} FROM boards WHERE slug = ?`).bind(raw).first<BoardRow>();
}

export async function getThreadRow(db: D1Database, id: number): Promise<ThreadRow | null> {
  return db
    .prepare(`SELECT ${THREAD_COLUMNS} FROM threads t JOIN boards b ON b.id = t.board_id WHERE t.id = ?`)
    .bind(id)
    .first<ThreadRow>();
}

export async function loadThreadState(db: D1Database, threadId: number): Promise<ThreadState> {
  const row = await db.prepare("SELECT state FROM thread_state WHERE thread_id = ?").bind(threadId).first<{ state: string }>();
  return parseJsonColumn(row?.state ?? null, (value) => threadStateSchema.parse(value), DEFAULT_THREAD_STATE);
}

export async function loadStaffLevel(
  db: D1Database,
  boardId: number,
  accountId: string | null | undefined,
): Promise<"admin" | "deputy" | "moderator" | null> {
  if (!accountId) return null;
  const row = await db
    .prepare("SELECT level FROM board_staff WHERE board_id = ? AND account_id = ?")
    .bind(boardId, accountId)
    .first<{ level: "admin" | "deputy" | "moderator" }>();
  return row?.level ?? null;
}

export async function loadSubHashes(db: D1Database, threadId: number): Promise<Set<string>> {
  const result = await db
    .prepare("SELECT identity_hash FROM thread_subs WHERE thread_id = ?")
    .bind(threadId)
    .all<{ identity_hash: string }>();
  return new Set(result.results.map((row) => row.identity_hash));
}

/** 指定 post id 群への逆参照（元レス番号）をまとめて引く。 */
export async function loadBacklinks(db: D1Database, postIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (postIds.length === 0) return map;
  const placeholders = postIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT bl.target_post_id AS target, p.num AS num
       FROM backlinks bl JOIN posts p ON p.id = bl.post_id
       WHERE bl.target_post_id IN (${placeholders}) AND p.deleted = 0
       ORDER BY p.num ASC`,
    )
    .bind(...postIds)
    .all<{ target: number; num: number }>();
  for (const row of result.results) {
    const list = map.get(row.target);
    if (list) list.push(row.num);
    else map.set(row.target, [row.num]);
  }
  return map;
}

/** 指定 post id 群への「いいね」数と、主体がいいね済みかをまとめて引く。 */
export async function loadReactionStats(
  db: D1Database,
  postIds: number[],
  identityHash: string,
): Promise<{ counts: Map<number, number>; liked: Set<number> }> {
  const counts = new Map<number, number>();
  const liked = new Set<number>();
  if (postIds.length === 0) return { counts, liked };
  const placeholders = postIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT post_id, COUNT(*) AS n, MAX(CASE WHEN identity_hash = ? THEN 1 ELSE 0 END) AS mine
       FROM post_reactions WHERE post_id IN (${placeholders})
       GROUP BY post_id`,
    )
    .bind(identityHash, ...postIds)
    .all<{ post_id: number; n: number; mine: number }>();
  for (const row of result.results) {
    counts.set(row.post_id, row.n);
    if (row.mine === 1) liked.add(row.post_id);
  }
  return { counts, liked };
}

export async function accountIdByName(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM accounts WHERE name = ?").bind(name).first<{ id: string }>();
  return row?.id ?? null;
}

export async function assertBoardActive(row: BoardRow | null): Promise<BoardRow> {
  if (!row) throw ApiError.notFound("板が見つかりません");
  if (row.status !== "active") throw new ApiError(409, "CONFLICT", "この板は削除されています");
  return row;
}

export async function assertThreadActive(row: ThreadRow | null): Promise<ThreadRow> {
  if (!row) throw ApiError.notFound("スレッドが見つかりません");
  if (row.status === "deleted") throw new ApiError(409, "CONFLICT", "このスレッドは削除されています");
  return row;
}