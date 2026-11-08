// 通報（削除依頼）API。作成（匿名可・Turnstile）/ 一覧 / 詳細 / 処理。

import { Hono } from "hono";
import {
  ApiError,
  ErrorCode,
  REPORT_REASON_LABELS,
  createReportRequestSchema,
  handleReportRequestSchema,
  ok,
  parsePostSpec,
  reportListQuerySchema,
  ulid,
  type Report,
  type ReportReason,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireAuth } from "../lib/middleware/auth";
import { checkRateLimit } from "../lib/do";
import { assertTurnstile } from "../services/board/turnstile";
import { writeAudit } from "../lib/audit";
import { resolveBoardRow, getThreadRow } from "../services/board/store";
import { actorFrom, canHardDeletePost, hasBoardStaff, isSiteAdmin } from "../services/board/access";
import { deletePost, hidePost } from "../services/board";
import { emitReportCreated } from "../services/ai/events";

const app = new Hono<AppEnv>();

interface ReportRow {
  id: string;
  board_id: number;
  thread_id: number;
  post_ids: string;
  nums: string;
  reason: string;
  comment: string;
  status: string;
  handled_by: string | null;
  handled_at: number | null;
  note: string | null;
  created_at: number;
  board_slug: string;
  thread_title: string;
}

const REPORT_SELECT = `SELECT r.id, r.board_id, r.thread_id, r.post_ids, r.nums, r.reason, r.comment, r.status,
  r.handled_by, r.handled_at, r.note, r.created_at, b.slug AS board_slug, t.title AS thread_title
  FROM reports r JOIN boards b ON b.id = r.board_id JOIN threads t ON t.id = r.thread_id`;

function mapReport(row: ReportRow): Report {
  let postIds: number[] = [];
  try {
    postIds = JSON.parse(row.post_ids) as number[];
  } catch {
    postIds = [];
  }
  const reason = (row.reason in REPORT_REASON_LABELS ? row.reason : "other") as ReportReason;
  return {
    id: row.id,
    boardId: row.board_id,
    boardSlug: row.board_slug,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    postIds,
    nums: row.nums,
    reason,
    comment: row.comment,
    status: row.status === "rejected" ? "rejected" : row.status === "accepted" ? "accepted" : row.status === "resolved" ? "resolved" : "pending",
    handledBy: row.handled_by,
    handledAt: row.handled_at,
    note: row.note,
    createdAt: row.created_at,
  };
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

/** 対象レス番号を post id に解決する。 */
async function resolveReportedPosts(
  db: D1Database,
  threadId: number,
  spec: string,
): Promise<{ postIds: number[]; nums: string }> {
  const parsed = parsePostSpec(spec);
  if (parsed.all) {
    const result = await db
      .prepare("SELECT id FROM posts WHERE thread_id = ? AND kind = 'post' AND deleted = 0 ORDER BY num ASC LIMIT 100")
      .bind(threadId)
      .all<{ id: number }>();
    return { postIds: result.results.map((row) => row.id), nums: "all" };
  }
  if (parsed.nums.length === 0) throw ApiError.validation("通報対象のレス番号が不正です");

  const conditions: string[] = ["thread_id = ?", "kind = 'post'", "deleted = 0"];
  const bindings: unknown[] = [threadId];
  const ors: string[] = [];
  if (parsed.nums.length > 0) {
    ors.push(`num IN (${parsed.nums.map(() => "?").join(",")})`);
    bindings.push(...parsed.nums);
  }
  if (ors.length > 0) conditions.push(`(${ors.join(" OR ")})`);

  const result = await db
    .prepare(`SELECT id FROM posts WHERE ${conditions.join(" AND ")} ORDER BY num ASC LIMIT 100`)
    .bind(...bindings)
    .all<{ id: number }>();
  if (result.results.length === 0) throw ApiError.validation("指定されたレスが見つかりません");
  return { postIds: result.results.map((row) => row.id), nums: parsed.nums.join(",") };
}

/** 通報作成（匿名可・Turnstile 必須・レート制限）。 */
app.post("/", async (c) => {
  const db = c.env.DB;
  const reqCtx = getReqCtx(c);
  const input = createReportRequestSchema.parse(await c.req.json());
  const now = Math.floor(Date.now() / 1000);

  const rate = await checkRateLimit(c.env, "report", reqCtx.device.deviceHash);
  if (!rate.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "通報が多すぎます", { retryAfterSeconds: rate.retryAfterSeconds });
  }
  await assertTurnstile(c.env, input.turnstileToken, "", true);

  const boardParam = input.boardSlug ?? (input.boardId !== undefined ? String(input.boardId) : null);
  if (!boardParam) throw ApiError.validation("boardSlug または boardId が必要です");
  const board = await resolveBoardRow(db, boardParam);
  if (!board) throw ApiError.notFound("板が見つかりません");
  const thread = await getThreadRow(db, input.threadId);
  if (!thread || thread.board_id !== board.id) throw ApiError.notFound("スレッドが見つかりません");

  const { postIds, nums } = await resolveReportedPosts(db, thread.id, input.posts);
  const id = ulid();
  await db
    .prepare(
      `INSERT INTO reports (id, board_id, thread_id, post_ids, nums, reason, comment, status,
        reporter_device_hash, reporter_ip_hash, reporter_account_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      board.id,
      thread.id,
      JSON.stringify(postIds),
      nums,
      input.reason,
      input.comment,
      reqCtx.device.deviceHash,
      reqCtx.device.ipHash,
      reqCtx.session?.account.id ?? null,
      now,
    )
    .run();

  // AI 運営（WP5）の通報トリアージ用 Webhook。配信は waitUntil でレスポンスを待たせない。
  await emitReportCreated(
    c.env,
    { id, boardId: board.id, threadId: thread.id, postIds, nums, reason: input.reason, comment: input.comment },
    (promise) => c.executionCtx.waitUntil(promise),
  );

  return c.json(ok({ id, boardId: board.id, threadId: thread.id, nums, reason: input.reason, status: "pending" }), 201);
});

/** 通報一覧（サイト管理者は全体、板スタッフは自板のみ）。 */
app.get("/", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const query = reportListQuerySchema.parse({
    status: c.req.query("status") ?? undefined,
    boardId: c.req.query("boardId") ?? undefined,
    boardSlug: c.req.query("board") ?? c.req.query("boardSlug") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
    cursor: c.req.query("cursor") ?? undefined,
  });

  const conditions: string[] = ["1 = 1"];
  const bindings: unknown[] = [];
  if (query.status) {
    conditions.push("r.status = ?");
    bindings.push(query.status);
  }
  if (query.boardSlug) {
    const board = await resolveBoardRow(db, query.boardSlug);
    if (!board) throw ApiError.notFound("板が見つかりません");
    conditions.push("r.board_id = ?");
    bindings.push(board.id);
  } else if (query.boardId) {
    conditions.push("r.board_id = ?");
    bindings.push(query.boardId);
  }

  if (!isSiteAdmin(actor)) {
    const staff = await db
      .prepare("SELECT board_id FROM board_staff WHERE account_id = ?")
      .bind(actor.accountId)
      .all<{ board_id: number }>();
    const boardIds = staff.results.map((row) => row.board_id);
    if (boardIds.length === 0) throw ApiError.forbidden("通報の閲覧権限がありません");
    conditions.push(`r.board_id IN (${boardIds.map(() => "?").join(",")})`);
    bindings.push(...boardIds);
  }

  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    conditions.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    bindings.push(Number(cursor["at"] ?? 0), Number(cursor["at"] ?? 0), String(cursor["id"] ?? ""));
  }

  const result = await db
    .prepare(`${REPORT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
    .bind(...bindings, query.limit + 1)
    .all<ReportRow>();
  const rows = result.results.slice(0, query.limit);
  const nextCursor =
    result.results.length > query.limit && rows.length > 0
      ? encodeCursor({ at: rows[rows.length - 1]!.created_at, id: rows[rows.length - 1]!.id })
      : null;

  return c.json(ok({ items: rows.map(mapReport), nextCursor }));
});

/** 通報詳細（対象レスの原文つき）。 */
app.get("/:id", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const row = await db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).bind(c.req.param("id")).first<ReportRow>();
  if (!row) throw ApiError.notFound("通報が見つかりません");
  if (!isSiteAdmin(actor) && !(await hasBoardStaff(db, actor, row.board_id, "moderator"))) {
    throw ApiError.forbidden("通報の閲覧権限がありません");
  }

  const postIds = JSON.parse(row.post_ids) as number[];
  let posts: Array<{ id: number; num: number; name: string; body: string; hidden: number; deleted: number }> = [];
  if (postIds.length > 0) {
    const result = await db
      .prepare(
        `SELECT id, num, name, body, hidden, deleted FROM posts WHERE id IN (${postIds.map(() => "?").join(",")}) ORDER BY num ASC`,
      )
      .bind(...postIds)
      .all<{ id: number; num: number; name: string; body: string; hidden: number; deleted: number }>();
    posts = result.results;
  }
  return c.json(ok({ report: mapReport(row), posts, reasonLabel: REPORT_REASON_LABELS[(row.reason as ReportReason) ?? "other"] }));
});

/** 通報の処理（却下 / 対応済み / 非表示 / 削除）。 */
app.post("/:id/handle", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const input = handleReportRequestSchema.parse(await c.req.json());
  const row = await db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).bind(c.req.param("id")).first<ReportRow>();
  if (!row) throw ApiError.notFound("通報が見つかりません");

  if (!isSiteAdmin(actor) && !(await hasBoardStaff(db, actor, row.board_id, "moderator"))) {
    throw ApiError.forbidden("通報の処理権限がありません");
  }
  if ((input.action === "hide" || input.action === "delete") && !isSiteAdmin(actor)) {
    if (input.action === "delete" && !(await canHardDeletePost(db, actor, row.board_id))) {
      throw ApiError.forbidden("削除処理は副管理人以上が必要です");
    }
  }

  const postIds = JSON.parse(row.post_ids) as number[];
  const deps = { env: c.env, ctx: c.executionCtx };
  for (const postId of postIds) {
    if (input.action === "hide") await hidePost(postId, deps);
    if (input.action === "delete") await deletePost(postId, deps);
  }

  const now = Math.floor(Date.now() / 1000);
  const status = input.action === "reject" ? "rejected" : "resolved";
  await db
    .prepare("UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, note = ? WHERE id = ?")
    .bind(status, actor.accountId, now, input.note, row.id)
    .run();
  await writeAudit(db, {
    actorType: isSiteAdmin(actor) ? "special_admin" : "board_staff",
    actorId: actor.accountId,
    action: `report.${input.action}`,
    target: row.id,
    detail: { postIds, note: input.note },
  });

  return c.json(ok({ id: row.id, status, action: input.action, affectedPosts: postIds }));
});

export default app;