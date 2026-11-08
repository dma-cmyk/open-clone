// リアルタイム配信の Worker 側ヘルパ。
// ticket は HMAC(ID_SALT) 署名・30 秒有効・チャンネルごとに 1 回使用（jti は DO が消費管理）。

import {
  ApiError,
  RT_TICKET_TTL_SECONDS,
  boardChannel,
  hmacSha256Hex,
  randomHex,
  threadChannel,
  timingSafeEqual,
  type RealtimeEventType,
} from "shared";
import type { Env } from "../../lib/env";
import { realtimeStub } from "../../lib/do";

export interface TicketPayload {
  jti: string;
  channels: string[];
  exp: number;
  deviceHash: string;
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

export async function signRealtimeTicket(
  env: Env,
  channels: string[],
  deviceHash: string,
): Promise<{ ticket: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + RT_TICKET_TTL_SECONDS;
  const payload: TicketPayload = { jti: randomHex(16), channels, exp: expiresAt, deviceHash };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSha256Hex(env.ID_SALT, `rt-ticket:${encoded}`);
  return { ticket: `${encoded}.${signature}`, expiresAt };
}

export async function verifyRealtimeTicket(env: Env, ticket: string | undefined): Promise<TicketPayload> {
  if (!ticket) throw ApiError.unauthorized("ticket が必要です");
  const separator = ticket.lastIndexOf(".");
  if (separator <= 0) throw ApiError.unauthorized("ticket が不正です");
  const encoded = ticket.slice(0, separator);
  const signature = ticket.slice(separator + 1);
  const expected = await hmacSha256Hex(env.ID_SALT, `rt-ticket:${encoded}`);
  if (!timingSafeEqual(signature, expected)) throw ApiError.unauthorized("ticket が不正です");

  let payload: TicketPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as TicketPayload;
  } catch {
    throw ApiError.unauthorized("ticket が不正です");
  }
  if (!Array.isArray(payload.channels) || typeof payload.exp !== "number") {
    throw ApiError.unauthorized("ticket が不正です");
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) throw ApiError.unauthorized("ticket の有効期限が切れています");
  return payload;
}

/** 1 チャンネルへイベントを publish する（失敗してもレスポンスは壊さない）。 */
export async function publishEvent(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  channel: string,
  type: RealtimeEventType,
  data: unknown,
): Promise<void> {
  const body = JSON.stringify({ channel, event: { type, channel, at: Math.floor(Date.now() / 1000), data } });
  const request = realtimeStub(env, channel).fetch("https://do/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const guarded = request.catch((error: unknown) => {
    console.error("realtime publish failed", { channel, type, error: String(error) });
  });
  if (ctx) ctx.waitUntil(guarded);
  else await guarded;
}

/** スレと板の両チャンネルへ同じイベントを流す。 */
export async function publishToThreadAndBoard(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  threadId: number,
  boardId: number,
  type: RealtimeEventType,
  data: unknown,
): Promise<void> {
  await Promise.all([
    publishEvent(env, ctx, threadChannel(threadId), type, data),
    publishEvent(env, ctx, boardChannel(boardId), type, data),
  ]);
}