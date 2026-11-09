// 書き込みパイプライン（DESIGN §6.3）。
// 受信 → レート制限 → アク禁 → Turnstile → 本文検証 → コマンド → ID/トリップ → 安価 → D1 batch → Realtime。
// 投稿 1 件の rows_written ≤ 12 を維持する（無料枠ガード）。呼び出し元は routes か services/board。

import {
  ApiError,
  ErrorCode,
  TSUBUYAKI_MAX_CHARS,
  POST_BODY_MAX_BYTES,
  effectiveMaxPosts,
  parseBodyCommands,
  parseNameCommands,
  parsePollNotation,
  parseTitleFlags,
  parseTripName,
  threadTitleFlagsSchema,
  type AttachmentSummary,
  type BoardSettings,
  type Post,
  type ThreadState,
} from "shared";
import { batch, writeStats, type SqlWriteStats } from "./db";
import { computeDisplayId, jienDisplayId, ninjaLevelFor } from "./id";
import { planThreadCommands, type CommandActor, type CommandPlan } from "./commands";
import { checkRateLimitMulti } from "./do";
import type { Env } from "./env";
import { publishToThreadAndBoard } from "../services/board/realtime";
import { assertTurnstile, needsTurnstile } from "../services/board/turnstile";
import {
  DEFAULT_THREAD_FLAGS,
  DEFAULT_THREAD_STATE,
  assertBoardActive,
  assertThreadActive,
  boardSettingsOf,
  getBoardRow,
  getThreadRow,
  loadStaffLevel,
  loadThreadState,
  parseJsonColumn,
} from "../services/board/store";
import { attachToPost } from "../services/uploads/attach";

/** Hono の `c.executionCtx` と Workers の `ExecutionContext` の共通部分（waitUntil のみ使う）。 */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface PipelineDeps {
  env: Env;
  ctx?: WaitUntilContext;
}

export interface Identity {
  deviceHash: string;
  ipHash: string;
  accountId: string | null;
}

export interface CreatePostInput {
  boardId: number;
  threadId: number | null;
  name?: string;
  mail?: string;
  body: string;
  attachmentIds?: string[];
  deviceHash: string;
  ipHash: string;
  accountId?: string | null;
  aiAgentId?: string | null;
  sage?: boolean;
  turnstileToken?: string;
  /** 内部呼び出し（AI 運営・管理操作）はレート制限/Turnstile をスキップする */
  skipGuards?: boolean;
  /** 2ch 互換クライアント（Turnstile 不可）用に Turnstile のみスキップする */
  skipTurnstile?: boolean;
}

export interface CreatePostResult {
  postId: number;
  threadId: number;
  num: number;
  post: Post;
  threadPostCount: number;
  writeStats: SqlWriteStats;
}

export interface CreateThreadInput {
  boardId: number;
  title: string;
  body: string;
  name?: string;
  mail?: string;
  attachmentIds?: string[];
  deviceHash: string;
  ipHash: string;
  accountId?: string | null;
  aiAgentId?: string | null;
  turnstileToken?: string;
  skipGuards?: boolean;
  skipTurnstile?: boolean;
}

export interface CreateThreadResult {
  thread: {
    id: number;
    boardId: number;
    boardSlug: string;
    boardName: string;
    title: string;
    postCount: number;
    maxPosts: number;
    lastPostAt: number;
    createdAt: number;
    live: boolean;
  };
  post: Post;
  writeStats: SqlWriteStats;
}

export interface CreateTsubuyakiInput {
  boardId: number;
  threadId: number;
  body: string;
  name?: string;
  parentPostId?: number | null;
  deviceHash: string;
  ipHash: string;
  accountId?: string | null;
  aiAgentId?: string | null;
  turnstileToken?: string;
  skipGuards?: boolean;
  skipTurnstile?: boolean;
}

export interface CreateTsubuyakiResult {
  post: Post;
  writeStats: SqlWriteStats;
}

const DEFAULT_NAME = "名無しさん";

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function sumStats(results: D1Result[]): SqlWriteStats {
  return results.reduce(
    (acc, result) => {
      const value = writeStats(result);
      return {
        rowsRead: acc.rowsRead + value.rowsRead,
        rowsWritten: acc.rowsWritten + value.rowsWritten,
        durationMs: acc.durationMs + value.durationMs,
      };
    },
    { rowsRead: 0, rowsWritten: 0, durationMs: 0 },
  );
}

/** 連投・レート制限・アク禁・Turnstile・アカウント停止をまとめて検査する。 */
async function assertWriteAllowed(params: {
  env: Env;
  db: D1Database;
  boardId: number;
  settings: BoardSettings;
  identity: Identity;
  turnstileToken: string | undefined;
  skipGuards: boolean;
  skipTurnstile?: boolean;
  rateScope: "post" | "threadCreate" | "tsubuyaki";
  now: number;
}): Promise<void> {
  const { env, db, settings, identity, now } = params;
  if (params.skipGuards) return;

  // device 窓と IP 窓の両方を消費する。Cookie を保存しないクライアントは毎回新しい
  // device_hash になるため、IP 窓が無いと無制限に投稿できてしまう（H-3）。
  // ログイン済みアカウントは account/device 単位で追跡・停止できるため、IP 窓は匿名のみに適用する
  // （家庭・社内 NAT の正規利用を巻き込まない）。
  const ipScope = `${params.rateScope}Ip` as const;
  const rate = await checkRateLimitMulti(env, params.rateScope, [identity.deviceHash]);
  const ipRate =
    identity.accountId === null
      ? await checkRateLimitMulti(env, ipScope, [identity.ipHash])
      : { allowed: true, retryAfterSeconds: 0 };
  if (!rate.allowed || !ipRate.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "投稿間隔が短すぎます。しばらく待ってください", {
      retryAfterSeconds: Math.max(rate.retryAfterSeconds, ipRate.retryAfterSeconds),
    });
  }

  const ban = await db
    .prepare(
      `SELECT id, reason FROM board_bans
       WHERE (board_id = ? OR board_id IS NULL)
         AND (expires_at IS NULL OR expires_at > ?)
         AND ((kind = 'device' AND identity_hash = ?)
           OR (kind = 'ip' AND identity_hash = ?)
           OR (kind = 'account' AND identity_hash = ?))
       LIMIT 1`,
    )
    .bind(params.boardId, now, identity.deviceHash, identity.ipHash, identity.accountId ?? "")
    .first<{ id: string; reason: string }>();
  if (ban) throw new ApiError(403, ErrorCode.BANNED, "アクセス禁止中です", { reason: ban.reason });

  if (identity.accountId) {
    const account = await db.prepare("SELECT status FROM accounts WHERE id = ?").bind(identity.accountId).first<{
      status: string;
    }>();
    if (account && account.status !== "active") {
      throw new ApiError(403, ErrorCode.BANNED, "アカウントが停止されています");
    }
  }

  if (settings.cooldownSeconds > 0) {
    const recent = await db
      .prepare(
        "SELECT created_at FROM posts WHERE board_id = ? AND device_hash = ? AND kind = 'post' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(params.boardId, identity.deviceHash, now - settings.cooldownSeconds)
      .first<{ created_at: number }>();
    if (recent) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, "連投間隔が短すぎます", {
        retryAfterSeconds: settings.cooldownSeconds - (now - recent.created_at),
      });
    }
  }

  if (!params.skipTurnstile) {
    await assertTurnstile(env, params.turnstileToken, "", needsTurnstile(settings, identity.accountId !== null));
  }
}

/** スレ主アク禁（`!aku`）の判定。期限切れは無視する。 */
function assertNotAku(state: ThreadState, identity: Identity, displayId: string, now: number): void {
  if (state.akuExpiresAt !== null && state.akuExpiresAt <= now) return;
  if (state.akuDevices.includes(identity.deviceHash)) {
    throw new ApiError(403, ErrorCode.BANNED, "スレ主によりアク禁されています");
  }
  if (displayId !== "???" && state.akuIds.includes(displayId)) {
    throw new ApiError(403, ErrorCode.BANNED, "スレ主によりアク禁されています");
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 板設定の NG ワードを適用する。reject は呼び出し側が 400 にする。 */
function applyNgWords(settings: BoardSettings, body: string): { body: string; hit: boolean } {
  let result = body;
  let hit = false;
  for (const word of settings.ngWords) {
    const trimmed = word.trim();
    if (trimmed.length === 0) continue;
    const pattern = new RegExp(escapeRegExp(trimmed), "gi");
    if (!pattern.test(result)) continue;
    hit = true;
    if (settings.ngWordAction === "mask") {
      result = result.replace(pattern, "＊".repeat(Math.min(Array.from(trimmed).length, 20)));
    }
  }
  return { body: result, hit };
}

function randomInt(maxExclusive: number): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0]! % maxExclusive;
}

const OMIKUJI = ["大吉", "中吉", "小吉", "吉", "末吉", "凶", "大凶"] as const;

/** 名前欄コマンドの表示上の付加（`!ninja` / `!random` / `!kuji` / `!dama`）。 */
function decorateName(rawName: string, ninjaLv: number, commands: readonly string[]): string {
  let name = rawName.trim().length > 0 ? rawName.trim() : DEFAULT_NAME;
  if (commands.includes("!ninja")) name += ` (Lv${ninjaLv})`;
  if (commands.includes("!random")) name += ` (乱数:${randomInt(101)})`;
  if (commands.includes("!kuji")) name += ` 【${OMIKUJI[randomInt(OMIKUJI.length)]!}】`;
  if (commands.includes("!dama")) name += ` (お年玉:${randomInt(10_001)}円)`;
  return name.slice(0, 64);
}

/** 本文から `#タグ` を抽出する（最大 5・30 文字）。 */
function extractHashtags(body: string): string[] {
  const tags: string[] = [];
  const pattern = /(^|[\s　])#([^\s#!]{1,30})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const tag = match[2]!.trim().toLowerCase();
    if (tag.length > 0 && !tags.includes(tag) && tags.length < 5) tags.push(tag);
  }
  return tags;
}

interface AnchorTarget {
  id: number;
  num: number;
}

/**
 * `attachToPost` 後の添付を posts.attachments に非正規化保存する。
 * 検索（画像）・専ブラ dat・レス表示が 1 行で参照できるようにする（WP4 の attachments 表が正本）。
 */
async function syncPostAttachments(db: D1Database, postId: number): Promise<AttachmentSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, external_url, content_type, size, filename FROM attachments
       WHERE post_id = ? AND status = 'active' ORDER BY created_at ASC`,
    )
    .bind(postId)
    .all<{ id: string; external_url: string; content_type: string; size: number; filename: string }>();
  const summaries: AttachmentSummary[] = result.results.map((row) => ({
    id: row.id,
    url: row.external_url,
    contentType: row.content_type,
    size: row.size,
    name: row.filename,
  }));
  if (summaries.length > 0) {
    await db.prepare("UPDATE posts SET attachments = ? WHERE id = ?").bind(JSON.stringify(summaries), postId).run();
  }
  return summaries;
}

async function resolveAnchors(db: D1Database, threadId: number, nums: number[]): Promise<AnchorTarget[]> {
  if (nums.length === 0) return [];
  const placeholders = nums.map(() => "?").join(",");
  const result = await db
    .prepare(`SELECT id, num FROM posts WHERE thread_id = ? AND kind = 'post' AND deleted = 0 AND num IN (${placeholders})`)
    .bind(threadId, ...nums)
    .all<AnchorTarget>();
  return result.results;
}

/** コマンドによる追加書き込み（state/sub/cap/add）を batch 用ステートメントに変換する。 */
function commandStatements(db: D1Database, threadId: number, plan: CommandPlan, now: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (plan.stateChanged) {
    statements.push(
      db
        .prepare(
          `INSERT INTO thread_state (thread_id, state, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
        )
        .bind(threadId, JSON.stringify(plan.state), now),
    );
  }
  for (const add of plan.subAdds) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO thread_subs (thread_id, identity_hash, account_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(threadId, add.identityHash, add.accountId, now),
    );
  }
  for (const hash of plan.subRemoves) {
    statements.push(db.prepare("DELETE FROM thread_subs WHERE thread_id = ? AND identity_hash = ?").bind(threadId, hash));
  }
  for (const update of plan.capUpdates) {
    statements.push(db.prepare("UPDATE posts SET cap = ? WHERE id = ?").bind(update.cap, update.postId));
  }
  if (plan.addAppend) {
    statements.push(db.prepare("UPDATE posts SET body = ? WHERE id = ?").bind(plan.addAppend.nextBody, plan.addAppend.postId));
    statements.push(
      db
        .prepare("INSERT INTO posts_fts(posts_fts, rowid, body, name, title) VALUES ('delete', ?, ?, ?, ?)")
        .bind(plan.addAppend.postId, plan.addAppend.previousBody, plan.addAppend.previousName, plan.addAppend.previousTitle),
    );
    statements.push(
      db
        .prepare("INSERT INTO posts_fts(rowid, body, name, title) VALUES (?, ?, ?, ?)")
        .bind(plan.addAppend.postId, plan.addAppend.nextBody, plan.addAppend.previousName, plan.addAppend.previousTitle),
    );
  }
  return statements;
}

/** 投稿 1 件を書き込む（公開 REST / AI 運営 / 管理操作の唯一の経路）。 */
export async function createPostInternal(input: CreatePostInput, deps: PipelineDeps): Promise<CreatePostResult> {
  if (input.threadId === null) throw ApiError.validation("threadId が必要です（スレ作成は createThread を使用）");
  const { env } = deps;
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const board = await assertBoardActive(await getBoardRow(db, input.boardId));
  const settings = boardSettingsOf(board);
  const thread = await assertThreadActive(await getThreadRow(db, input.threadId));
  if (thread.board_id !== board.id) throw ApiError.validation("スレッドが板に属していません");

  const identity: Identity = {
    deviceHash: input.deviceHash,
    ipHash: input.ipHash,
    accountId: input.accountId ?? null,
  };

  await assertWriteAllowed({
    env,
    db,
    boardId: board.id,
    settings,
    identity,
    turnstileToken: input.turnstileToken,
    skipGuards: input.skipGuards === true,
    skipTurnstile: input.skipTurnstile === true,
    rateScope: "post",
    now,
  });

  const threadFlags = parseJsonColumn(thread.title_flags, (value) => threadTitleFlagsSchema.parse(value), DEFAULT_THREAD_FLAGS);
  const state = await loadThreadState(db, thread.id);
  const deviceRow = await db
    .prepare("SELECT post_count FROM devices WHERE device_hash = ?")
    .bind(identity.deviceHash)
    .first<{ post_count: number }>();
  const nextDeviceCount = (deviceRow?.post_count ?? 0) + 1;
  const ninjaLv = ninjaLevelFor(nextDeviceCount);
  const baseId = await computeDisplayId({ salt: env.ID_SALT, boardId: board.id, ipHash: identity.ipHash, now });
  const displayId = settings.noId || threadFlags.noId ? "???" : state.jien ? jienDisplayId(baseId, identity.ipHash, ninjaLv) : baseId;

  // open2ch 準拠: スレ主は `!aku` の対象にならない（同一 ID の他者がアク禁されても主は
  // スレを管理できなければならない）。副主は対象になり得る。
  const requesterIsOwner =
    (thread.owner_account_id !== null && thread.owner_account_id === identity.accountId) ||
    (thread.owner_device_hash !== null && thread.owner_device_hash === identity.deviceHash);
  if (!requesterIsOwner) assertNotAku(state, identity, displayId, now);

  const rawBody = input.body.replace(/\r\n?/g, "\n");
  const masked = applyNgWords(settings, rawBody);
  if (masked.hit && settings.ngWordAction === "reject") {
    throw ApiError.validation("NGワードが含まれています");
  }

  const parsedName = parseNameCommands(input.name ?? "");
  if (state.ngk && (input.name ?? "").trim().length > 0) {
    throw ApiError.forbidden("このスレはコテ禁です（名前欄を使用できません）");
  }
  const { name: rawName, trip } = parseTripName(parsedName.name);
  const displayName = decorateName(rawName, ninjaLv, parsedName.commands);

  if (state.nopic && (input.attachmentIds?.length ?? 0) > 0) {
    throw ApiError.forbidden("このスレは画像投稿が禁止されています");
  }

  const parsedBody = parseBodyCommands(masked.body);
  const staffLevel = await loadStaffLevel(db, board.id, identity.accountId);
  const actor: CommandActor = {
    deviceHash: identity.deviceHash,
    ipHash: identity.ipHash,
    accountId: identity.accountId,
    displayId,
    ninjaLv,
  };
  const plan = await planThreadCommands(
    { db, now, thread, state, settings, actor, isStaff: staffLevel !== null },
    parsedBody.commands,
  );

  let finalBody = parsedBody.body;
  if (plan.notices.length > 0) {
    finalBody = finalBody.length > 0 ? `${finalBody}\n${plan.notices.join("\n")}` : plan.notices.join("\n");
  }
  if (finalBody.trim().length === 0) throw ApiError.validation("本文が空です");
  if (utf8Length(finalBody) > POST_BODY_MAX_BYTES) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "本文が長すぎます");
  }

  const owner = thread.owner_account_id !== null && thread.owner_account_id === identity.accountId;
  const ownerByDevice = thread.owner_device_hash !== null && thread.owner_device_hash === identity.deviceHash;
  const maxPosts = effectiveMaxPosts(thread.max_posts, owner || ownerByDevice);

  const sage =
    input.sage === true ||
    parsedName.forceSage ||
    threadFlags.sage ||
    settings.forceSage ||
    /(^|[,\s])sage([,\s]|$)/i.test(input.mail ?? "");
  const mail = sage && (input.mail ?? "").length === 0 ? "sage" : (input.mail ?? "").slice(0, 256);

  const anchors = await resolveAnchors(db, thread.id, parsedBody.anchors);
  const hashtags = extractHashtags(parsedBody.body);
  const poll = parsePollNotation(parsedBody.body);

  // レス番号はスレ行の単一 UPDATE で原子的に確保する。D1 は書き込みを直列化するため、
  // 8 並行投稿でも post_count の取り合いが起きず、重複番号や再試行による 500 にならない。
  // 上限判定も同じ WHERE 句で行う（確保できた投稿だけが後続の batch を実行する）。
  const reserved = await db
    .prepare(
      `UPDATE threads
          SET post_count = post_count + 1, last_post_at = ?, bump_at = ?
        WHERE id = ? AND post_count < ?
        RETURNING post_count AS num`,
    )
    .bind(now, sage ? thread.bump_at : now, thread.id, maxPosts)
    .first<{ num: number }>();
  if (!reserved) {
    const fresh = await getThreadRow(db, thread.id);
    if (!fresh) throw ApiError.notFound("スレッドが見つかりません");
    throw new ApiError(409, ErrorCode.CONFLICT, "このスレッドはレス上限に達しています", { maxPosts });
  }
  const num = reserved.num;

  const statements: D1PreparedStatement[] = [];
  statements.push(
    db
      .prepare(
        `INSERT INTO posts
           (thread_id, board_id, num, title, name, mail, trip, cap, body, sage, post_id_hash, device_hash, ip_hash, ninja_lv, kind, parent_post_id, attachments, hashtags, ai_agent_id, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'post', NULL, NULL, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
        thread.id,
        board.id,
        num,
        displayName,
        mail,
        trip,
        finalBody,
        sage ? 1 : 0,
        displayId,
        identity.deviceHash,
        identity.ipHash,
        ninjaLv,
        hashtags.length > 0 ? JSON.stringify(hashtags) : null,
        input.aiAgentId ?? null,
        now,
      ),
  );
  statements.push(
    db
      .prepare(
        "INSERT INTO posts_fts (rowid, body, name, title) SELECT id, body, name, title FROM posts WHERE thread_id = ? AND num = ? AND kind = 'post'",
      )
      .bind(thread.id, num),
  );
  statements.push(db.prepare("UPDATE boards SET last_post_at = ? WHERE id = ?").bind(now, board.id));
  for (const anchor of anchors) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO backlinks (post_id, target_post_id, target_num, created_at)
           SELECT id, ?, ?, ? FROM posts WHERE thread_id = ? AND num = ? AND kind = 'post'`,
        )
        .bind(anchor.id, anchor.num, now, thread.id, num),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO devices (device_hash, post_count, ninja_lv, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(device_hash) DO UPDATE SET post_count = post_count + 1, ninja_lv = excluded.ninja_lv, updated_at = excluded.updated_at`,
      )
      .bind(identity.deviceHash, ninjaLv, now),
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO counters (name, value, updated_at) VALUES ('posts_total', 1, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at`,
      )
      .bind(now),
  );
  for (const tag of hashtags) {
    statements.push(db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").bind(tag));
    statements.push(
      db
        .prepare(
          `INSERT INTO thread_tags (thread_id, tag_id, updated_at) VALUES (?, (SELECT id FROM tags WHERE name = ?), ?)
           ON CONFLICT(thread_id, tag_id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .bind(thread.id, tag, now),
    );
  }
  if (poll) {
    statements.push(
      db
        .prepare(
          `INSERT INTO polls (post_id, thread_id, options, ends_at, created_at)
           SELECT id, ?, ?, ?, ? FROM posts WHERE thread_id = ? AND num = ? AND kind = 'post'`,
        )
        .bind(thread.id, JSON.stringify(poll.options), now + poll.durationSeconds, now, thread.id, num),
    );
  }
  statements.push(...commandStatements(db, thread.id, plan, now));

  let results: D1Result[];
  try {
    results = await batch(db, statements);
  } catch (error) {
    // 採番だけ進んで投稿が無い状態（欠番）を残さない。後続の投稿が既に採番していれば
    // post_count !== num なので巻き戻さない。
    await db
      .prepare("UPDATE threads SET post_count = post_count - 1 WHERE id = ? AND post_count = ?")
      .bind(thread.id, num)
      .run()
      .catch(() => undefined);
    const message = String(error);
    if (/UNIQUE constraint failed: posts\.thread_id, posts\.num/.test(message)) {
      // 番号が既に使われている（削除済みレスの番号を再利用した等）。再試行では解消しない。
      throw new ApiError(409, ErrorCode.CONFLICT, "投稿が混み合っています。もう一度お試しください");
    }
    if (/D1_ERROR|database is locked|SQLITE_BUSY|too many requests/i.test(message)) {
      throw new ApiError(503, ErrorCode.SERVICE_UNAVAILABLE, "書き込みが混み合っています。時間をおいて再試行してください");
    }
    throw error;
  }
  const postId = Number((results[0]?.results?.[0] as { id?: number } | undefined)?.id);
  if (!Number.isInteger(postId) || postId <= 0) throw new Error("投稿 ID を取得できませんでした");

  if (input.attachmentIds && input.attachmentIds.length > 0) {
    try {
      await attachToPost(postId, input.attachmentIds);
    } catch (error) {
      // WP4 未実装時は投稿自体を失敗させない（添付は外部サービス依存の付加機能）。
      if (!/WP4 が実装予定/.test(String(error))) throw error;
      console.warn("attachToPost unavailable", { postId, error: String(error) });
    }
  }
  const attachments = await syncPostAttachments(db, postId);

  const post: Post = {
    id: postId,
    threadId: thread.id,
    boardId: board.id,
    num,
    kind: "post",
    name: displayName,
    mail,
    trip,
    cap: null,
    body: finalBody,
    createdAt: now,
    idHash: displayId,
    sage,
    isOp: false,
    isSub: false,
    attachments,
    likeCount: 0,
    liked: false,
    backlinks: [],
    hidden: false,
    aiAgentId: input.aiAgentId ?? null,
  };

  await publishToThreadAndBoard(env, deps.ctx, thread.id, board.id, "post.created", {
    post,
    thread: { id: thread.id, postCount: num, lastPostAt: now },
  });

  return { postId, threadId: thread.id, num, post, threadPostCount: num, writeStats: sumStats(results) };
}

/** スレ作成（>>1 を含む）。スレ INSERT と >>1 INSERT は 2 段階（失敗時はスレを削除する）。 */
export async function createThreadInternal(input: CreateThreadInput, deps: PipelineDeps): Promise<CreateThreadResult> {
  const { env } = deps;
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const board = await assertBoardActive(await getBoardRow(db, input.boardId));
  const settings = boardSettingsOf(board);
  const identity: Identity = {
    deviceHash: input.deviceHash,
    ipHash: input.ipHash,
    accountId: input.accountId ?? null,
  };

  await assertWriteAllowed({
    env,
    db,
    boardId: board.id,
    settings,
    identity,
    turnstileToken: input.turnstileToken,
    skipGuards: input.skipGuards === true,
    skipTurnstile: input.skipTurnstile === true,
    rateScope: "threadCreate",
    now,
  });

  const parsedTitle = parseTitleFlags(input.title.replace(/[\r\n]+/g, " "));
  if (parsedTitle.title.trim().length === 0) throw ApiError.validation("スレタイが空です");
  if (Array.from(parsedTitle.title).length > 120) throw ApiError.validation("スレタイが長すぎます");

  const masked = applyNgWords(settings, input.body.replace(/\r\n?/g, "\n"));
  if (masked.hit && settings.ngWordAction === "reject") throw ApiError.validation("NGワードが含まれています");
  if (masked.body.trim().length === 0) throw ApiError.validation("本文が空です");
  if (utf8Length(masked.body) > POST_BODY_MAX_BYTES) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "本文が長すぎます");
  }

  const parsedName = parseNameCommands(input.name ?? "");
  const { name: rawName, trip } = parseTripName(parsedName.name);
  const deviceRow = await db
    .prepare("SELECT post_count FROM devices WHERE device_hash = ?")
    .bind(identity.deviceHash)
    .first<{ post_count: number }>();
  const ninjaLv = ninjaLevelFor((deviceRow?.post_count ?? 0) + 1);
  const displayName = decorateName(rawName, ninjaLv, parsedName.commands);
  const baseId = await computeDisplayId({ salt: env.ID_SALT, boardId: board.id, ipHash: identity.ipHash, now });
  const displayId = settings.noId || parsedTitle.flags.noId ? "???" : baseId;

  const maxPosts = parsedTitle.flags.maxPosts ?? settings.maxPosts;
  const live = parsedTitle.flags.live || (settings.live && /実況/.test(parsedTitle.title));
  const hashtags = extractHashtags(masked.body);
  const poll = parsePollNotation(masked.body);
  const mail = (input.mail ?? "").slice(0, 256);

  const threadInsert = await db
    .prepare(
      `INSERT INTO threads
         (board_id, title, title_flags, owner_device_hash, owner_account_id, live, post_count, max_posts, last_post_at, bump_at, pinned, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 'active', ?)
       RETURNING id`,
    )
    .bind(
      board.id,
      parsedTitle.title,
      JSON.stringify(parsedTitle.flags),
      identity.deviceHash,
      identity.accountId,
      live ? 1 : 0,
      maxPosts,
      now,
      now,
      now,
    )
    .first<{ id: number }>();
  const threadId = Number(threadInsert?.id);
  if (!Number.isInteger(threadId) || threadId <= 0) throw new Error("スレッド ID を取得できませんでした");

  const statements: D1PreparedStatement[] = [];
  statements.push(
    db
      .prepare(
        `INSERT INTO posts
           (thread_id, board_id, num, title, name, mail, trip, cap, body, sage, post_id_hash, device_hash, ip_hash, ninja_lv, kind, parent_post_id, attachments, hashtags, ai_agent_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?, 0, ?, ?, ?, ?, 'post', NULL, NULL, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
        threadId,
        board.id,
        parsedTitle.title,
        displayName,
        mail,
        trip,
        masked.body,
        displayId,
        identity.deviceHash,
        identity.ipHash,
        ninjaLv,
        hashtags.length > 0 ? JSON.stringify(hashtags) : null,
        input.aiAgentId ?? null,
        now,
      ),
  );
  statements.push(
    db
      .prepare("INSERT INTO posts_fts (rowid, body, name, title) SELECT id, body, name, title FROM posts WHERE thread_id = ? AND num = 1")
      .bind(threadId),
  );
  statements.push(db.prepare("UPDATE boards SET last_post_at = ? WHERE id = ?").bind(now, board.id));
  statements.push(
    db
      .prepare(
        `INSERT INTO devices (device_hash, post_count, ninja_lv, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(device_hash) DO UPDATE SET post_count = post_count + 1, ninja_lv = excluded.ninja_lv, updated_at = excluded.updated_at`,
      )
      .bind(identity.deviceHash, ninjaLv, now),
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO counters (name, value, updated_at) VALUES ('posts_total', 1, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at`,
      )
      .bind(now),
  );
  for (const tag of hashtags) {
    statements.push(db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").bind(tag));
    statements.push(
      db
        .prepare(
          `INSERT INTO thread_tags (thread_id, tag_id, updated_at) VALUES (?, (SELECT id FROM tags WHERE name = ?), ?)
           ON CONFLICT(thread_id, tag_id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .bind(threadId, tag, now),
    );
  }
  if (poll) {
    statements.push(
      db
        .prepare(
          `INSERT INTO polls (post_id, thread_id, options, ends_at, created_at)
           SELECT id, ?, ?, ?, ? FROM posts WHERE thread_id = ? AND num = 1`,
        )
        .bind(threadId, JSON.stringify(poll.options), now + poll.durationSeconds, now, threadId),
    );
  }
  statements.push(
    db
      .prepare("INSERT INTO thread_state (thread_id, state, updated_at) VALUES (?, ?, ?)")
      .bind(threadId, JSON.stringify(DEFAULT_THREAD_STATE), now),
  );

  let results: D1Result[];
  try {
    results = await batch(db, statements);
  } catch (error) {
    await db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run().catch(() => undefined);
    throw error;
  }

  const postId = Number((results[0]?.results?.[0] as { id?: number } | undefined)?.id);
  if (!Number.isInteger(postId) || postId <= 0) throw new Error(">>1 の ID を取得できませんでした");

  if (input.attachmentIds && input.attachmentIds.length > 0) {
    try {
      await attachToPost(postId, input.attachmentIds);
    } catch (error) {
      if (!/WP4 が実装予定/.test(String(error))) throw error;
      console.warn("attachToPost unavailable", { postId, error: String(error) });
    }
  }
  const attachments = await syncPostAttachments(db, postId);

  const thread = {
    id: threadId,
    boardId: board.id,
    boardSlug: board.slug,
    boardName: board.name,
    title: parsedTitle.title,
    postCount: 1,
    maxPosts,
    lastPostAt: now,
    createdAt: now,
    live,
  };

  const post: Post = {
    id: postId,
    threadId,
    boardId: board.id,
    num: 1,
    kind: "post",
    name: displayName,
    mail,
    trip,
    cap: null,
    body: masked.body,
    createdAt: now,
    idHash: displayId,
    sage: false,
    isOp: true,
    isSub: false,
    attachments,
    likeCount: 0,
    liked: false,
    backlinks: [],
    hidden: false,
    aiAgentId: input.aiAgentId ?? null,
  };

  await publishToThreadAndBoard(env, deps.ctx, threadId, board.id, "thread.created", { thread });
  await publishToThreadAndBoard(env, deps.ctx, threadId, board.id, "post.created", {
    post,
    thread: { id: threadId, postCount: 1, lastPostAt: now },
  });

  return { thread, post, writeStats: sumStats(results) };
}

/** つぶやき（コメント流し）。スレのレス番号・post_count を進めない。 */
export async function createTsubuyakiInternal(input: CreateTsubuyakiInput, deps: PipelineDeps): Promise<CreateTsubuyakiResult> {
  const { env } = deps;
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const board = await assertBoardActive(await getBoardRow(db, input.boardId));
  const settings = boardSettingsOf(board);
  if (!settings.tsubuyaki) throw ApiError.forbidden("この板では つぶやき が無効です");
  const thread = await assertThreadActive(await getThreadRow(db, input.threadId));
  if (thread.board_id !== board.id) throw ApiError.validation("スレッドが板に属していません");

  const identity: Identity = {
    deviceHash: input.deviceHash,
    ipHash: input.ipHash,
    accountId: input.accountId ?? null,
  };

  await assertWriteAllowed({
    env,
    db,
    boardId: board.id,
    settings,
    identity,
    turnstileToken: input.turnstileToken,
    skipGuards: input.skipGuards === true,
    skipTurnstile: input.skipTurnstile === true,
    rateScope: "tsubuyaki",
    now,
  });

  const state = await loadThreadState(db, thread.id);
  const baseId = await computeDisplayId({ salt: env.ID_SALT, boardId: board.id, ipHash: identity.ipHash, now });
  const displayId = settings.noId ? "???" : state.jien ? jienDisplayId(baseId, identity.ipHash, 1) : baseId;
  assertNotAku(state, identity, displayId, now);

  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0) throw ApiError.validation("コメントが空です");
  if (Array.from(body).length > TSUBUYAKI_MAX_CHARS) {
    throw ApiError.validation(`つぶやきは ${TSUBUYAKI_MAX_CHARS} 文字までです`);
  }
  const masked = applyNgWords(settings, body);
  if (masked.hit && settings.ngWordAction === "reject") throw ApiError.validation("NGワードが含まれています");

  const parsedName = parseNameCommands(input.name ?? "");
  const { name: rawName } = parseTripName(parsedName.name);
  const name = decorateName(rawName, 1, parsedName.commands);

  // DB の posts.kind は本番 D1 のテーブル作り直しを避けるため 'kome' のまま保存する
  // （CHECK 制約と既存 migration を変えない）。外向けの PostKind は 'tsubuyaki'。
  const tsubuyakiStatement = db
    .prepare(
      `INSERT INTO posts
         (thread_id, board_id, num, title, name, mail, trip, cap, body, sage, post_id_hash, device_hash, ip_hash, ninja_lv, kind, parent_post_id, attachments, hashtags, ai_agent_id, created_at)
       VALUES (?, ?, 0, NULL, ?, '', NULL, NULL, ?, 1, ?, ?, ?, 1, 'kome', ?, NULL, NULL, ?, ?)
       RETURNING id`,
    )
    .bind(
      thread.id,
      board.id,
      name,
      masked.body,
      displayId,
      identity.deviceHash,
      identity.ipHash,
      input.parentPostId ?? null,
      input.aiAgentId ?? null,
      now,
    );
  const results = await batch(db, [tsubuyakiStatement]);
  const postId = Number((results[0]?.results?.[0] as { id?: number } | undefined)?.id);
  if (!Number.isInteger(postId) || postId <= 0) throw new Error("つぶやきの ID を取得できませんでした");

  const post: Post = {
    id: postId,
    threadId: thread.id,
    boardId: board.id,
    num: 0,
    kind: "tsubuyaki",
    name,
    mail: "",
    trip: null,
    cap: null,
    body: masked.body,
    createdAt: now,
    idHash: displayId,
    sage: true,
    isOp: false,
    isSub: false,
    attachments: [],
    likeCount: 0,
    liked: false,
    backlinks: [],
    hidden: false,
    aiAgentId: input.aiAgentId ?? null,
  };

  await publishToThreadAndBoard(env, deps.ctx, thread.id, board.id, "tsubuyaki.created", { post });
  return { post, writeStats: sumStats(results) };
}