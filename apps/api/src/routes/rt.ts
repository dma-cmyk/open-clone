// リアルタイム接続（WS ticket 発行 + Worker→DO プロキシ）。
// ticket は Cookie 非依存（サードパーティ Cookie 規制の回避。DESIGN §11.2）。

import { Hono } from "hono";
import { ApiError, REALTIME_CHANNEL_PATTERN, ok, rtTicketRequestSchema } from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { assertReadRateLimit, realtimeStub } from "../lib/do";
import { canReadBoardContent, type AccessActor } from "../services/board/access";
import { getBoardRow } from "../services/board/store";
import { signRealtimeTicket, verifyRealtimeTicket } from "../services/board/realtime";

const app = new Hono<AppEnv>();

/**
 * チャンネルの閲覧可否。認可主体は「発行時に署名した accountId」または Cookie のセッション。
 * WS 接続は Cookie を持たない端末でも成立する必要があるため、Cookie だけを主体にしない（T13-03）。
 * 権限は接続時点の DB（アカウント状態・板スタッフ）から引き直す。
 */
async function assertChannelReadable(
  env: AppEnv["Bindings"],
  accountId: string | null,
  channel: string,
): Promise<void> {
  const [kind, rawId] = channel.split(":");
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.validation("channel が不正です");
  const boardId =
    kind === "board"
      ? id
      : (await env.DB.prepare("SELECT board_id FROM threads WHERE id = ?").bind(id).first<{ board_id: number }>())
          ?.board_id ?? null;
  if (boardId === null) throw ApiError.notFound("チャンネルが見つかりません");
  const board = await getBoardRow(env.DB, boardId);
  let actor: AccessActor = { accountId: null, role: null };
  if (accountId !== null) {
    const account = await env.DB.prepare(
      `SELECT a.role, a.status, sa.stopped_at
       FROM accounts a
       LEFT JOIN special_admin_state sa ON sa.account_id = a.id
       WHERE a.id = ?`,
    )
      .bind(accountId)
      .first<{ role: "owner" | "special_admin" | "user"; status: string; stopped_at: number | null }>();
    if (account && account.status === "active") {
      const role = account.role === "special_admin" && account.stopped_at !== null ? "user" : account.role;
      actor = { accountId, role };
    }
  }
  if (!board || !(await canReadBoardContent(env.DB, actor, board))) {
    throw ApiError.notFound("チャンネルが見つかりません");
  }
}

function assertOriginAllowed(c: { req: { header(name: string): string | undefined }; env: AppEnv["Bindings"] }): void {
  const origin = c.req.header("origin");
  const allowed = c.env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean);
  const allowAll = allowed.includes("*");
  if (origin) {
    if (!allowAll && !allowed.includes(origin)) throw new ApiError(403, "BAD_ORIGIN", "Origin が許可されていません");
    return;
  }
  if (c.env.ENVIRONMENT !== "development" && !allowAll) {
    throw new ApiError(403, "BAD_ORIGIN", "Origin ヘッダが必要です");
  }
}

/** ワンタイム ticket の発行（30 秒・チャンネルごとに 1 回）。 */
app.post("/ticket", async (c) => {
  const input = rtTicketRequestSchema.parse(await c.req.json());
  const reqCtx = getReqCtx(c);
  // 無制限の発行は HMAC 計算と DO 呼び出しを枯渇させる（H-3）。
  await assertReadRateLimit(c.env, "rtTicket", reqCtx.device.ipHash);
  const accountId = reqCtx.session?.account.id ?? null;
  for (const channel of input.channels) {
    await assertChannelReadable(c.env, accountId, channel);
  }
  const { ticket, expiresAt } = await signRealtimeTicket(c.env, input.channels, reqCtx.device.deviceHash, accountId);
  return c.json(ok({ ticket, expiresAt, channels: input.channels, wsPath: "/rt" }));
});

/** WebSocket 接続（`/rt?ticket=...&channel=thread:1&since=123`）。 */
app.get("/", async (c) => {
  const upgrade = c.req.header("upgrade") ?? "";
  if (upgrade.toLowerCase() !== "websocket") {
    throw ApiError.validation("WebSocket 接続が必要です（Upgrade: websocket）");
  }
  assertOriginAllowed(c);

  const ticket = c.req.query("ticket");
  const channel = c.req.query("channel") ?? "";
  if (!REALTIME_CHANNEL_PATTERN.test(channel)) throw ApiError.validation("channel が不正です");
  const payload = await verifyRealtimeTicket(c.env, ticket);
  if (!payload.channels.includes(channel)) throw ApiError.forbidden("このチャンネルの ticket ではありません");
  // Cookie ではなく、署名済み ticket に結び付けた主体の現行権限で判定する（T13-03）。
  await assertChannelReadable(c.env, payload.accountId ?? null, channel);

  const since = Math.max(0, Number(c.req.query("since") ?? 0) || 0);
  const stub = realtimeStub(c.env, channel);

  const consume = await stub.fetch(
    `https://do/ticket?key=${encodeURIComponent(`${payload.jti}:${channel}`)}`,
    { method: "GET" },
  );
  if (!consume.ok) throw ApiError.unauthorized("ticket は既に使用済みです");

  const response = await stub.fetch(
    `https://do/ws?channel=${encodeURIComponent(channel)}&since=${since}`,
    { headers: { upgrade: "websocket" } },
  );
  return response;
});

/** 接続数（ランキングの同時接続指標・スレ画面の人数表示）。 */
app.get("/stats", async (c) => {
  const channel = c.req.query("channel");
  if (channel && !REALTIME_CHANNEL_PATTERN.test(channel)) throw ApiError.validation("channel が不正です");
  if (channel) await assertChannelReadable(c.env, getReqCtx(c).session?.account.id ?? null, channel);
  const stub = realtimeStub(c.env, channel ?? "board:0");
  const response = await stub.fetch(`https://do/stats${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`);
  const data = (await response.json()) as { connections: number; channels: Record<string, number> };
  return c.json(ok({ channel: channel ?? null, connections: data.connections, channels: data.channels }));
});

/** 直近イベント（再接続フォールバック用）。 */
app.get("/recent", async (c) => {
  const channel = c.req.query("channel") ?? "";
  if (!REALTIME_CHANNEL_PATTERN.test(channel)) throw ApiError.validation("channel が不正です");
  await assertChannelReadable(c.env, getReqCtx(c).session?.account.id ?? null, channel);
  const limit = Number(c.req.query("limit") ?? 20);
  const stub = realtimeStub(c.env, channel);
  const response = await stub.fetch(`https://do/recent?channel=${encodeURIComponent(channel)}&limit=${limit}`);
  const data = (await response.json()) as { items: unknown[] };
  return c.json(ok({ channel, items: data.items }));
});

export default app;