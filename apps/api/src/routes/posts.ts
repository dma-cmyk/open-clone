// レス API（投稿 / つぶやき / 評価 / 非表示・削除 / 投票）。

import { Hono } from "hono";
import {
  ApiError,
  ErrorCode,
  editPostRequestSchema,
  tsubuyakiRequestSchema,
  ok,
  reactionKindSchema,
  votePollRequestSchema,
  type PostEditHistoryItem,
  type PollResult,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireAuth } from "../lib/middleware/auth";
import { writeAudit } from "../lib/audit";
import {
  createTsubuyakiInternal,
  createPostInternal,
  editPostInternal,
  selfDeletePostInternal,
  type Identity,
} from "../lib/pipeline";
import { parsePostCreateBody } from "../lib/post-input";
import {
  POST_COLUMNS,
  getThreadRow,
  loadBacklinks,
  loadReactionStats,
  loadSubHashes,
  mapPost,
  assertBoardActive,
  assertThreadActive,
  boardSettingsOf,
  getBoardRow,
  type PostRow,
} from "../services/board/store";
import {
  actorFrom,
  assertBoardStaff,
  auditActorType,
  canHardDeletePost,
  canReadBoardContent,
  hasBoardStaff,
  isSiteAdmin,
  type AccessActor,
} from "../services/board/access";
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

/**
 * レスの内容を読み取ってよいか（K2）。削除板のレスは板スタッフ（moderator 以上）と
 * サイト管理者だけが見られる（`/v1/posts/:id/history` の扱いに揃える）。
 */
async function assertPostReadable(db: D1Database, row: PostRow, actor: AccessActor): Promise<void> {
  const board = await getBoardRow(db, row.board_id);
  if (!board || !(await canReadBoardContent(db, actor, board))) {
    throw ApiError.notFound("レスが見つかりません");
  }
}

/** 削除板では内容の書き込み（評価・投票・削除・編集）を受け付けない（K2・投稿と同じ 409）。 */
async function assertPostBoardWritable(db: D1Database, row: PostRow): Promise<void> {
  await assertBoardActive(await getBoardRow(db, row.board_id));
}

/** 単体レス取得（スレッド・板情報つき）。 */
app.get("/:id", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const reqCtx = getReqCtx(c);
  await assertPostReadable(db, row, actorFrom(reqCtx.session?.account));
  const [subHashes, reactions, backlinks, thread] = await Promise.all([
    loadSubHashes(db, row.thread_id),
    loadReactionStats(db, [row.id], reqCtx.device.deviceHash),
    loadBacklinks(db, [row.id]),
    getThreadRow(db, row.thread_id),
  ]);
  const accountId = reqCtx.session?.account.id ?? null;
  const mineIds = new Set<number>(
    row.device_hash === reqCtx.device.deviceHash || (accountId !== null && row.account_id === accountId) ? [row.id] : [],
  );
  const post = mapPost(row, { subHashes, likedIds: reactions.liked, backlinks, mineIds });
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
  // プラグイン sandbox からの中継（ホスト側コードだけが付けるヘッダ）。この経路は
  // 「確認済みによる省略」を使わず、従来どおり毎回 Turnstile を検証する（レビュー 82 / R82-01）。
  // ボディ（プラグインが作る値）ではなくヘッダで判定するため、プラグインは外せない。
  const pluginRelay = c.req.header("x-oc-plugin-relay") === "1";
  const result = await createPostInternal(
    {
      boardId: thread.board_id,
      threadId: thread.id,
      pluginRelay,
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
  await assertPostBoardWritable(db, row);
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
  const reqCtx = getReqCtx(c);
  await assertPostReadable(db, row, actorFrom(reqCtx.session?.account));
  const identityHash = reqCtx.device.deviceHash;
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

/** 非表示（板スタッフ moderator 以上）。監査ログに post.hide を残す（管理画面から再表示できる）。 */
app.post("/:id/hide", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  await assertBoardStaff(db, actor, row.board_id, "moderator");
  await assertPostBoardWritable(db, row);
  await hidePost(row.id, { env: c.env, ctx: c.executionCtx });
  await writeAudit(db, {
    actorType: auditActorType(actor),
    actorId: actor.accountId,
    action: "post.hide",
    target: String(row.id),
    detail: {
      postId: row.id,
      boardId: row.board_id,
      threadId: row.thread_id,
      num: row.num,
      source: "post_menu",
    },
  });
  return c.json(ok({ postId: row.id, hidden: true }));
});

/** 非表示の解除（板スタッフ moderator 以上）。監査ログに post.restore を残す。 */
app.post("/:id/restore", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  await assertBoardStaff(db, actor, row.board_id, "moderator");
  await assertPostBoardWritable(db, row);
  await unhidePost(row.id, { env: c.env, ctx: c.executionCtx });
  await writeAudit(db, {
    actorType: auditActorType(actor),
    actorId: actor.accountId,
    action: "post.restore",
    target: String(row.id),
    detail: {
      postId: row.id,
      boardId: row.board_id,
      threadId: row.thread_id,
      num: row.num,
      source: "post_menu",
    },
  });
  return c.json(ok({ postId: row.id, hidden: false }));
});

/**
 * 削除。板スタッフ deputy 以上（従来どおり）または投稿者本人（selfDeleted 表示）。
 * 本人はログイン不要（匿名掲示板: 端末一致またはアカウント一致で判定）。
 */
app.delete("/:id", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  await assertPostBoardWritable(db, row);
  const reqCtx = getReqCtx(c);
  const identity: Identity = {
    deviceHash: reqCtx.device.deviceHash,
    ipHash: reqCtx.device.ipHash,
    accountId: reqCtx.session?.account.id ?? null,
  };

  // 本人判定: 端末一致、または保存されたアカウント ID が現在のログインと一致。
  const isSelf =
    row.device_hash === identity.deviceHash ||
    (row.account_id !== null && row.account_id === identity.accountId);

  const board = await getBoardRow(db, row.board_id);
  if (!board) throw ApiError.notFound("板が見つかりません");
  const settings = boardSettingsOf(board);

  if (isSelf) {
    if (row.kind === "kome") throw ApiError.forbidden("つぶやきは本人削除の対象外です");
    if (row.num === 1) {
      // >>1 の本人削除 = スレ本人削除（threads 側の API を使う）。
      throw new ApiError(409, ErrorCode.CONFLICT, "スレ本文の削除はスレ本人削除（DELETE /v1/threads/:id）を使用してください");
    }
    if (!settings.allowPostDelete) {
      throw ApiError.forbidden("この板ではレスの本人削除が許可されていません");
    }
    if (row.self_deleted === 1) return c.json(ok({ postId: row.id, deleted: true }));
    if (settings.selfEditWindowMinutes > 0 && row.created_at + settings.selfEditWindowMinutes * 60 < Math.floor(Date.now() / 1000)) {
      throw ApiError.forbidden("本人削除の期限が過ぎています");
    }
    await selfDeletePostInternal(row, { env: c.env, ctx: c.executionCtx });
    return c.json(ok({ postId: row.id, deleted: true, selfDeleted: true }));
  }

  const actor = actorFrom(reqCtx.session?.account);
  if (!actor.accountId) {
    // 本人でもスタッフでもない（未ログイン）: 他人による削除は 403。
    throw ApiError.forbidden("レスの削除は本人または板スタッフのみです");
  }
  if (!isSiteAdmin(actor) && !(await canHardDeletePost(db, actor, row.board_id))) {
    throw ApiError.forbidden("レス削除は副管理人以上が必要です（モデレーターは非表示のみ）");
  }
  await deletePost(row.id, { env: c.env, ctx: c.executionCtx });
  await writeAudit(db, {
    actorType: auditActorType(actor),
    actorId: actor.accountId,
    action: "post.delete",
    target: String(row.id),
    detail: { postId: row.id, boardId: row.board_id, threadId: row.thread_id, num: row.num, source: "post_menu" },
  });
  return c.json(ok({ postId: row.id, deleted: true }));
});

/** 本人編集（本文のみ。旧本文は履歴に残り誰でも見られる）。 */
app.patch("/:id", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  await assertPostBoardWritable(db, row);
  const reqCtx = getReqCtx(c);
  const identity: Identity = {
    deviceHash: reqCtx.device.deviceHash,
    ipHash: reqCtx.device.ipHash,
    accountId: reqCtx.session?.account.id ?? null,
  };

  const isSelf =
    row.device_hash === identity.deviceHash ||
    (row.account_id !== null && row.account_id === identity.accountId);
  if (!isSelf) throw ApiError.forbidden("本人のみ編集できます");
  if (row.kind === "kome") throw ApiError.forbidden("つぶやきは本人編集の対象外です");
  if (row.self_deleted === 1) throw ApiError.forbidden("削除済みのレスは編集できません");
  if (row.num === 1) {
    throw new ApiError(409, ErrorCode.CONFLICT, "スレ本文の編集は PATCH /v1/threads/:id を使用してください");
  }

  const thread = await assertThreadActive(await getThreadRow(db, row.thread_id));
  if (thread.status !== "active") {
    // 設計 70: スレ停止中（close）・削除済みでは編集不可（投稿検査の再利用）。
    throw new ApiError(409, ErrorCode.CONFLICT, "停止中・削除済みのスレでは編集できません");
  }
  const board = await getBoardRow(db, row.board_id);
  if (!board) throw ApiError.notFound("板が見つかりません");
  const settings = boardSettingsOf(board);
  if (!settings.allowPostEdit) throw ApiError.forbidden("この板ではレスの本人編集が許可されていません");
  if (settings.selfEditWindowMinutes > 0 && row.created_at + settings.selfEditWindowMinutes * 60 < Math.floor(Date.now() / 1000)) {
    throw ApiError.forbidden("本人編集の期限が過ぎています");
  }

  const body = editPostRequestSchema.parse(await c.req.json());
  const result = await editPostInternal(
    { post: row, thread, board, identity, newBody: body.body, turnstileToken: body.turnstileToken },
    { env: c.env, ctx: c.executionCtx },
  );
  return c.json(ok({ post: result.post }));
});

/**
 * 編集履歴（旧本文の一覧）。
 * 履歴は公開だが、元のレスが見えない状態（本人削除・スタッフ削除・非表示）では
 * 旧本文も返さない（削除・非表示の閲覧権限に合わせる。板スタッフ以上は従来どおり閲覧可）。
 */
app.get("/:id/history", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  const reqCtx = getReqCtx(c);
  const actor = actorFrom(reqCtx.session?.account);
  // レス自身の状態（本人削除・スタッフ削除・非表示）に加え、親スレ・板の閲覧状態も見る
  //（スレ本人削除・スタッフ削除・板削除の後は旧本文を返さない。R74-01）。
  // closed のスレは閲覧可能（投稿だけ止まっている状態）なので履歴は出す。
  const restricted =
    row.deleted === 1 || row.hidden === 1 || row.self_deleted === 1;
  const thread = await getThreadRow(db, row.thread_id);
  const threadUnavailable = !thread || thread.status === "deleted";
  const board = await getBoardRow(db, row.board_id);
  const boardUnavailable = !board || board.status !== "active";
  if (restricted || threadUnavailable || boardUnavailable) {
    const canSeeDeleted = actor.accountId !== null && (await hasBoardStaff(db, actor, row.board_id, "moderator"));
    if (!canSeeDeleted) throw ApiError.notFound("レスが見つかりません");
  }
  const result = await db
    .prepare("SELECT id, post_id, previous_body, edited_at FROM post_edit_history WHERE post_id = ? ORDER BY edited_at DESC, id DESC LIMIT 100")
    .bind(row.id)
    .all<{ id: number; post_id: number; previous_body: string; edited_at: number }>();
  const items: PostEditHistoryItem[] = result.results.map((historyRow) => ({
    id: historyRow.id,
    postId: historyRow.post_id,
    previousBody: historyRow.previous_body,
    editedAt: historyRow.edited_at,
  }));
  return c.json(ok({ items }));
});

/** 投票の取得（結果つき）。 */
app.get("/:id/poll", async (c) => {
  const db = c.env.DB;
  const row = await loadPostRow(db, parsePostId(c.req.param("id")));
  await assertPostReadable(db, row, actorFrom(getReqCtx(c).session?.account));
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
  await assertPostBoardWritable(db, row);
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
  await assertPostReadable(db, row, actorFrom(getReqCtx(c).session?.account));
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