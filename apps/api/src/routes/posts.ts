// レス API（投稿 / つぶやき / 評価 / 非表示・削除 / 投票）。

import { Hono } from "hono";
import {
  ApiError,
  ErrorCode,
  tsubuyakiRequestSchema,
  ok,
  reactionKindSchema,
  votePollRequestSchema,
  type PollResult,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireAuth } from "../lib/middleware/auth";
import { createTsubuyakiInternal, createPostInternal } from "../lib/pipeline";
import { parsePostCreateBody } from "../lib/post-input";
import {
  POST_COLUMNS,
  getThreadRow,
  loadBacklinks,
  loadReactionStats,
  loadSubHashes,
  mapPost,
  assertThreadActive,
  type PostRow,
} from "../services/board/store";
import { actorFrom, assertBoardStaff, canHardDeletePost, isSiteAdmin } from "../services/board/access";
import { deletePost, hidePost, unhidePost } from "../services/board";

const app = new Hono<AppEnv>();

function parsePostId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation("レス ID が不正です");
  return id;
}

async function loadPostRow(db: D1Database, postId: number): Promise<PostRow> {
  const row = await db.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).bind(postId).first<PostRow>();
  if (!row) throw ApiError.notFound("レスが見つかりません");
  return row;
}

/** 単体レス取得（スレッド・板情報つき）。 */
app.get("/:id", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const reqCtx = getReqCtx(c);
  const [subHashes, reactions, backlinks, thread] = await Promise.all([
    loadSubHashes(db, row.thread_id),
    loadReactionStats(db, [row.id], reqCtx.device.deviceHash),
    loadBacklinks(db, [row.id]),
    getThreadRow(db, row.thread_id),
  ]);
  const post = mapPost(row, { subHashes, likedIds: reactions.liked, backlinks });
  return c.json(
    ok({
      post: { ...post, likeCount: reactions.counts.get(row.id) ?? 0 },
      thread: thread
        ? { id: thread.id, title: thread.title, boardId: thread.board_id, boardSlug: thread.board_slug, boardName: thread.board_name }
        : null,
    }),
  );
});

/** レス投稿（`POST /v1/threads/:id/posts` と同等。threadId をボディで受ける）。 */
app.post("/", async (c) => {
  const db = c.env.DB;
  const reqCtx = getReqCtx(c);
  const raw = (await c.req.json()) as Record<string, unknown>;
  const threadId = Number(raw["threadId"]);
  if (!Number.isInteger(threadId) || threadId <= 0) throw ApiError.validation("threadId が必要です");
  const body = parsePostCreateBody(raw);
  const thread = await assertThreadActive(await getThreadRow(db, threadId));
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

/** つぶやき（threadId をボディで受ける）。 */
app.post("/tsubuyaki", async (c) => {
  const db = c.env.DB;
  const reqCtx = getReqCtx(c);
  const raw = (await c.req.json()) as Record<string, unknown>;
  const threadId = Number(raw["threadId"]);
  if (!Number.isInteger(threadId) || threadId <= 0) throw ApiError.validation("threadId が必要です");
  const thread = await assertThreadActive(await getThreadRow(db, threadId));
  const body = tsubuyakiRequestSchema.parse(raw);
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

/** 評価（いいね）のトグル。端末単位で 1 人 1 回。 */
app.post("/:id/like", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const reqCtx = getReqCtx(c);
  const identityHash = reqCtx.device.deviceHash;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const kind = reactionKindSchema.parse(body["kind"] ?? "like");

  const existing = await db
    .prepare("SELECT 1 AS found FROM post_reactions WHERE post_id = ? AND identity_hash = ? AND kind = ?")
    .bind(row.id, identityHash, kind)
    .first<{ found: number }>();

  if (existing) {
    await db
      .prepare("DELETE FROM post_reactions WHERE post_id = ? AND identity_hash = ? AND kind = ?")
      .bind(row.id, identityHash, kind)
      .run();
  } else {
    await db
      .prepare("INSERT INTO post_reactions (post_id, identity_hash, kind, created_at) VALUES (?, ?, ?, ?)")
      .bind(row.id, identityHash, kind, Math.floor(Date.now() / 1000))
      .run();
  }

  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM post_reactions WHERE post_id = ? AND kind = ?")
    .bind(row.id, kind)
    .first<{ n: number }>();
  return c.json(ok({ postId: row.id, kind, count: count?.n ?? 0, liked: !existing }));
});

/** 評価数の取得。 */
app.get("/:id/like", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const identityHash = getReqCtx(c).device.deviceHash;
  const result = await db
    .prepare("SELECT kind, COUNT(*) AS n, MAX(CASE WHEN identity_hash = ? THEN 1 ELSE 0 END) AS mine FROM post_reactions WHERE post_id = ? GROUP BY kind")
    .bind(identityHash, row.id)
    .all<{ kind: string; n: number; mine: number }>();
  const counts = { like: 0, good: 0, bad: 0, liked: false };
  for (const item of result.results) {
    if (item.kind === "like" || item.kind === "good" || item.kind === "bad") counts[item.kind] = item.n;
    if (item.kind === "like" && item.mine === 1) counts.liked = true;
  }
  return c.json(ok({ postId: row.id, ...counts }));
});

/** 非表示（板スタッフ moderator 以上）。 */
app.post("/:id/hide", requireAuth, async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  await assertBoardStaff(db, actorFrom(getReqCtx(c).session!.account), row.board_id, "moderator");
  await hidePost(row.id, { env: c.env, ctx: c.executionCtx });
  return c.json(ok({ postId: row.id, hidden: true }));
});

/** 非表示の解除（板スタッフ moderator 以上）。 */
app.post("/:id/restore", requireAuth, async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  await assertBoardStaff(db, actorFrom(getReqCtx(c).session!.account), row.board_id, "moderator");
  await unhidePost(row.id, { env: c.env, ctx: c.executionCtx });
  return c.json(ok({ postId: row.id, hidden: false }));
});

/** 削除（板スタッフ deputy 以上 / サイト管理者）。不可逆。 */
app.delete("/:id", requireAuth, async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const actor = actorFrom(getReqCtx(c).session!.account);
  if (!isSiteAdmin(actor) && !(await canHardDeletePost(db, actor, row.board_id))) {
    throw ApiError.forbidden("レス削除は副管理人以上が必要です（モデレーターは非表示のみ）");
  }
  await deletePost(row.id, { env: c.env, ctx: c.executionCtx });
  return c.json(ok({ postId: row.id, deleted: true }));
});

/** 投票の取得（結果つき）。 */
app.get("/:id/poll", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const identityHash = getReqCtx(c).device.ipHash;
  const poll = await db
    .prepare("SELECT id, post_id, thread_id, options, ends_at, created_at FROM polls WHERE post_id = ?")
    .bind(row.id)
    .first<{ id: number; post_id: number; thread_id: number; options: string; ends_at: number; created_at: number }>();
  if (!poll) throw ApiError.notFound("このレスに投票はありません");

  const votes = await db
    .prepare("SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_index")
    .bind(poll.id)
    .all<{ option_index: number; n: number }>();
  const options = JSON.parse(poll.options) as string[];
  const counts = options.map(() => 0);
  for (const vote of votes.results) {
    if (vote.option_index >= 0 && vote.option_index < counts.length) counts[vote.option_index] = vote.n;
  }
  const mine = await db
    .prepare("SELECT option_index FROM poll_votes WHERE poll_id = ? AND identity_hash = ?")
    .bind(poll.id, identityHash)
    .first<{ option_index: number }>();

  const result: PollResult = {
    id: poll.id,
    postId: poll.post_id,
    threadId: poll.thread_id,
    options,
    endsAt: poll.ends_at,
    createdAt: poll.created_at,
    counts,
    totalVotes: counts.reduce((sum, value) => sum + value, 0),
    votedOption: mine?.option_index ?? null,
  };
  return c.json(ok(result));
});

/** 投票（1 IP 1 票）。 */
app.post("/:id/poll/vote", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const identityHash = getReqCtx(c).device.ipHash;
  const body = votePollRequestSchema.parse(await c.req.json());

  const poll = await db
    .prepare("SELECT id, options, ends_at FROM polls WHERE post_id = ?")
    .bind(row.id)
    .first<{ id: number; options: string; ends_at: number }>();
  if (!poll) throw ApiError.notFound("このレスに投票はありません");
  const now = Math.floor(Date.now() / 1000);
  if (poll.ends_at <= now) throw new ApiError(409, ErrorCode.CONFLICT, "投票期間は終了しています");
  const options = JSON.parse(poll.options) as string[];
  if (body.option >= options.length) throw ApiError.validation("選択肢が不正です");

  const inserted = await db
    .prepare("INSERT OR IGNORE INTO poll_votes (poll_id, identity_hash, option_index, created_at) VALUES (?, ?, ?, ?)")
    .bind(poll.id, identityHash, body.option, now)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) {
    throw new ApiError(409, ErrorCode.CONFLICT, "既に投票済みです");
  }
  return c.json(ok({ pollId: poll.id, option: body.option, voted: true }));
});

/** 逆参照元の一覧。 */
app.get("/:id/backlinks", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const result = await db
    .prepare(
      `SELECT p.id, p.num, p.name, p.body FROM backlinks bl JOIN posts p ON p.id = bl.post_id
       WHERE bl.target_post_id = ? AND p.deleted = 0 ORDER BY p.num ASC LIMIT 100`,
    )
    .bind(row.id)
    .all<{ id: number; num: number; name: string; body: string }>();
  return c.json(ok({ postId: row.id, nums: result.results.map((item) => item.num), items: result.results }));
});

export default app;