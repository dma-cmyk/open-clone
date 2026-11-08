// スレッド API（一覧 / 詳細 / 範囲指定レス取得 / レス投稿 / kome / 状態変更）。

import { Hono } from "hono";
import {
  ApiError,
  komeRequestSchema,
  ok,
  parsePostRange,
  threadListQuerySchema,
  threadPostsQuerySchema,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { assertReadRateLimit } from "../lib/do";
import { requireAuth } from "../lib/middleware/auth";
import { createKomeInternal, createPostInternal } from "../lib/pipeline";
import { parsePostCreateBody } from "../lib/post-input";
import {
  assertThreadActive,
  boardDesignOf,
  getBoardRow,
  getThreadRow,
  mapThread,
  resolveBoardRow,
} from "../services/board/store";
import { assertBoardStaff, hasBoardStaff, isSiteAdmin, actorFrom } from "../services/board/access";
import { listThreads, loadThreadPosts } from "../services/board/threads";
import { publishEvent } from "../services/board/realtime";

const app = new Hono<AppEnv>();

function parseThreadId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation("スレッド ID が不正です");
  return id;
}

/** スレ一覧（板スラッグまたは数値 boardId 指定）。一覧系の IP 窓（readList）を消費する。 */
app.get("/", async (c) => {
  await assertReadRateLimit(c.env, "readList", getReqCtx(c).device.ipHash);
  const db = c.env.DB;
  const query = threadListQuerySchema.parse({
    sort: c.req.query("sort") ?? undefined,
    q: c.req.query("q") ?? undefined,
    tag: c.req.query("tag") ?? undefined,
    cursor: c.req.query("cursor") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
  });
  const boardParam = c.req.query("board") ?? c.req.query("boardId");
  if (!boardParam) throw ApiError.validation("board（スラッグまたは板 ID）が必要です");
  const board = await resolveBoardRow(db, boardParam);
  if (!board) throw ApiError.notFound("板が見つかりません");
  const result = await listThreads(db, board.id, query);
  return c.json(ok({ items: result.items, nextCursor: result.nextCursor, boardId: board.id }));
});

/** スレ詳細 + レス（範囲指定 `?r=l50|1-100|7|3,4,8`）。 */
app.get("/:id", async (c) => {
  const db = c.env.DB;
  const threadRow = await getThreadRow(db, parseThreadId(c.req.param("id")));
  const thread = await assertThreadActive(threadRow);
  const reqCtx = getReqCtx(c);
  const query = threadPostsQuerySchema.parse({
    r: c.req.query("r") ?? undefined,
    from: c.req.query("from") ?? undefined,
    id: c.req.query("id") ?? undefined,
    q: c.req.query("q") ?? undefined,
    images: c.req.query("images") ?? undefined,
    since: c.req.query("since") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
  });

  const loaded = await loadThreadPosts(db, thread, query, reqCtx.device.deviceHash);
  const board = await getBoardRow(db, thread.board_id);
  const mapped = mapThread(thread);
  return c.json(
    ok({
      thread: { ...mapped, design: board ? boardDesignOf(board) : undefined },
      posts: loaded.posts,
      hasMore: loaded.hasMore,
    }),
  );
});

/** レス取得（ポーリング・範囲指定）。 */
app.get("/:id/posts", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const reqCtx = getReqCtx(c);
  const query = threadPostsQuerySchema.parse({
    r: c.req.query("r") ?? undefined,
    from: c.req.query("from") ?? undefined,
    id: c.req.query("id") ?? undefined,
    q: c.req.query("q") ?? undefined,
    images: c.req.query("images") ?? undefined,
    since: c.req.query("since") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
  });
  const loaded = await loadThreadPosts(db, thread, query, reqCtx.device.deviceHash);
  return c.json(
    ok({
      items: loaded.posts,
      hasMore: loaded.hasMore,
      thread: { id: thread.id, postCount: thread.post_count, lastPostAt: thread.last_post_at },
    }),
  );
});

/** レス投稿。 */
app.post("/:id/posts", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const reqCtx = getReqCtx(c);
  const body = parsePostCreateBody(await c.req.json());
  const result = await createPostInternal(
    {
      boardId: thread.board_id,
      threadId: thread.id,
      name: body.name,
      mail: body.mail,
      body: body.body,
      sage: body.sage,
      attachmentIds: body.attachmentIds,
      deviceHash: reqCtx.device.deviceHash,
      ipHash: reqCtx.device.ipHash,
      accountId: reqCtx.session?.account.id ?? null,
      turnstileToken: body.turnstileToken,
    },
    { env: c.env, ctx: c.executionCtx },
  );
  return c.json(ok({ post: result.post, thread: { postCount: result.threadPostCount } }), 201);
});

/** kome（コメント流し）。 */
app.post("/:id/kome", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const reqCtx = getReqCtx(c);
  const raw = (await c.req.json()) as Record<string, unknown>;
  const body = komeRequestSchema.parse(raw);
  // 通常投稿と同じ受け渡し: body の turnstileToken / cf-turnstile-response / ヘッダの順。
  const turnstileToken =
    body.turnstileToken ??
    (typeof raw["cf-turnstile-response"] === "string" ? raw["cf-turnstile-response"] : undefined) ??
    c.req.header("x-turnstile-token");
  const result = await createKomeInternal(
    {
      boardId: thread.board_id,
      threadId: thread.id,
      body: body.body,
      name: body.name,
      parentPostId: body.parentPostId ?? null,
      deviceHash: reqCtx.device.deviceHash,
      ipHash: reqCtx.device.ipHash,
      accountId: reqCtx.session?.account.id ?? null,
      turnstileToken,
    },
    { env: c.env, ctx: c.executionCtx },
  );
  return c.json(ok({ kome: result.post }), 201);
});

/** スレ状態（ピン留め・close）変更と削除。板スタッフまたはスレ主。 */
app.patch("/:id", requireAuth, async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const reqCtx = getReqCtx(c);
  const actor = actorFrom(reqCtx.session!.account);
  const isOwner = thread.owner_device_hash === reqCtx.device.deviceHash;
  const isStaff = await hasBoardStaff(db, actor, thread.board_id, "moderator");
  if (!isOwner && !isStaff) throw ApiError.forbidden("スレ主または板スタッフのみ変更できます");

  const body = (await c.req.json()) as Record<string, unknown>;
  const pinned = typeof body["pinned"] === "boolean" ? body["pinned"] : thread.pinned === 1;
  const status = body["status"] === "closed" || body["status"] === "active" ? body["status"] : thread.status;
  if (!isStaff && status === "closed" && !isOwner) throw ApiError.forbidden();

  await db.prepare("UPDATE threads SET pinned = ?, status = ? WHERE id = ?").bind(pinned ? 1 : 0, status, thread.id).run();
  await publishEvent(c.env, c.executionCtx, `thread:${thread.id}`, "thread.updated", {
    threadId: thread.id,
    pinned,
    status,
  });
  const fresh = await getThreadRow(db, thread.id);
  if (!fresh) throw ApiError.notFound("スレッドが見つかりません");
  return c.json(ok({ thread: mapThread(fresh) }));
});

/** スレ削除（板スタッフ以上）。 */
app.delete("/:id", requireAuth, async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const actor = actorFrom(getReqCtx(c).session!.account);
  if (!isSiteAdmin(actor) && thread.owner_device_hash !== getReqCtx(c).device.deviceHash) {
    await assertBoardStaff(db, actor, thread.board_id, "deputy");
  }
  await db.prepare("UPDATE threads SET status = 'deleted' WHERE id = ?").bind(thread.id).run();
  await publishEvent(c.env, c.executionCtx, `thread:${thread.id}`, "post.deleted", {
    threadId: thread.id,
    reason: "thread_deleted",
  });
  return c.json(ok({ deleted: true, threadId: thread.id }));
});

/** 範囲指定の解釈結果を返す（フロントのナビゲーション用）。 */
app.get("/:id/range", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const range = parsePostRange(c.req.query("r"), thread.post_count);
  return c.json(ok({ range, postCount: thread.post_count }));
});

export default app;