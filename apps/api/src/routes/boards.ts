// 板 API（一覧 / 作成 / 詳細 / 設定 / スレ一覧 / スタッフ任免 / アク禁）。

import { Hono } from "hono";
import {
  ApiError,
  boardDesignSchema,
  boardSettingsSchema,
  createBoardBanRequestSchema,
  createBoardRequestSchema,
  likeContains,
  ok,
  setBoardStaffRequestSchema,
  threadListQuerySchema,
  type BoardStaff,
  type BoardSummary,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireAuth } from "../lib/middleware/auth";
import { writeAudit } from "../lib/audit";
import {
  BOARD_COLUMNS,
  DEFAULT_DESIGN,
  DEFAULT_SETTINGS,
  assertBoardActive,
  boardDesignOf,
  boardSettingsOf,
  getBoardRow,
  mapBoard,
  resolveBoardRow,
  type BoardRow,
} from "../services/board/store";
import { actorFrom, hasBoardStaff, isSiteAdmin, resolveManageableBoard } from "../services/board/access";
import { assertReadRateLimit } from "../lib/do";
import { createThreadInternal } from "../lib/pipeline";
import { publishEvent } from "../services/board/realtime";
import { listThreads } from "../services/board/threads";

const app = new Hono<AppEnv>();

/** 板一覧（カテゴリ別 + 検索）。一覧系の IP 窓（readList）を消費する。 */
app.get("/", async (c) => {
  await assertReadRateLimit(c.env, "readList", getReqCtx(c).device.ipHash);
  const db = c.env.DB;
  const category = c.req.query("category");
  const q = c.req.query("q");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100), 1), 200);

  const conditions = ["b.status = 'active'"];
  const bindings: unknown[] = [];
  if (category) {
    conditions.push("b.category = ?");
    bindings.push(category);
  }
  if (q) {
    const pattern = likeContains(q);
    conditions.push("(b.name LIKE ? ESCAPE '\\' OR b.slug LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\')");
    bindings.push(pattern, pattern, pattern);
  }

  const result = await db
    .prepare(
      `SELECT ${BOARD_COLUMNS},
         (SELECT COUNT(*) FROM threads t WHERE t.board_id = b.id AND t.status = 'active') AS thread_count,
         (SELECT COALESCE(SUM(t.post_count), 0) FROM threads t WHERE t.board_id = b.id AND t.status = 'active') AS post_count
       FROM boards b
       WHERE ${conditions.join(" AND ")}
       ORDER BY COALESCE(b.last_post_at, b.created_at) DESC, b.id DESC
       LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<BoardRow & { thread_count: number; post_count: number }>();

  const items: BoardSummary[] = result.results.map((row) => {
    const board = mapBoard(row);
    return {
      id: board.id,
      slug: board.slug,
      name: board.name,
      category: board.category,
      description: board.description,
      status: board.status,
      lastPostAt: board.lastPostAt,
      createdAt: board.createdAt,
      threadCount: row.thread_count,
      postCount: row.post_count,
    };
  });

  const categories = await db
    .prepare("SELECT DISTINCT category FROM boards WHERE status = 'active' ORDER BY category ASC")
    .all<{ category: string }>();

  return c.json(ok({ items, categories: categories.results.map((row) => row.category) }));
});

/** 板作成（アカウント必須・1 人 N 板まで）。作成者が初代板管理人になる。 */
app.post("/", requireAuth, async (c) => {
  const db = c.env.DB;
  const reqCtx = getReqCtx(c);
  const account = reqCtx.session!.account;
  const input = createBoardRequestSchema.parse(await c.req.json());

  const limitRow = await db
    .prepare("SELECT value FROM site_config WHERE key = 'max_boards_per_account'")
    .first<{ value: string }>();
  let maxBoards = 5;
  if (limitRow) {
    const parsed = Number(JSON.parse(limitRow.value));
    if (Number.isInteger(parsed) && parsed > 0) maxBoards = parsed;
  }

  if (!isSiteAdmin(actorFrom(account))) {
    const owned = await db
      .prepare("SELECT COUNT(*) AS n FROM boards WHERE owner_account_id = ? AND status = 'active'")
      .bind(account.id)
      .first<{ n: number }>();
    if ((owned?.n ?? 0) >= maxBoards) {
      throw new ApiError(409, "CONFLICT", `板は 1 アカウント ${maxBoards} 件までです`);
    }
  }

  const duplicate = await db.prepare("SELECT id FROM boards WHERE slug = ?").bind(input.slug).first<{ id: number }>();
  if (duplicate) throw new ApiError(409, "CONFLICT", "このスラッグは既に使われています");

  const now = Math.floor(Date.now() / 1000);
  const settings = boardSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...(input.settings ?? {}) });
  const design = boardDesignSchema.parse({ ...DEFAULT_DESIGN, ...(input.design ?? {}) });

  const inserted = await db
    .prepare(
      `INSERT INTO boards (slug, name, category, description, rules_md, design, settings, owner_account_id, status, last_post_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)
       RETURNING id`,
    )
    .bind(
      input.slug,
      input.name,
      input.category,
      input.description,
      input.rulesMd,
      JSON.stringify(design),
      JSON.stringify(settings),
      account.id,
      now,
    )
    .first<{ id: number }>();
  const boardId = Number(inserted?.id);
  if (!Number.isInteger(boardId) || boardId <= 0) throw new Error("板 ID を取得できませんでした");

  await db
    .prepare("INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, 'admin', ?, ?)")
    .bind(boardId, account.id, account.id, now)
    .run();
  await writeAudit(db, {
    actorType: "account",
    actorId: account.id,
    action: "board.create",
    target: String(boardId),
    detail: { slug: input.slug, name: input.name },
  });
  await publishEvent(c.env, c.executionCtx, `board:${boardId}`, "board.updated", { boardId, action: "created" });

  const row = await getBoardRow(db, boardId);
  return c.json(ok({ board: mapBoard(assertRow(row)) }), 201);
});

/** 板詳細（スタッフ一覧・管理可否つき）。 */
app.get("/:slug", async (c) => {
  const db = c.env.DB;
  const row = await resolveBoardRow(db, c.req.param("slug"));
  if (!row) throw ApiError.notFound("板が見つかりません");
  const actor = actorFrom(getReqCtx(c).session?.account);
  const canManage = row.status === "active" ? await hasBoardStaff(db, actor, row.id, "admin") : false;

  const staff = await db
    .prepare(
      `SELECT s.board_id, s.account_id, s.level, s.created_at, a.name AS account_name
       FROM board_staff s JOIN accounts a ON a.id = s.account_id
       WHERE s.board_id = ? ORDER BY CASE s.level WHEN 'admin' THEN 0 WHEN 'deputy' THEN 1 ELSE 2 END, s.created_at ASC`,
    )
    .bind(row.id)
    .all<{ board_id: number; account_id: string; level: string; created_at: number; account_name: string }>();

  // 板ヘッダーの「スレ N / レス M」表示用（一覧 API と同じ数え方）。
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM threads t WHERE t.board_id = ? AND t.status = 'active') AS thread_count,
         (SELECT COALESCE(SUM(t.post_count), 0) FROM threads t WHERE t.board_id = ? AND t.status = 'active') AS post_count`,
    )
    .bind(row.id, row.id)
    .first<{ thread_count: number; post_count: number }>();

  const items: BoardStaff[] = staff.results.map((staffRow) => ({
    boardId: staffRow.board_id,
    accountId: staffRow.account_id,
    accountName: staffRow.account_name,
    level: staffRow.level === "admin" ? "admin" : staffRow.level === "deputy" ? "deputy" : "moderator",
    createdAt: staffRow.created_at,
  }));

  return c.json(
    ok({
      board: {
        ...mapBoard(row),
        threadCount: counts?.thread_count ?? 0,
        postCount: counts?.post_count ?? 0,
      },
      staff: items,
      canManage,
      settings: boardSettingsOf(row),
      design: boardDesignOf(row),
    }),
  );
});

/** 板設定・ルール・デザイン編集（板管理人以上）。 */
app.patch("/:slug", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const { board } = await resolveManageableBoard(db, actor, c.req.param("slug"), "admin");
  const body = (await c.req.json()) as Record<string, unknown>;

  const current = mapBoard(board);
  const nextSettings = boardSettingsSchema.parse({
    ...current.settings,
    ...((body["settings"] as Record<string, unknown> | undefined) ?? {}),
  });
  const nextDesign = boardDesignSchema.parse({
    ...current.design,
    ...((body["design"] as Record<string, unknown> | undefined) ?? {}),
  });
  const name = typeof body["name"] === "string" && body["name"].length > 0 ? body["name"].slice(0, 64) : current.name;
  const category =
    typeof body["category"] === "string" && body["category"].length > 0 ? body["category"].slice(0, 32) : current.category;
  const description = typeof body["description"] === "string" ? body["description"].slice(0, 2000) : current.description;
  const rulesMd = typeof body["rulesMd"] === "string" ? body["rulesMd"].slice(0, 20000) : current.rulesMd;

  await db
    .prepare("UPDATE boards SET name = ?, category = ?, description = ?, rules_md = ?, design = ?, settings = ? WHERE id = ?")
    .bind(name, category, description, rulesMd, JSON.stringify(nextDesign), JSON.stringify(nextSettings), board.id)
    .run();

  await writeAudit(db, {
    actorType: "board_staff",
    actorId: actor.accountId,
    action: "board.update",
    target: String(board.id),
  });
  await publishEvent(c.env, c.executionCtx, `board:${board.id}`, "board.updated", { boardId: board.id, action: "updated" });

  const updated = await getBoardRow(db, board.id);
  return c.json(ok({ board: mapBoard(assertRow(updated)) }));
});

/** 板削除（owner/special_admin、または板管理人が確認付きで）。 */
app.delete("/:slug", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const row = await resolveBoardRow(db, c.req.param("slug"));
  if (!row) throw ApiError.notFound("板が見つかりません");
  const allowed = isSiteAdmin(actor) || (await hasBoardStaff(db, actor, row.id, "admin"));
  if (!allowed) throw ApiError.forbidden("板の削除権限がありません");
  if (c.req.query("confirm") !== "1") {
    throw ApiError.validation("削除には ?confirm=1 が必要です");
  }

  await db.prepare("UPDATE boards SET status = 'deleted' WHERE id = ?").bind(row.id).run();
  await writeAudit(db, {
    actorType: isSiteAdmin(actor) ? "special_admin" : "board_staff",
    actorId: actor.accountId,
    action: "board.delete",
    target: String(row.id),
  });
  await publishEvent(c.env, c.executionCtx, `board:${row.id}`, "board.updated", { boardId: row.id, action: "deleted" });
  return c.json(ok({ deleted: true, boardId: row.id }));
});

/** 板内スレ一覧（勢い・作成順・レス数・更新順）。 */
app.get("/:slug/threads", async (c) => {
  const db = c.env.DB;
  const row = await resolveBoardRow(db, c.req.param("slug"));
  if (!row) throw ApiError.notFound("板が見つかりません");
  const query = threadListQuerySchema.parse({
    sort: c.req.query("sort") ?? undefined,
    q: c.req.query("q") ?? undefined,
    tag: c.req.query("tag") ?? undefined,
    cursor: c.req.query("cursor") ?? undefined,
    limit: c.req.query("limit") ?? undefined,
  });

  const result = await listThreads(db, row.id, {
    sort: query.sort,
    q: query.q,
    tag: query.tag,
    cursor: query.cursor,
    limit: query.limit,
  });

  return c.json(ok({ items: result.items, nextCursor: result.nextCursor }));
});

/** 板内スレ作成（>>1 を含む）。 */
app.post("/:slug/threads", async (c) => {
  const db = c.env.DB;
  const row = await resolveBoardRow(db, c.req.param("slug"));
  if (!row) throw ApiError.notFound("板が見つかりません");
  await assertBoardActive(row);
  const reqCtx = getReqCtx(c);
  const body = (await c.req.json()) as Record<string, unknown>;
  const result = await createThreadInternal(
    {
      boardId: row.id,
      title: String(body["title"] ?? ""),
      body: String(body["body"] ?? ""),
      name: typeof body["name"] === "string" ? body["name"] : undefined,
      mail: typeof body["mail"] === "string" ? body["mail"] : undefined,
      attachmentIds: Array.isArray(body["attachments"]) ? (body["attachments"] as string[]) : undefined,
      deviceHash: reqCtx.device.deviceHash,
      ipHash: reqCtx.device.ipHash,
      accountId: reqCtx.session?.account.id ?? null,
      turnstileToken:
        (typeof body["turnstileToken"] === "string" ? body["turnstileToken"] : undefined) ??
        (typeof body["cf-turnstile-response"] === "string" ? (body["cf-turnstile-response"] as string) : undefined),
    },
    { env: c.env, ctx: c.executionCtx },
  );
  return c.json(ok({ threadId: result.thread.id, thread: result.thread, post: result.post }), 201);
});

/** 板スタッフ一覧。 */
app.get("/:slug/staff", async (c) => {
  const db = c.env.DB;
  const row = await resolveBoardRow(db, c.req.param("slug"));
  if (!row) throw ApiError.notFound("板が見つかりません");
  const result = await db
    .prepare(
      `SELECT s.board_id, s.account_id, s.level, s.created_at, a.name AS account_name
       FROM board_staff s JOIN accounts a ON a.id = s.account_id
       WHERE s.board_id = ? ORDER BY CASE s.level WHEN 'admin' THEN 0 WHEN 'deputy' THEN 1 ELSE 2 END, s.created_at ASC`,
    )
    .bind(row.id)
    .all<{ board_id: number; account_id: string; level: string; created_at: number; account_name: string }>();
  const items: BoardStaff[] = result.results.map((staffRow) => ({
    boardId: staffRow.board_id,
    accountId: staffRow.account_id,
    accountName: staffRow.account_name,
    level: staffRow.level === "admin" ? "admin" : staffRow.level === "deputy" ? "deputy" : "moderator",
    createdAt: staffRow.created_at,
  }));
  return c.json(ok({ items }));
});

/** 板スタッフ任免（板管理人以上）。 */
app.post("/:slug/staff", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const { board } = await resolveManageableBoard(db, actor, c.req.param("slug"), "admin");
  const input = setBoardStaffRequestSchema.parse(await c.req.json());

  let accountId = input.accountId ?? null;
  if (!accountId && input.accountName) {
    const account = await db.prepare("SELECT id FROM accounts WHERE name = ?").bind(input.accountName).first<{ id: string }>();
    if (!account) throw ApiError.notFound("指定したアカウントが見つかりません");
    accountId = account.id;
  }
  if (!accountId) throw ApiError.validation("accountId または accountName が必要です");

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(board_id, account_id) DO UPDATE SET level = excluded.level, by_account_id = excluded.by_account_id`,
    )
    .bind(board.id, accountId, input.level, actor.accountId, now)
    .run();
  await writeAudit(db, {
    actorType: "board_staff",
    actorId: actor.accountId,
    action: "board.staff.set",
    target: `${board.id}:${accountId}`,
    detail: { level: input.level },
  });
  return c.json(ok({ boardId: board.id, accountId, level: input.level }));
});

/** 板スタッフ解任（板管理人以上）。最後の管理人を外すことはできない。 */
app.delete("/:slug/staff/:accountId", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const { board } = await resolveManageableBoard(db, actor, c.req.param("slug"), "admin");
  const accountId = c.req.param("accountId");

  const target = await db
    .prepare("SELECT level FROM board_staff WHERE board_id = ? AND account_id = ?")
    .bind(board.id, accountId)
    .first<{ level: string }>();
  if (!target) throw ApiError.notFound("この板のスタッフではありません");
  if (target.level === "admin") {
    const admins = await db
      .prepare("SELECT COUNT(*) AS n FROM board_staff WHERE board_id = ? AND level = 'admin'")
      .bind(board.id)
      .first<{ n: number }>();
    if ((admins?.n ?? 0) <= 1) throw ApiError.conflict("板管理人を 0 人にはできません");
  }
  await db.prepare("DELETE FROM board_staff WHERE board_id = ? AND account_id = ?").bind(board.id, accountId).run();
  await writeAudit(db, {
    actorType: "board_staff",
    actorId: actor.accountId,
    action: "board.staff.remove",
    target: `${board.id}:${accountId}`,
  });
  return c.json(ok({ removed: true }));
});

/** 板アク禁一覧（板スタッフ以上）。 */
app.get("/:slug/bans", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const { board } = await resolveManageableBoard(db, actor, c.req.param("slug"), "moderator");
  const result = await db
    .prepare(
      `SELECT id, board_id, identity_hash, kind, reason, by_account_id, expires_at, created_at
       FROM board_bans WHERE board_id = ? OR board_id IS NULL ORDER BY created_at DESC LIMIT 200`,
    )
    .bind(board.id)
    .all<{
      id: string;
      board_id: number | null;
      identity_hash: string;
      kind: string;
      reason: string;
      by_account_id: string | null;
      expires_at: number | null;
      created_at: number;
    }>();
  return c.json(
    ok({
      items: result.results.map((row) => ({
        id: row.id,
        boardId: row.board_id,
        identity: row.identity_hash,
        kind: row.kind,
        reason: row.reason,
        byAccountId: row.by_account_id,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      })),
    }),
  );
});

/** アクセス禁止（板: moderator 以上 / サイト全体: owner・special_admin のみ）。 */
app.post("/:slug/bans", requireAuth, async (c) => {
  const db = c.env.DB;
  const reqCtx = getReqCtx(c);
  const actor = actorFrom(reqCtx.session!.account);
  const input = createBoardBanRequestSchema.parse(await c.req.json());

  const row = await resolveBoardRow(db, c.req.param("slug"));
  if (!row) throw ApiError.notFound("板が見つかりません");

  if (input.site) {
    if (!isSiteAdmin(actor)) throw ApiError.forbidden("サイト全体のアクセス禁止は owner / special_admin のみです");
  } else {
    await resolveManageableBoard(db, actor, row.slug, "moderator");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = input.durationHours === null ? null : now + input.durationHours * 3600;
  const id = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO board_bans (id, board_id, identity_hash, kind, reason, by_account_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.site ? null : row.id, input.identity, input.kind, input.reason, actor.accountId, expiresAt, now)
    .run();
  await writeAudit(db, {
    actorType: isSiteAdmin(actor) ? "special_admin" : "board_staff",
    actorId: actor.accountId,
    action: input.site ? "ban.site" : "ban.board",
    target: input.identity,
    detail: { kind: input.kind, expiresAt },
  });
  return c.json(ok({ id, boardId: input.site ? null : row.id, expiresAt }), 201);
});

/** アクセス禁止の解除。 */
app.delete("/:slug/bans/:id", requireAuth, async (c) => {
  const db = c.env.DB;
  const actor = actorFrom(getReqCtx(c).session!.account);
  const row = await resolveBoardRow(db, c.req.param("slug"));
  if (!row) throw ApiError.notFound("板が見つかりません");
  const ban = await db
    .prepare("SELECT board_id FROM board_bans WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ board_id: number | null }>();
  if (!ban) throw ApiError.notFound("アクセス禁止が見つかりません");
  if (ban.board_id === null) {
    if (!isSiteAdmin(actor)) throw ApiError.forbidden("サイト全体の解除は owner / special_admin のみです");
  } else {
    await resolveManageableBoard(db, actor, row.slug, "moderator");
  }
  await db.prepare("DELETE FROM board_bans WHERE id = ?").bind(c.req.param("id")).run();
  return c.json(ok({ removed: true }));
});

function assertRow<T>(row: T | null): T {
  if (!row) throw ApiError.notFound("板が見つかりません");
  return row;
}

export default app;