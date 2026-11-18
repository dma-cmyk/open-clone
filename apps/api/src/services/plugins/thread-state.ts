// プラグインのスレごとの共有値（storage:thread）の規則と保存。
//
// 設計「スレごとの共有値」の B-3 をここに集約する:
// - プラグインが有効（導入済み）で、サーバーが読むのは「導入が指している版」の manifest
// - スレの閲覧・書き込みは普通のレスと同じ判定（K2: 削除板は 404/409、BAN・アク禁は 403）
// - 1 人 1 回は actor_key（acct:/dev:）で DB の主キーが保証
// - 未ログインは IP ハッシュごとの上限（tally/choice=3 人分、entries=maxPerActor×3）
// - 書き込みは 1 分 30 回
// - entries の本文は長さ・制御文字・板の NG ワードをレス本文と同じ処理に通す
//
// 他人の actor_key・ip_hash は応答に含めない（`mine` だけを本人へ返す）。

import {
  ApiError,
  ErrorCode,
  PLUGIN_THREAD_STATE_KEY_PATTERN,
  findThreadStateDeclaration,
  threadTitleFlagsSchema,
  ulid,
  type BoardSettings,
  type PluginThreadChoiceState,
  type PluginThreadEntriesState,
  type PluginThreadEntry,
  type PluginThreadStateDeclaration,
  type PluginThreadTallyState,
  type ThreadState,
  type ThreadTitleFlags,
} from "shared";
import type { Env } from "../../lib/env";
import { assertReadRateLimit, checkRateLimit } from "../../lib/do";
import { applyNgWords } from "../../lib/pipeline";
import { computeDisplayId } from "../../lib/id";
import {
  DEFAULT_THREAD_FLAGS,
  assertBoardActive,
  assertThreadActive,
  boardSettingsOf,
  getBoardRow,
  getThreadRow,
  loadThreadState,
  parseJsonColumn,
  type BoardRow,
  type ThreadRow,
} from "../board/store";
import { canReadBoardContent, hasBoardStaff, type AccessActor } from "../board/access";
import {
  findInstall,
  getVersionRow,
  parseManifest,
  type PluginRow,
} from "./registry";
import { isPluginActiveFor, isPluginOwner, type PluginActor } from "./access";

/** 未ログイン（IP 単位）の上限倍率。tally/choice は 3 人分、entries は maxPerActor×3。 */
const ANON_ACTOR_CAP = 3;

/** 書き込み前の共通検証を通した文脈。 */
export interface ThreadStateContext {
  plugin: PluginRow;
  board: BoardRow;
  thread: ThreadRow;
  threadState: ThreadState;
  titleFlags: ThreadTitleFlags;
  settings: BoardSettings;
  declaration: PluginThreadStateDeclaration;
  actor: PluginActor;
  actorKey: string;
  ipHash: string;
}

export function parseThreadStateThreadId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation("スレッド ID が不正です");
  return id;
}

export function parseThreadStateKey(raw: string): string {
  if (!PLUGIN_THREAD_STATE_KEY_PATTERN.test(raw)) {
    throw ApiError.validation("key は英小文字/数字/_/- の 1〜32 文字です");
  }
  return raw;
}

/** ログイン済みはアカウント、未ログインは端末。他人と同じ単位にならない。 */
function actorKeyOf(actor: Pick<PluginActor, "accountId" | "deviceHash">): string {
  return actor.accountId ? `acct:${actor.accountId}` : `dev:${actor.deviceHash}`;
}

function assertActorAllowed(declaration: PluginThreadStateDeclaration, actor: PluginActor): void {
  if (declaration.who === "login" && actor.accountId === null) {
    throw ApiError.unauthorized("この操作はログインが必要です");
  }
}

/**
 * 導入が指している版を解決する。
 * 個人導入 → 板導入 → サイト導入の順に見て、最初に見つかった版を使う（報告書に明記）。
 * 導入がない場合も、所有者は個人プレビューとして最新版を使える（isPluginActiveFor と同じ扱い）。
 */
async function resolveActiveVersion(
  db: D1Database,
  plugin: PluginRow,
  actor: PluginActor,
  boardId: number,
): Promise<{ version: string; personalPreview: boolean }> {
  const candidates: { scope: "personal" | "board" | "site"; ref: string }[] = [
    { scope: "personal", ref: actor.accountId ?? `device:${actor.deviceHash}` },
    { scope: "board", ref: String(boardId) },
    { scope: "site", ref: "site" },
  ];
  for (const candidate of candidates) {
    const active = await isPluginActiveFor(
      db,
      plugin.id,
      actor,
      candidate.scope,
      candidate.scope === "board" ? boardId : undefined,
      plugin,
    );
    if (!active) continue;
    const install = await findInstall(db, plugin.id, candidate.scope, candidate.ref);
    if (!install || install.enabled !== 1) continue;
    return {
      version: install.version,
      personalPreview: candidate.scope === "personal" && isPluginOwner(actor, plugin),
    };
  }
  if (isPluginOwner(actor, plugin) && plugin.latest_version) {
    return { version: plugin.latest_version, personalPreview: true };
  }
  throw ApiError.forbidden("このスレの板でプラグインが有効ではありません");
}

/** スレの文脈（board/thread/宣言/アクター）を組み立て、閲覧可否を K2 と同じ規則で検査する。 */
export async function loadThreadStateContext(params: {
  db: D1Database;
  plugin: PluginRow;
  actor: PluginActor;
  threadId: number;
  key: string;
  ipHash: string;
}): Promise<ThreadStateContext> {
  const { db, plugin, actor, ipHash } = params;
  parseThreadStateKey(params.key);
  if (plugin.status === "disabled") throw ApiError.forbidden("このプラグインは停止されています");

  const thread = await assertThreadActive(await getThreadRow(db, params.threadId));
  const board = await getBoardRow(db, thread.board_id);
  if (!board) throw ApiError.notFound("スレッドが見つかりません");

  // K2: 削除板は板スタッフ・サイト管理者だけが見られる（一般には 404）。
  const accessActor: AccessActor = { accountId: actor.accountId, role: actor.role };
  if (!(await canReadBoardContent(db, accessActor, board))) {
    throw ApiError.notFound("スレッドが見つかりません");
  }

  const resolved = await resolveActiveVersion(db, plugin, actor, board.id);
  const versionRow = await getVersionRow(db, plugin.id, resolved.version);
  if (!versionRow) {
    throw ApiError.forbidden("導入済みバージョンがレジストリに存在しません");
  }
  if (versionRow.status !== "approved" && !resolved.personalPreview) {
    throw ApiError.forbidden("導入済みバージョンは承認されていません");
  }
  const manifest = parseManifest(versionRow.manifest_json);
  const declaration = findThreadStateDeclaration(manifest, params.key);
  if (!declaration) {
    throw ApiError.validation("この key は manifest の threadState で宣言されていません");
  }
  assertActorAllowed(declaration, actor);

  const threadState = await loadThreadState(db, thread.id);
  const titleFlags = parseJsonColumn(
    thread.title_flags,
    (value) => threadTitleFlagsSchema.parse(value),
    DEFAULT_THREAD_FLAGS,
  );
  return {
    plugin,
    board,
    thread,
    threadState,
    titleFlags,
    settings: boardSettingsOf(board),
    declaration,
    actor,
    actorKey: actorKeyOf(actor),
    ipHash,
  };
}

/**
 * 書き込み可否（普通のレスと同じ判定）。
 * BAN（板/サイト・端末/IP/アカウント）とアカウント停止、スレ主アク禁を 403 にする。
 */
export async function assertThreadStateWritable(db: D1Database, ctx: ThreadStateContext, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const { actor, board } = ctx;
  // 削除板への書き込みは普通のレスと同じ 409（K2）。
  await assertBoardActive(board);
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
    .bind(board.id, now, actor.deviceHash, ctx.ipHash, actor.accountId ?? "")
    .first<{ id: string; reason: string }>();
  if (ban) {
    throw new ApiError(403, ErrorCode.BANNED, "アクセス禁止中です", { reason: ban.reason });
  }
  if (actor.accountId) {
    const account = await db.prepare("SELECT status FROM accounts WHERE id = ?").bind(actor.accountId).first<{
      status: string;
    }>();
    if (account && account.status !== "active") {
      throw new ApiError(403, ErrorCode.BANNED, "アカウントが停止されています");
    }
  }

  // スレ主アク禁（!aku）。レスの投稿と同じく、スレ主本人は対象外。
  const isOwner =
    (ctx.thread.owner_account_id !== null && ctx.thread.owner_account_id === actor.accountId) ||
    (ctx.thread.owner_device_hash !== null && ctx.thread.owner_device_hash === actor.deviceHash);
  if (!isOwner && ctx.threadState.akuExpiresAt !== null && ctx.threadState.akuExpiresAt > now) {
    const baseId = await computeDisplayId({
      salt: env.ID_SALT,
      boardId: board.id,
      ipHash: ctx.ipHash,
      now,
    });
    const displayId = ctx.settings.noId || ctx.titleFlags.noId ? "???" : baseId;
    if (
      ctx.threadState.akuDevices.includes(actor.deviceHash) ||
      (displayId !== "???" && ctx.threadState.akuIds.includes(displayId))
    ) {
      throw new ApiError(403, ErrorCode.BANNED, "スレ主によりアク禁されています");
    }
  }
}

/** 書き込み回数（1 人 1 分 30 回）。読み直しは数えない。 */
export async function assertThreadStateRateLimit(env: Env, actorKey: string): Promise<void> {
  const rate = await checkRateLimit(env, "threadState", actorKey);
  if (!rate.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "操作が多すぎます。しばらく待ってください", {
      retryAfterSeconds: rate.retryAfterSeconds,
    });
  }
}

/** 読み取り経路の IP 窓（readList を流用。15 秒ごとの読み直しを妨げない範囲）。 */
export async function assertThreadStateReadLimit(env: Env, ipHash: string): Promise<void> {
  await assertReadRateLimit(env, "readList", ipHash);
}

// ─── tally ───────────────────────────────────────────────────────

function tallyDeclaration(ctx: ThreadStateContext): void {
  if (ctx.declaration.kind !== "tally") throw ApiError.validation("tally ではありません");
}

export async function getTallyState(db: D1Database, ctx: ThreadStateContext): Promise<PluginThreadTallyState> {
  tallyDeclaration(ctx);
  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM plugin_thread_tallies
       WHERE plugin_id = ? AND thread_id = ? AND key = ? AND on_flag = 1`,
    )
    .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key)
    .first<{ n: number }>();
  const mineRow = await db
    .prepare(
      `SELECT on_flag FROM plugin_thread_tallies
       WHERE plugin_id = ? AND thread_id = ? AND key = ? AND actor_key = ?`,
    )
    .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key, ctx.actorKey)
    .first<{ on_flag: number }>();
  return { kind: "tally", count: countRow?.n ?? 0, mine: mineRow?.on_flag === 1 };
}

/**
 * オン/オフ（冪等）。未ログインは同じ IP で 3 人まで（新しい actor を作るときだけ 429）。
 * 条件付き INSERT ... ON CONFLICT にして、数え直しと書き込みの間に増えても上限を超えない。
 */
export async function setTallyState(
  db: D1Database,
  ctx: ThreadStateContext,
  on: boolean,
): Promise<PluginThreadTallyState> {
  tallyDeclaration(ctx);
  const now = Math.floor(Date.now() / 1000);
  const anon = ctx.actor.accountId === null;
  const result = await db
    .prepare(
      `INSERT INTO plugin_thread_tallies
         (plugin_id, thread_id, key, actor_key, ip_hash, on_flag, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
               SELECT 1 FROM plugin_thread_tallies
               WHERE plugin_id = ? AND thread_id = ? AND key = ? AND actor_key = ?
             )
          OR ? = 0
          OR (
               SELECT COUNT(DISTINCT actor_key) FROM plugin_thread_tallies
               WHERE plugin_id = ? AND thread_id = ? AND key = ? AND ip_hash = ?
             ) < ?
       ON CONFLICT(plugin_id, thread_id, key, actor_key)
       DO UPDATE SET on_flag = excluded.on_flag, ip_hash = excluded.ip_hash, updated_at = excluded.updated_at`,
    )
    .bind(
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.actorKey,
      ctx.ipHash,
      on ? 1 : 0,
      now,
      now,
      // EXISTS（既存 actor）
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.actorKey,
      // 匿名でなければ無条件
      anon ? 1 : 0,
      // 同一 IP の actor 数
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.ipHash,
      ANON_ACTOR_CAP,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "この IP から押せる人数の上限に達しました");
  }
  return getTallyState(db, ctx);
}

// ─── choice ──────────────────────────────────────────────────────

function choiceDeclaration(ctx: ThreadStateContext): { options: string[] } {
  if (ctx.declaration.kind !== "choice") throw ApiError.validation("choice ではありません");
  return { options: ctx.declaration.options };
}

export async function getChoiceState(db: D1Database, ctx: ThreadStateContext): Promise<PluginThreadChoiceState> {
  const { options } = choiceDeclaration(ctx);
  const rows = await db
    .prepare(
      `SELECT option_index, COUNT(*) AS n FROM plugin_thread_choices
       WHERE plugin_id = ? AND thread_id = ? AND key = ?
       GROUP BY option_index`,
    )
    .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key)
    .all<{ option_index: number; n: number }>();
  const counts = options.map(() => 0);
  for (const row of rows.results ?? []) {
    if (row.option_index >= 0 && row.option_index < counts.length) counts[row.option_index] = row.n;
  }
  const mineRow = await db
    .prepare(
      `SELECT option_index FROM plugin_thread_choices
       WHERE plugin_id = ? AND thread_id = ? AND key = ? AND actor_key = ?`,
    )
    .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key, ctx.actorKey)
    .first<{ option_index: number }>();
  return { kind: "choice", options, counts, mine: mineRow ? mineRow.option_index : null };
}

export async function setChoiceState(
  db: D1Database,
  ctx: ThreadStateContext,
  option: number | null,
): Promise<PluginThreadChoiceState> {
  const { options } = choiceDeclaration(ctx);
  if (option !== null && (option < 0 || option >= options.length)) {
    throw ApiError.validation("選択肢が不正です");
  }
  if (option === null) {
    await db
      .prepare(
        `DELETE FROM plugin_thread_choices
         WHERE plugin_id = ? AND thread_id = ? AND key = ? AND actor_key = ?`,
      )
      .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key, ctx.actorKey)
      .run();
    return getChoiceState(db, ctx);
  }

  const now = Math.floor(Date.now() / 1000);
  const anon = ctx.actor.accountId === null;
  const result = await db
    .prepare(
      `INSERT INTO plugin_thread_choices
         (plugin_id, thread_id, key, actor_key, ip_hash, option_index, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
               SELECT 1 FROM plugin_thread_choices
               WHERE plugin_id = ? AND thread_id = ? AND key = ? AND actor_key = ?
             )
          OR ? = 0
          OR (
               SELECT COUNT(DISTINCT actor_key) FROM plugin_thread_choices
               WHERE plugin_id = ? AND thread_id = ? AND key = ? AND ip_hash = ?
             ) < ?
       ON CONFLICT(plugin_id, thread_id, key, actor_key)
       DO UPDATE SET option_index = excluded.option_index, ip_hash = excluded.ip_hash, updated_at = excluded.updated_at`,
    )
    .bind(
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.actorKey,
      ctx.ipHash,
      option,
      now,
      now,
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.actorKey,
      anon ? 1 : 0,
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.ipHash,
      ANON_ACTOR_CAP,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "この IP から投票できる人数の上限に達しました");
  }
  return getChoiceState(db, ctx);
}

// ─── entries ─────────────────────────────────────────────────────

function entriesDeclaration(ctx: ThreadStateContext): {
  maxPerActor: number;
  maxEntries: number;
  maxLength: number;
} {
  if (ctx.declaration.kind !== "entries") throw ApiError.validation("entries ではありません");
  const { maxPerActor, maxEntries, maxLength } = ctx.declaration;
  return { maxPerActor, maxEntries, maxLength };
}

function entryToInfo(row: {
  id: string;
  label: string;
  text: string;
  created_at: number;
  actor_key: string;
}, actorKey: string): PluginThreadEntry {
  return {
    id: row.id,
    label: row.label,
    text: row.text,
    createdAt: row.created_at,
    mine: row.actor_key === actorKey,
  };
}

export async function getEntriesState(db: D1Database, ctx: ThreadStateContext): Promise<PluginThreadEntriesState> {
  const { maxEntries } = entriesDeclaration(ctx);
  const rows = await db
    .prepare(
      `SELECT id, label, text, created_at, actor_key FROM plugin_thread_entries
       WHERE plugin_id = ? AND thread_id = ? AND key = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key, maxEntries)
    .all<{ id: string; label: string; text: string; created_at: number; actor_key: string }>();
  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM plugin_thread_entries
       WHERE plugin_id = ? AND thread_id = ? AND key = ?`,
    )
    .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key)
    .first<{ n: number }>();
  return {
    kind: "entries",
    items: (rows.results ?? []).map((row) => entryToInfo(row, ctx.actorKey)),
    total: totalRow?.n ?? 0,
  };
}

/** 表示名（レスと同じ ID）。noId の板・スレでは ??? にする。 */
async function buildEntryLabel(env: Env, ctx: ThreadStateContext, now: number): Promise<string> {
  if (ctx.settings.noId || ctx.titleFlags.noId) return "ID:???";
  const id = await computeDisplayId({
    salt: env.ID_SALT,
    boardId: ctx.board.id,
    ipHash: ctx.ipHash,
    now,
  });
  return `ID:${id}`;
}

/** 本文をレス本文と同じ処理に通す（改行正規化・制御文字除去・長さ・NG ワード）。 */
function sanitizeEntryText(ctx: ThreadStateContext, raw: string): string {
  const { maxLength } = entriesDeclaration(ctx);
  let text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (text.length === 0) throw ApiError.validation("本文が空です");
  if (Array.from(text).length > maxLength) {
    throw ApiError.validation(`本文は ${maxLength} 文字以内にしてください`);
  }
  const masked = applyNgWords(ctx.settings, text);
  if (masked.hit && ctx.settings.ngWordAction === "reject") {
    throw ApiError.validation("NGワードが含まれています");
  }
  text = masked.body.trim();
  if (text.length === 0) throw ApiError.validation("本文が空です");
  return text;
}

export async function addEntry(
  db: D1Database,
  env: Env,
  ctx: ThreadStateContext,
  rawText: string,
): Promise<PluginThreadEntriesState> {
  const { maxPerActor, maxEntries } = entriesDeclaration(ctx);
  const text = sanitizeEntryText(ctx, rawText);
  const now = Math.floor(Date.now() / 1000);
  const anon = ctx.actor.accountId === null;

  const label = await buildEntryLabel(env, ctx, now);
  const entryId = ulid();

  // 1 人の上限・スレ全体の上限・未ログインの IP 上限を、すべて INSERT の条件で守る。
  // 数え直しと INSERT の間に他のリクエストが入っても、上限を超えて行が増えない。
  const result = await db
    .prepare(
      `INSERT INTO plugin_thread_entries
         (id, plugin_id, thread_id, key, actor_key, ip_hash, label, text, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (
               SELECT COUNT(*) FROM plugin_thread_entries
               WHERE plugin_id = ? AND thread_id = ? AND key = ? AND actor_key = ?
             ) < ?
         AND (
               SELECT COUNT(*) FROM plugin_thread_entries
               WHERE plugin_id = ? AND thread_id = ? AND key = ?
             ) < ?
         AND (
               ? = 0
               OR (
                 SELECT COUNT(*) FROM plugin_thread_entries
                 WHERE plugin_id = ? AND thread_id = ? AND key = ? AND ip_hash = ?
               ) < ?
             )`,
    )
    .bind(
      entryId,
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.actorKey,
      ctx.ipHash,
      label,
      text,
      now,
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.actorKey,
      maxPerActor,
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      maxEntries,
      anon ? 1 : 0,
      ctx.plugin.id,
      ctx.thread.id,
      ctx.declaration.key,
      ctx.ipHash,
      maxPerActor * ANON_ACTOR_CAP,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    // 上限の種類は応答コードだけのために事後確認する（強制は上の INSERT 条件）。
    if (anon) {
      const ipRow = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM plugin_thread_entries
           WHERE plugin_id = ? AND thread_id = ? AND key = ? AND ip_hash = ?`,
        )
        .bind(ctx.plugin.id, ctx.thread.id, ctx.declaration.key, ctx.ipHash)
        .first<{ n: number }>();
      if ((ipRow?.n ?? 0) >= maxPerActor * ANON_ACTOR_CAP) {
        throw new ApiError(429, ErrorCode.RATE_LIMITED, "この IP から書き込める件数の上限に達しました");
      }
    }
    throw new ApiError(409, ErrorCode.CONFLICT, "これ以上書き込めません（件数の上限に達しました）");
  }
  return getEntriesState(db, ctx);
}

export async function removeEntry(
  db: D1Database,
  ctx: ThreadStateContext,
  entryId: string,
): Promise<PluginThreadEntriesState> {
  if (!/^[0-9A-Za-z]{1,40}$/.test(entryId)) throw ApiError.validation("entry id が不正です");
  const row = await db
    .prepare(
      `SELECT id, actor_key FROM plugin_thread_entries
       WHERE id = ? AND plugin_id = ? AND thread_id = ? AND key = ?`,
    )
    .bind(entryId, ctx.plugin.id, ctx.thread.id, ctx.declaration.key)
    .first<{ id: string; actor_key: string }>();
  if (!row) throw ApiError.notFound("書き込みが見つかりません");

  if (row.actor_key !== ctx.actorKey) {
    const accessActor: AccessActor = { accountId: ctx.actor.accountId, role: ctx.actor.role };
    const staff = await hasBoardStaff(db, accessActor, ctx.board.id, "moderator");
    if (!staff) throw ApiError.forbidden("自分の書き込みだけ取り消せます");
  }
  await db.prepare("DELETE FROM plugin_thread_entries WHERE id = ?").bind(entryId).run();
  return getEntriesState(db, ctx);
}

/** key を空にする（板スタッフ・サイト管理者）。 */
export async function clearThreadState(db: D1Database, ctx: ThreadStateContext): Promise<void> {
  const accessActor: AccessActor = { accountId: ctx.actor.accountId, role: ctx.actor.role };
  const staff = await hasBoardStaff(db, accessActor, ctx.board.id, "moderator");
  if (!staff) throw ApiError.forbidden("板スタッフ以上のみ空にできます");
  const key = ctx.declaration.key;
  await db.batch([
    db
      .prepare("DELETE FROM plugin_thread_tallies WHERE plugin_id = ? AND thread_id = ? AND key = ?")
      .bind(ctx.plugin.id, ctx.thread.id, key),
    db
      .prepare("DELETE FROM plugin_thread_choices WHERE plugin_id = ? AND thread_id = ? AND key = ?")
      .bind(ctx.plugin.id, ctx.thread.id, key),
    db
      .prepare("DELETE FROM plugin_thread_entries WHERE plugin_id = ? AND thread_id = ? AND key = ?")
      .bind(ctx.plugin.id, ctx.thread.id, key),
  ]);
}

/** 読み出しは宣言された kind に合わせて返す。 */
export async function getThreadStateValue(
  db: D1Database,
  ctx: ThreadStateContext,
): Promise<PluginThreadTallyState | PluginThreadChoiceState | PluginThreadEntriesState> {
  switch (ctx.declaration.kind) {
    case "tally":
      return getTallyState(db, ctx);
    case "choice":
      return getChoiceState(db, ctx);
    case "entries":
      return getEntriesState(db, ctx);
  }
}