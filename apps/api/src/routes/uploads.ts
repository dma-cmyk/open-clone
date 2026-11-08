// アップローダ API（/v1/uploads/*）。
//
// フロー（DESIGN §9.2）:
//   POST /prepare → アダプタ決定・検証・ticket 発行（direct は署名/preset、proxy は中継 URL）
//   POST /proxy   → Worker がストリーム中継（本体は保存しない）→ ticket に結果 URL を記録
//   POST /commit  → attachments 行を作成（未紐付け。投稿時に WP1 が attachToPost を呼ぶ）
//   GET  /history → 自分のアップロード履歴（端末/アカウント）
//   DELETE /:id   → メタ削除（外部サービスが許す場合は外部削除も試行）
//
// 添付本体は Cloudflare（R2/KV/DO/D1）に保存しない。D1 は URL とメタのみ。

import { Hono, type Context } from "hono";
import {
  ApiError,
  ErrorCode,
  UPLOAD_HISTORY_LIMIT,
  ok,
  type UploadRequest,
} from "shared";
import {
  attachmentKindOf,
  attachmentSchema,
  uploadCommitSchema,
  uploadHistoryQuerySchema,
  uploadPrepareSchema,
  uploadProxyResultSchema,
  type AttachmentDto,
} from "shared/schemas/upload";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireTurnstile } from "../lib/middleware/turnstile";
import { writeAudit } from "../lib/audit";
import { githubLinkRequiredError, resolveGithubConnection } from "../services/github/service";
import { makeAdapterContext, listAdapterInfos, resolveAdapterById, resolveRequestAdapter } from "../services/uploads/registry";
import { createTicket, loadTicket, assertTicketOwner, assertTicketToken, assertTicketUsable, markTicketUsed, markTicketCommitted } from "../services/uploads/tickets";
import { insertAttachment, getAttachmentRow, getAttachmentByTicketId, listHistory, setAttachmentStatus, toAttachmentDto } from "../services/uploads/store";
import { consumeUploadQuota } from "../services/uploads/quota";
import { assertUploadRequest, assertSniffedContent, proxyMaxBytes } from "../services/uploads/validation";
import { peekStreamHead, sendProxyUpload } from "../services/uploads/proxy";
import { assertAllowedHost, assertUpstreamOk } from "../services/uploads/util";
import type { ServerAdapterContext, ServerUploaderAdapter, UploadRuntime } from "../services/uploads/types";
import { boardSettingsOf, getBoardRow } from "../services/board/store";
import { needsTurnstile } from "../services/board/turnstile";

const app = new Hono<AppEnv>();

const TURNSTILE_CONFIG_KEY = "uploader.require_turnstile";
const RAW_TEXT_MAX_BYTES = 512 * 1024;

interface Viewer {
  accountId: string | null;
  deviceHash: string;
  ipHash: string;
}

function viewerOf(c: Context<AppEnv>): Viewer {
  const ctx = getReqCtx(c);
  return {
    accountId: ctx.session?.account.id ?? null,
    deviceHash: ctx.device.deviceHash,
    ipHash: ctx.device.ipHash,
  };
}

/** 板なし（プロフィール等）のアップロードはサイト設定に従う（既定 true）。 */
async function siteTurnstileRequired(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value FROM site_config WHERE key = ?")
    .bind(TURNSTILE_CONFIG_KEY)
    .first<{ value: string }>();
  if (!row) return true;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed !== false && parsed !== "false";
  } catch {
    return row.value.trim() !== "false";
  }
}

/**
 * アップロードの Turnstile 要否は投稿側と同じ判定にする（C-1）。
 * 板が分かる場合は板設定（off / anonymous / always）とログイン状態で決め、
 * 板なし・板が見つからない場合だけサイト設定 `uploader.require_turnstile` に従う。
 */
async function turnstileRequiredFor(
  db: D1Database,
  boardId: number | null,
  viewer: Viewer,
): Promise<boolean> {
  if (boardId !== null) {
    const board = await getBoardRow(db, boardId);
    if (board) return needsTurnstile(boardSettingsOf(board), viewer.accountId !== null);
  }
  return siteTurnstileRequired(db);
}

/** 要求時のみ検証する（投稿パイプラインと同じ required 判定を渡す）。 */
async function enforceTurnstile(c: Context<AppEnv>, required: boolean): Promise<void> {
  if (!required) return;
  // Hono のミドルウェアを自前で呼ぶ: 検証後に next を呼ばない（await すると Response 遷移できない）
  await requireTurnstile({ required: true })(c, () => Promise.resolve());
}

function buildRuntime(
  env: AppEnv["Bindings"],
  viewer: Pick<Viewer, "accountId" | "deviceHash">,
  ticket?: UploadRuntime["ticket"],
): UploadRuntime {
  return {
    env,
    db: env.DB,
    accountId: viewer.accountId,
    deviceHash: viewer.deviceHash,
    ticket,
  };
}

async function attachGithubIfNeeded(
  env: AppEnv["Bindings"],
  runtime: UploadRuntime,
  adapter: ServerUploaderAdapter,
): Promise<void> {
  if (!adapter.requiresGithub) return;
  if (!runtime.accountId) throw githubLinkRequiredError();
  runtime.github = await resolveGithubConnection(env, runtime.accountId);
}

function adapterContext(
  env: AppEnv["Bindings"],
  config: Record<string, unknown>,
  runtime: UploadRuntime,
): ServerAdapterContext {
  return makeAdapterContext(env, config, runtime);
}

function allowedHostsOf(adapter: ServerUploaderAdapter, ctx: ServerAdapterContext): readonly string[] {
  return adapter.allowedHostsFor?.(ctx) ?? adapter.allowedHosts;
}

function canDeleteRow(
  row: { uploader_account_id: string | null; device_hash: string; post_id: number | null },
  viewer: Viewer,
): boolean {
  if (row.uploader_account_id && viewer.accountId === row.uploader_account_id) return true;
  if (!row.uploader_account_id && row.post_id === null && row.device_hash === viewer.deviceHash) return true;
  return false;
}

const STAFF_RANK = { admin: 3, deputy: 2, moderator: 1 } as const;

async function isBoardStaff(
  db: D1Database,
  boardId: number | null,
  accountId: string | null,
  minLevel: keyof typeof STAFF_RANK,
): Promise<boolean> {
  if (!boardId || !accountId) return false;
  const row = await db
    .prepare("SELECT level FROM board_staff WHERE board_id = ? AND account_id = ?")
    .bind(boardId, accountId)
    .first<{ level: keyof typeof STAFF_RANK }>();
  return Boolean(row && STAFF_RANK[row.level] >= STAFF_RANK[minLevel]);
}

// ───────────────────────── アダプタ一覧 ─────────────────────────

app.get("/adapters", async (c) => {
  const viewer = viewerOf(c);
  const boardIdRaw = c.req.query("boardId");
  const boardId = boardIdRaw ? Number(boardIdRaw) : null;
  const runtime = buildRuntime(c.env, viewer);
  const result = await listAdapterInfos(c.env, c.env.DB, runtime, Number.isInteger(boardId) ? boardId : null);
  return c.json(ok(result));
});

// ───────────────────────── prepare ─────────────────────────

app.post("/prepare", async (c) => {
  const viewer = viewerOf(c);
  const input = uploadPrepareSchema.parse(await c.req.json());
  const boardId = input.boardId ?? null;
  await enforceTurnstile(c, await turnstileRequiredFor(c.env.DB, boardId, viewer));
  await consumeUploadQuota(c.env, viewer);

  const resolved = await resolveRequestAdapter(c.env.DB, { requested: input.adapter, boardId });
  const runtime = buildRuntime(c.env, viewer);
  const ctx = adapterContext(c.env, resolved.config, runtime);

  if (!resolved.adapter.isAvailable(ctx)) {
    throw ApiError.validation(
      resolved.adapter.unavailableReason?.(ctx) || `アップローダ '${resolved.id}' は現在利用できません`,
    );
  }
  await attachGithubIfNeeded(c.env, runtime, resolved.adapter);

  const uploadRequest: UploadRequest = {
    contentType: input.contentType,
    size: input.size,
    filename: input.filename,
    boardId,
  };
  assertUploadRequest(resolved.adapter, uploadRequest);

  const plan = await resolved.adapter.prepare(uploadRequest, ctx);
  const created = await createTicket(c.env.DB, {
    adapterId: resolved.id,
    mode: plan.mode,
    deviceHash: viewer.deviceHash,
    accountId: viewer.accountId,
    boardId,
    filename: input.filename,
    contentType: input.contentType,
    size: input.size,
    purpose: input.purpose ?? null,
  });

  const finalPlan =
    plan.mode === "proxy-stream"
      ? { ...plan, proxyPath: `${plan.proxyPath}?ticket=${encodeURIComponent(created.ticket.id)}` }
      : plan;

  return c.json(
    ok({
      ticketId: created.ticket.id,
      adapter: resolved.id,
      mode: plan.mode,
      plan: finalPlan,
      maxBytes: plan.maxBytes,
      contentType: input.contentType,
      uploadToken: plan.mode === "proxy-stream" ? created.token : undefined,
      expiresAt: created.ticket.expires_at,
    }),
    201,
  );
});

// ───────────────────────── proxy（ストリーム中継） ─────────────────────────

app.post("/proxy", async (c) => {
  const viewer = viewerOf(c);
  const ticketId = c.req.query("ticket");
  if (!ticketId) throw ApiError.validation("ticket が必要です");
  const token = c.req.header("x-upload-token");
  if (!token) throw ApiError.validation("x-upload-token ヘッダが必要です");

  await assertTicketToken(c.env.DB, ticketId, token);
  const ticket = await loadTicket(c.env.DB, ticketId);
  if (!ticket) throw ApiError.notFound("アップロードが見つかりません");
  assertTicketOwner(ticket, viewer);
  assertTicketUsable(ticket);
  if (ticket.mode !== "proxy-stream") {
    throw ApiError.validation("このアップロードは direct モードです（/commit を使用してください）");
  }

  const resolved = await resolveAdapterById(c.env.DB, ticket.adapter_id);
  if (!resolved) throw ApiError.validation(`アップローダ '${ticket.adapter_id}' が見つかりません`);

  const runtime = buildRuntime(c.env, viewer, {
    id: ticket.id,
    filename: ticket.filename,
    contentType: ticket.content_type,
    size: ticket.size,
    boardId: ticket.board_id,
    purpose: ticket.purpose,
  });
  await attachGithubIfNeeded(c.env, runtime, resolved.adapter);
  const ctx = adapterContext(c.env, resolved.config, runtime);

  const uploadRequest: UploadRequest = {
    contentType: ticket.content_type,
    size: ticket.size,
    filename: ticket.filename,
    boardId: ticket.board_id,
  };

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  const maxBytes = proxyMaxBytes(resolved.adapter, ticket.size);
  if (declaredLength > maxBytes) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "ファイルサイズが上限を超えています");
  }

  const rawBody = c.req.raw.body;
  if (!rawBody) throw ApiError.validation("リクエストボディがありません");
  const { head, body } = await peekStreamHead(rawBody, 64);
  assertSniffedContent(head, ticket.content_type);

  let meta;
  if (resolved.adapter.handleProxy) {
    const buffered = new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body,
    });
    meta = await resolved.adapter.handleProxy(buffered, uploadRequest, ctx);
  } else {
    if (!resolved.adapter.upstream) {
      throw new ApiError(500, ErrorCode.INTERNAL, `アダプタ '${resolved.id}' は中継先が未定義です`);
    }
    if (!resolved.adapter.finalize) {
      throw new ApiError(500, ErrorCode.INTERNAL, `アダプタ '${resolved.id}' は応答の解釈が未定義です`);
    }
    const upstream = await resolved.adapter.upstream(uploadRequest, ctx);
    const { response } = await sendProxyUpload(upstream, body, maxBytes);
    assertUpstreamOk(response, resolved.adapter.label);
    meta = await resolved.adapter.finalize(response, ctx);
  }

  assertAllowedHost(meta.externalUrl, allowedHostsOf(resolved.adapter, ctx), resolved.adapter.label);
  await markTicketUsed(c.env.DB, ticket.id, {
    url: meta.externalUrl,
    deleteUrl: meta.deleteUrl,
    meta: meta.meta,
  });

  const expiresAt = resolved.adapter.retentionSeconds
    ? Math.floor(Date.now() / 1000) + resolved.adapter.retentionSeconds
    : null;

  return c.json(
    ok(
      uploadProxyResultSchema.parse({
        ticketId: ticket.id,
        externalUrl: meta.externalUrl,
        contentType: ticket.content_type,
        size: meta.size,
        kind: attachmentKindOf(ticket.content_type),
        expiresAt,
      }),
    ),
  );
});

// ───────────────────────── commit ─────────────────────────

app.post("/commit", async (c) => {
  const viewer = viewerOf(c);
  const input = uploadCommitSchema.parse(await c.req.json());

  const ticket = await loadTicket(c.env.DB, input.ticketId);
  if (!ticket) throw ApiError.notFound("アップロードが見つかりません");
  assertTicketOwner(ticket, viewer);

  if (ticket.status === "committed") {
    const existing = await getAttachmentByTicketId(c.env.DB, ticket.id);
    if (existing) return c.json(ok(toAttachmentDto(existing, true)));
    throw ApiError.conflict("このアップロードは既に確定しています");
  }
  if (ticket.status === "expired" || ticket.expires_at <= Math.floor(Date.now() / 1000)) {
    throw new ApiError(410, ErrorCode.NOT_FOUND, "アップロードの有効期限が切れています");
  }

  const resolved = await resolveAdapterById(c.env.DB, ticket.adapter_id);
  if (!resolved) throw ApiError.validation(`アップローダ '${ticket.adapter_id}' が見つかりません`);

  const runtime = buildRuntime(c.env, viewer, {
    id: ticket.id,
    filename: ticket.filename,
    contentType: ticket.content_type,
    size: ticket.size,
    boardId: ticket.board_id,
    purpose: ticket.purpose,
  });
  await attachGithubIfNeeded(c.env, runtime, resolved.adapter);
  const ctx = adapterContext(c.env, resolved.config, runtime);

  let meta;
  if (ticket.status === "used") {
    if (!ticket.result_url) throw ApiError.conflict("アップロード結果が記録されていません");
    meta = {
      externalUrl: ticket.result_url,
      deleteUrl: ticket.result_delete_url ?? undefined,
      contentType: ticket.content_type,
      size: ticket.size,
      meta: ticket.result_meta ? (JSON.parse(ticket.result_meta) as Record<string, unknown>) : undefined,
    };
  } else {
    if (resolved.adapter.mode !== "direct") {
      throw ApiError.validation("proxy モードのアップロードは /v1/uploads/proxy を経由してください");
    }
    if (input.externalUrl === undefined && input.response === undefined) {
      throw ApiError.validation("externalUrl または response が必要です");
    }
    if (!resolved.adapter.finalize) {
      throw new ApiError(500, ErrorCode.INTERNAL, `アダプタ '${resolved.id}' は応答の解釈が未定義です`);
    }
    meta = await resolved.adapter.finalize(
      { response: input.response ?? input.externalUrl },
      ctx,
    );
    if (input.deleteUrl) meta.deleteUrl = input.deleteUrl;
  }

  assertAllowedHost(meta.externalUrl, allowedHostsOf(resolved.adapter, ctx), resolved.adapter.label);

  const expiresAt = resolved.adapter.retentionSeconds
    ? Math.floor(Date.now() / 1000) + resolved.adapter.retentionSeconds
    : null;

  const inserted = await insertAttachment(c.env.DB, {
    accountId: viewer.accountId,
    deviceHash: viewer.deviceHash,
    boardId: ticket.board_id,
    adapterId: resolved.id,
    filename: ticket.filename,
    meta,
    ticketId: ticket.id,
    expiresAt,
  });
  await markTicketCommitted(c.env.DB, ticket.id);

  return c.json(ok(inserted.attachment), inserted.created ? 201 : 200);
});

// ───────────────────────── 履歴 ─────────────────────────

app.get("/history", async (c) => {
  const viewer = viewerOf(c);
  const query = uploadHistoryQuerySchema.parse({
    limit: c.req.query("limit") ?? UPLOAD_HISTORY_LIMIT,
    boardId: c.req.query("boardId"),
    unattached: c.req.query("unattached"),
  });
  const rows = await listHistory(c.env.DB, {
    accountId: viewer.accountId,
    deviceHash: viewer.deviceHash,
    limit: query.limit,
    boardId: query.boardId,
    unattachedOnly: query.unattached,
  });
  const items: AttachmentDto[] = rows.map((row) => toAttachmentDto(row, canDeleteRow(row, viewer)));
  return c.json(ok({ items, limitReached: rows.length >= query.limit }));
});

// ───────────────────────── 単体取得・生データ・削除 ─────────────────────────

app.get("/:id", async (c) => {
  const viewer = viewerOf(c);
  const row = await getAttachmentRow(c.env.DB, c.req.param("id"));
  if (!row || row.status === "deleted") throw ApiError.notFound("添付が見つかりません");
  return c.json(ok(attachmentSchema.parse(toAttachmentDto(row, canDeleteRow(row, viewer)))));
});

/** テキスト閲覧用のプロキシ（外部サービスが CORS を返さないため）。画像/動画は外部 URL へ 302。 */
app.get("/:id/raw", async (c) => {
  const row = await getAttachmentRow(c.env.DB, c.req.param("id"));
  if (!row || row.status !== "active") throw ApiError.notFound("添付が見つかりません");

  const resolved = await resolveAdapterById(c.env.DB, row.adapter);
  if (!resolved) throw ApiError.notFound("添付の保存先が不明です");
  const runtime = buildRuntime(c.env, { accountId: row.uploader_account_id, deviceHash: row.device_hash });
  const ctx = adapterContext(c.env, resolved.config, runtime);
  assertAllowedHost(row.external_url, allowedHostsOf(resolved.adapter, ctx), resolved.adapter.label);

  if (row.kind !== "text") {
    return c.redirect(row.external_url, 302);
  }
  if (row.size > RAW_TEXT_MAX_BYTES) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "テキストが大きすぎます。ダウンロードリンクを使用してください");
  }

  const response = await fetch(row.external_url, {
    headers: { "User-Agent": "open-clone/1.0", Referer: "https://catbox.moe/" },
  });
  if (!response.ok) {
    throw new ApiError(502, ErrorCode.BAD_GATEWAY, "添付の取得に失敗しました");
  }
  const text = await response.text();
  return c.body(text, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=60",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
  });
});

app.delete("/:id", async (c) => {
  const viewer = viewerOf(c);
  const row = await getAttachmentRow(c.env.DB, c.req.param("id"));
  if (!row || row.status === "deleted") throw ApiError.notFound("添付が見つかりません");

  const session = getReqCtx(c).session;
  const isAdmin = session?.account.role === "owner" || session?.account.role === "special_admin";
  const isStaff = await isBoardStaff(c.env.DB, row.board_id, viewer.accountId, "moderator");
  const isOwner = canDeleteRow(row, viewer);
  if (!isAdmin && !isStaff && !isOwner) {
    throw ApiError.forbidden("この添付を削除する権限がありません");
  }

  const resolved = await resolveAdapterById(c.env.DB, row.adapter);
  if (resolved?.adapter.remove && row.delete_url) {
    const runtime = buildRuntime(c.env, viewer);
    const ctx = adapterContext(c.env, resolved.config, runtime);
    try {
      await resolved.adapter.remove(
        {
          externalUrl: row.external_url,
          deleteUrl: row.delete_url,
          contentType: row.content_type,
          size: row.size,
          meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined,
        },
        ctx,
      );
    } catch (error) {
      console.warn("ATTACHMENT_EXTERNAL_DELETE_FAILED", { id: row.id, error: String(error) });
    }
  }

  await setAttachmentStatus(c.env.DB, row.id, "deleted");
  await writeAudit(c.env.DB, {
    actorType: isAdmin ? (session?.account.role === "owner" ? "owner" : "special_admin") : isStaff ? "board_staff" : "account",
    actorId: viewer.accountId,
    action: "attachment.delete",
    target: row.id,
    detail: { adapter: row.adapter, postId: row.post_id, boardId: row.board_id },
  });

  return c.json(ok({ id: row.id, deleted: true }));
});

export default app;