// スレッド API（一覧 / 詳細 / 範囲指定レス取得 / レス投稿 / つぶやき / 状態変更）。

import { Hono } from "hono";
import {
  ApiError,
  ErrorCode,
  editThreadRequestSchema,
  tsubuyakiRequestSchema,
  ok,
  parsePostRange,
  threadListQuerySchema,
  threadPostsQuerySchema,
  type QuotedThreadCard,
  type ThreadQuoteRef,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { assertReadRateLimit } from "../lib/do";
import { createTsubuyakiInternal, createPostInternal, editThreadInternal, type Identity } from "../lib/pipeline";
import { parsePostCreateBody } from "../lib/post-input";
import {
  assertThreadActive,
  boardDesignOf,
  boardSettingsOf,
  getBoardRow,
  getThreadRow,
  mapThread,
  resolveBoardRow,
  POST_COLUMNS,
  THREAD_COLUMNS,
  type PostRow,
  type ThreadRow,
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

  const loaded = await loadThreadPosts(db, thread, query, reqCtx.device.deviceHash, reqCtx.session?.account.id ?? null);
  const board = await getBoardRow(db, thread.board_id);
  const mapped = mapThread(thread);
  const quoteSource = await loadQuotedThreadCard(db, thread.quote_source_id);
  // 本文 URL のインラインカード（R74-05）が板の閲覧可否を同じ基準で判定できるように、
  // スレ詳細の応答に板の状態も出す（deleted 板のスレタイ・件数をカードへ出さない）。
  const boardStatus = board ? board.status : "deleted";
  return c.json(
    ok({
      thread: { ...mapped, design: board ? boardDesignOf(board) : undefined, boardStatus },
      posts: loaded.posts,
      hasMore: loaded.hasMore,
      quoteSource,
    }),
  );
});

/** 引用元スレのカード。非公開板・削除済みは限られた情報だけを返す（見られない板の情報を漏らさない）。 */
async function loadQuotedThreadCard(db: D1Database, threadId: number | null): Promise<QuotedThreadCard | null> {
  if (threadId === null) return null;
  const row = await db
    .prepare(
      `SELECT t.id, t.title, t.post_count, t.status, t.created_at, t.board_id,
              b.slug AS board_slug, b.name AS board_name, b.status AS board_status
       FROM threads t JOIN boards b ON b.id = t.board_id WHERE t.id = ?`,
    )
    .bind(threadId)
    .first<{
      id: number;
      title: string;
      post_count: number;
      status: string;
      created_at: number;
      board_id: number;
      board_slug: string | null;
      board_name: string | null;
      board_status: string;
    }>();
  if (!row) {
    // 元スレが物理的に無い（旧データ）: スレ ID だけの「削除されたスレ」扱い。
    return {
      threadId,
      boardId: null,
      boardSlug: null,
      boardName: null,
      title: "削除されたスレ",
      postCount: 0,
      status: "deleted",
      createdAt: null,
      unavailable: true,
    };
  }
  const boardUnavailable = row.board_status !== "active";
  const deleted = row.status === "deleted";
  return {
    threadId: row.id,
    boardId: boardUnavailable ? null : row.board_id,
    boardSlug: boardUnavailable ? null : row.board_slug,
    boardName: boardUnavailable ? null : row.board_name,
    // 板が非公開・削除済みのときはスレタイトル・レス数も出さない（見られない板の情報をカードで漏らさない）。
    title: boardUnavailable || deleted ? "削除されたスレ" : row.title,
    postCount: boardUnavailable || deleted ? 0 : row.post_count,
    status: boardUnavailable || row.status === "deleted" ? "deleted" : row.status === "closed" ? "closed" : "active",
    createdAt: row.created_at,
    unavailable: deleted || boardUnavailable,
  };
}

/** このスレを引用したスレの一覧（引用元スレの画面に出す）。 */
async function listThreadQuotes(db: D1Database, threadId: number): Promise<ThreadQuoteRef[]> {
  const result = await db
    .prepare(
      `SELECT ${THREAD_COLUMNS} FROM threads t JOIN boards b ON b.id = t.board_id
       WHERE t.quote_source_id = ? AND t.status != 'deleted' AND b.status = 'active'
       ORDER BY t.created_at DESC LIMIT 50`,
    )
    .bind(threadId)
    .all<ThreadRow>();
  return result.results.map((row) => {
    const thread = mapThread(row);
    return {
      id: thread.id,
      boardId: thread.boardId,
      boardSlug: thread.boardSlug,
      boardName: thread.boardName,
      title: thread.title,
      postCount: thread.postCount,
      status: thread.status,
      createdAt: thread.createdAt,
    };
  });
}

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
  const loaded = await loadThreadPosts(db, thread, query, reqCtx.device.deviceHash, reqCtx.session?.account.id ?? null);
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

/** つぶやき（コメント流し）。 */
app.post("/:id/tsubuyaki", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const reqCtx = getReqCtx(c);
  const raw = (await c.req.json()) as Record<string, unknown>;
  const body = tsubuyakiRequestSchema.parse(raw);
  // 通常投稿と同じ受け渡し: body の turnstileToken / cf-turnstile-response / ヘッダの順。
  const turnstileToken =
    body.turnstileToken ??
    (typeof raw["cf-turnstile-response"] === "string" ? raw["cf-turnstile-response"] : undefined) ??
    c.req.header("x-turnstile-token");
  const result = await createTsubuyakiInternal(
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
  return c.json(ok({ tsubuyaki: result.post }), 201);
});

/**
 * スレの変更。3 つの使い方がある:
 * - スレ主/板スタッフ: ピン留め・close（従来どおり。スレ主はログイン不要 = requireAuth を外した）
 * - スレ主本人: タイトルと >>1 本文の編集（body.title + body.body を指定。設計 70 の本人編集）
 */
app.patch("/:id", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const reqCtx = getReqCtx(c);
  const identity: Identity = {
    deviceHash: reqCtx.device.deviceHash,
    ipHash: reqCtx.device.ipHash,
    accountId: reqCtx.session?.account.id ?? null,
  };
  const actor = actorFrom(reqCtx.session?.account);
  const isOwner =
    (thread.owner_device_hash !== null && thread.owner_device_hash === identity.deviceHash) ||
    (thread.owner_account_id !== null && thread.owner_account_id === identity.accountId);
  const isStaff = actor.accountId !== null && (await hasBoardStaff(db, actor, thread.board_id, "moderator"));

  const body = (await c.req.json()) as Record<string, unknown>;

  // 本人編集（タイトル + >>1 本文）。スタッフ・スレ主の状態変更と同じルートに載せる
  // （API 契約上スレの編集は 1 つ）。title/body が含まれる場合は編集として処理する。
  if (typeof body["title"] === "string" || typeof body["body"] === "string") {
    if (!isOwner) throw ApiError.forbidden("スレ主のみ編集できます");
    if (thread.status !== "active") {
      // 設計 70: スレ停止中（close）・削除済みでは編集不可。
      throw new ApiError(409, ErrorCode.CONFLICT, "停止中・削除済みのスレでは編集できません");
    }
    const board = await getBoardRow(db, thread.board_id);
    if (!board) throw ApiError.notFound("板が見つかりません");
    const settings = boardSettingsOf(board);
    if (!settings.allowThreadEdit) throw ApiError.forbidden("この板ではスレの本人編集が許可されていません");
    if (settings.selfEditWindowMinutes > 0 && thread.created_at + settings.selfEditWindowMinutes * 60 < Math.floor(Date.now() / 1000)) {
      throw ApiError.forbidden("本人編集の期限が過ぎています");
    }
    const editBody = editThreadRequestSchema.parse(body);
    const firstPost = await db
      .prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE thread_id = ? AND num = 1 AND kind = 'post'`)
      .bind(thread.id)
      .first<PostRow>();
    if (!firstPost) throw ApiError.notFound(">>1 が見つかりません");
    if (firstPost.self_deleted === 1) throw ApiError.forbidden("削除済みのスレは編集できません");
    const result = await editThreadInternal(
      { thread, firstPost, board, identity, newTitle: editBody.title, newBody: editBody.body, turnstileToken: editBody.turnstileToken },
      { env: c.env, ctx: c.executionCtx },
    );
    return c.json(ok({ thread: result.thread }));
  }

  // 従来の状態変更（ピン留め・close）。
  if (!isOwner && !isStaff) throw ApiError.forbidden("スレ主または板スタッフのみ変更できます");
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

/**
 * スレ削除。スレ主本人（他人のレスが 1 件以上ある場合は 403・削除依頼を案内）または
 * 板スタッフ deputy 以上 / サイト管理者（従来どおり・全レスを巻き込んで削除）。
 * スレ主はログイン不要（匿名スレ主を締め出していた旧 requireAuth を外した）。
 */
app.delete("/:id", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const reqCtx = getReqCtx(c);
  const identity: Identity = {
    deviceHash: reqCtx.device.deviceHash,
    ipHash: reqCtx.device.ipHash,
    accountId: reqCtx.session?.account.id ?? null,
  };
  const actor = actorFrom(reqCtx.session?.account);
  const isOwner =
    (thread.owner_device_hash !== null && thread.owner_device_hash === identity.deviceHash) ||
    (thread.owner_account_id !== null && thread.owner_account_id === identity.accountId);

  // スレ主が板スタッフ（deputy 以上）・サイト運営でもあるときはスタッフ削除を通す
  //（自分のスレに他人レスがあっても、スタッフ権限なら従来どおり削除できる。m2 の退行を直す）。
  const ownerIsStaff =
    isOwner &&
    actor.accountId !== null &&
    (isSiteAdmin(actor) || (await hasBoardStaff(db, actor, thread.board_id, "deputy")));

  if (isOwner && !ownerIsStaff) {
    const board = await getBoardRow(db, thread.board_id);
    if (!board) throw ApiError.notFound("板が見つかりません");
    const settings = boardSettingsOf(board);
    if (!settings.allowThreadDelete) {
      throw ApiError.forbidden("この板ではスレの本人削除が許可されていません");
    }
    if (settings.selfEditWindowMinutes > 0 && thread.created_at + settings.selfEditWindowMinutes * 60 < Math.floor(Date.now() / 1000)) {
      throw ApiError.forbidden("本人削除の期限が過ぎています");
    }
    // 他人のレスが 1 件でもあるなら本人削除は不可（荒らしによる議論の消去を防ぐ。設計 70 の方向）。
    if (thread.post_count > 1) {
      throw ApiError.forbidden("他人のレスがあるスレは本人削除できません。削除依頼（通報）から板スタッフへご相談ください");
    }
    await db.prepare("UPDATE threads SET status = 'deleted' WHERE id = ?").bind(thread.id).run();
    await publishEvent(c.env, c.executionCtx, `thread:${thread.id}`, "post.deleted", {
      threadId: thread.id,
      reason: "thread_self_deleted",
    });
    return c.json(ok({ deleted: true, threadId: thread.id, selfDeleted: true }));
  }

  if (!actor.accountId) throw ApiError.unauthorized();
  if (!isSiteAdmin(actor)) {
    await assertBoardStaff(db, actor, thread.board_id, "deputy");
  }
  await db.prepare("UPDATE threads SET status = 'deleted' WHERE id = ?").bind(thread.id).run();
  await publishEvent(c.env, c.executionCtx, `thread:${thread.id}`, "post.deleted", {
    threadId: thread.id,
    reason: "thread_deleted",
  });
  return c.json(ok({ deleted: true, threadId: thread.id }));
});

/** このスレを引用したスレの一覧。 */
app.get("/:id/quotes", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const items = await listThreadQuotes(db, thread.id);
  return c.json(ok({ items, count: items.length }));
});

/** 範囲指定の解釈結果を返す（フロントのナビゲーション用）。 */
app.get("/:id/range", async (c) => {
  const db = c.env.DB;
  const thread = await assertThreadActive(await getThreadRow(db, parseThreadId(c.req.param("id"))));
  const range = parsePostRange(c.req.query("r"), thread.post_count);
  return c.json(ok({ range, postCount: thread.post_count }));
});

export default app;