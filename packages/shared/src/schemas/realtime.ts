// リアルタイム（RealtimeHub DO / WS ticket）のイベント契約。
// WP2/WP3 がこの型を購読する（CONTRACTS §12）。

import { z } from "zod";
import { postSchema } from "./post";
import { threadSummarySchema } from "./thread";
import { RT_TICKET_TTL_SECONDS } from "../constants";

/** チャンネル名。1 DO = 1 チャンネル。 */
export const REALTIME_CHANNEL_PATTERN = /^(board|thread):\d+$/;

export const realtimeChannelSchema = z.string().regex(REALTIME_CHANNEL_PATTERN, "チャンネル名が不正です");

export const REALTIME_EVENT_TYPES = [
  "post.created",
  "post.updated",
  "post.hidden",
  "post.deleted",
  "tsubuyaki.created",
  "thread.created",
  "thread.updated",
  "board.updated",
  "poll.updated",
  "hello",
] as const;

export const realtimeEventTypeSchema = z.enum(REALTIME_EVENT_TYPES);
export type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>;

/** 全イベント共通のエンベロープ。`seq` は再接続差分（`since`）に使う。 */
export const realtimeEventSchema = z.object({
  type: realtimeEventTypeSchema,
  channel: realtimeChannelSchema,
  seq: z.number().int().nonnegative(),
  at: z.number().int(),
  data: z.unknown(),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export const postCreatedEventSchema = realtimeEventSchema.extend({
  type: z.literal("post.created"),
  data: z.object({ post: postSchema, thread: threadSummarySchema.pick({ id: true, postCount: true, lastPostAt: true }) }),
});

export const tsubuyakiCreatedEventSchema = realtimeEventSchema.extend({
  type: z.literal("tsubuyaki.created"),
  data: z.object({ post: postSchema }),
});

export const threadCreatedEventSchema = realtimeEventSchema.extend({
  type: z.literal("thread.created"),
  data: z.object({ thread: threadSummarySchema }),
});

export const rtTicketRequestSchema = z.object({
  channels: z.array(realtimeChannelSchema).min(1).max(10),
});
export type RtTicketRequest = z.infer<typeof rtTicketRequestSchema>;

export const rtTicketResponseSchema = z.object({
  ticket: z.string(),
  expiresAt: z.number().int(),
  channels: z.array(realtimeChannelSchema),
  /** 接続先パス（クライアントは `?ticket=&channel=&since=` を付ける） */
  wsPath: z.string(),
});
export type RtTicketResponse = z.infer<typeof rtTicketResponseSchema>;

/** 板ID・スレIDからチャンネル名を作る。 */
export function threadChannel(threadId: number): string {
  return `thread:${threadId}`;
}
export function boardChannel(boardId: number): string {
  return `board:${boardId}`;
}

export const RT_TICKET_TTL = RT_TICKET_TTL_SECONDS;