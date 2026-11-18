// レス（posts / post_reactions / polls）の契約スキーマ。

import { z } from "zod";
import {
  TSUBUYAKI_MAX_CHARS,
  POLL_MAX_OPTIONS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  HIDDEN_POST_EXCERPT_CHARS,
} from "../constants";
import { boardStatusSchema } from "./board";

export const postKindSchema = z.enum(["post", "tsubuyaki"]);
export type PostKind = z.infer<typeof postKindSchema>;

export const attachmentSummarySchema = z.object({
  id: z.string().optional(),
  url: z.string(),
  contentType: z.string().default("application/octet-stream"),
  size: z.number().int().nonnegative().default(0),
  name: z.string().optional(),
});
export type AttachmentSummary = z.infer<typeof attachmentSummarySchema>;

export const postSchema = z.object({
  id: z.number().int().positive(),
  threadId: z.number().int().positive(),
  boardId: z.number().int().positive(),
  num: z.number().int().nonnegative(),
  kind: postKindSchema,
  name: z.string(),
  mail: z.string(),
  trip: z.string().nullable(),
  cap: z.string().nullable(),
  body: z.string(),
  createdAt: z.number().int(),
  idHash: z.string(),
  sage: z.boolean(),
  isOp: z.boolean(),
  isSub: z.boolean(),
  attachments: z.array(attachmentSummarySchema),
  likeCount: z.number().int().nonnegative(),
  liked: z.boolean(),
  /** 逆参照（このレスを安価しているレス番号） */
  backlinks: z.array(z.number().int().nonnegative()),
  /** 本人による編集回数（0 = 未編集） */
  editedCount: z.number().int().nonnegative().default(0),
  selfDeleted: z.boolean().default(false),
  /** リクエスト主体が書いたレスか（本人編集・本人削除ボタンの表示用。判定は API 側） */
  mine: z.boolean().default(false),
  hidden: z.boolean(),
  aiAgentId: z.string().nullable(),
});
export type Post = z.infer<typeof postSchema>;

export const createPostRequestSchema = z.object({
  threadId: z.number().int().positive().optional(),
  name: z.string().max(64).optional(),
  mail: z.string().max(256).optional(),
  body: z.string().min(1).max(4096),
  sage: z.boolean().optional(),
  attachments: z.array(z.string().max(64)).max(10).optional(),
  turnstileToken: z.string().optional(),
});
export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;

export const tsubuyakiRequestSchema = z.object({
  body: z.string().min(1).max(TSUBUYAKI_MAX_CHARS * 4),
  name: z.string().max(64).optional(),
  parentPostId: z.number().int().positive().optional(),
  /** 未ログイン時の Turnstile トークン（通常投稿と同じ受け渡し）。 */
  turnstileToken: z.string().max(4096).optional(),
});
export type TsubuyakiRequest = z.infer<typeof tsubuyakiRequestSchema>;

/** 本人によるレス本文編集のリクエスト（名前・メール・添付は対象外）。 */
export const editPostRequestSchema = z.object({
  body: z.string().min(1).max(4096),
  /** 板が Turnstile always のとき編集にも要求される（投稿と同じ条件） */
  turnstileToken: z.string().max(4096).optional(),
});
export type EditPostRequest = z.infer<typeof editPostRequestSchema>;

/** 編集履歴の 1 件（旧本文を誰でも閲覧可能）。 */
export const postEditHistoryItemSchema = z.object({
  id: z.number().int().positive(),
  postId: z.number().int().positive(),
  previousBody: z.string(),
  editedAt: z.number().int(),
});
export type PostEditHistoryItem = z.infer<typeof postEditHistoryItemSchema>;

export const reactionKindSchema = z.enum(["like", "good", "bad"]);
export type ReactionKind = z.infer<typeof reactionKindSchema>;

export const reactionRequestSchema = z.object({
  kind: reactionKindSchema.default("like"),
});

export const reactionResultSchema = z.object({
  postId: z.number().int(),
  kind: reactionKindSchema,
  count: z.number().int().nonnegative(),
  liked: z.boolean(),
});

/** 投票記法 `[ank:10m:A,B,C]`（期間 10 秒〜30 日・最大 10 項目・1 IP 1 票）。 */
export const pollSchema = z.object({
  id: z.number().int().positive(),
  postId: z.number().int().positive(),
  threadId: z.number().int().positive(),
  options: z.array(z.string()),
  endsAt: z.number().int(),
  createdAt: z.number().int(),
});
export type Poll = z.infer<typeof pollSchema>;

export const pollResultSchema = pollSchema.extend({
  counts: z.array(z.number().int().nonnegative()),
  totalVotes: z.number().int().nonnegative(),
  votedOption: z.number().int().nullable(),
});
export type PollResult = z.infer<typeof pollResultSchema>;

export const votePollRequestSchema = z.object({
  option: z.number().int().min(0).max(POLL_MAX_OPTIONS - 1),
});

export interface ParsedPoll {
  durationSeconds: number;
  options: string[];
}

/**
 * 本文から投票記法 `[ank:10m:A,B,C]` を抽出する。
 * 期間は `10s` / `10m` / `2h` / `3d`、10 秒〜30 日。項目は 2〜10。
 */
export function parsePollNotation(body: string): ParsedPoll | null {
  const match = /\[ank:(\d{1,5})([smhd]):([^\]\n]{1,500})\]/.exec(body);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const unitSeconds = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86_400;
  const durationSeconds = amount * unitSeconds;
  if (durationSeconds < 10 || durationSeconds > 30 * 86_400) return null;

  const options = match[3]!
    .split(",")
    .map((option) => option.trim())
    .filter((option) => option.length > 0 && option.length <= 40 && !/[\s/]/.test(option))
    .slice(0, POLL_MAX_OPTIONS);
  if (options.length < 2) return null;
  return { durationSeconds, options };
}

/**
 * 管理画面「非表示のレス」の 1 行。全員から非表示（`posts.hidden = 1`）のレスを
 * 板スタッフ・サイト管理者に返す。IP ハッシュ・端末ハッシュ・アカウント ID は含めない。
 * `hiddenAt` / `hiddenByName` は監査ログ（post.hide）から引く。
 * 監査ログ導入前の非表示は記録が無いため null（画面では「不明」）。
 */
export const hiddenPostItemSchema = z.object({
  postId: z.number().int().positive(),
  boardId: z.number().int().positive(),
  boardSlug: z.string(),
  boardName: z.string(),
  boardStatus: boardStatusSchema,
  threadId: z.number().int().positive(),
  threadTitle: z.string(),
  num: z.number().int().nonnegative(),
  name: z.string(),
  excerpt: z.string().max(HIDDEN_POST_EXCERPT_CHARS),
  createdAt: z.number().int(),
  hiddenAt: z.number().int().nullable(),
  hiddenByName: z.string().nullable(),
});
export type HiddenPostItem = z.infer<typeof hiddenPostItemSchema>;

/** 非表示レスの一覧クエリ。`board` はサイト管理画面の板絞り込み（スラッグ）。 */
export const hiddenPostListQuerySchema = z.object({
  board: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().max(64).optional(),
});