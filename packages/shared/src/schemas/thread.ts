// スレッド（threads / thread_state / thread_subs）の契約スキーマ。

import { z } from "zod";
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX, THREAD_MAX_POSTS, THREAD_MAX_POSTS_OWNER } from "../constants";

export const threadStatusSchema = z.enum(["active", "closed", "deleted"]);
export const threadSortSchema = z.enum(["bump", "speed", "created", "posts"]);

/** スレタイに埋め込まれるフラグ（`!no_id` / `!sage` / `!oekaki` / `!maxNNN` / `!timer`）。 */
export const threadTitleFlagsSchema = z.object({
  noId: z.boolean().default(false),
  sage: z.boolean().default(false),
  oekaki: z.boolean().default(false),
  maxPosts: z.number().int().min(10).max(999).nullable().default(null),
  timer: z.boolean().default(false),
  live: z.boolean().default(false),
});
export type ThreadTitleFlags = z.infer<typeof threadTitleFlagsSchema>;

/** スレ主自治の状態（`thread_state.state` に JSON で保存）。 */
export const threadStateSchema = z.object({
  /** アク禁された ID（表示ID。日付で回転するため当日分のみ有効） */
  akuIds: z.array(z.string().max(16)).max(200).default([]),
  /** アク禁された端末ハッシュ */
  akuDevices: z.array(z.string().max(128)).max(200).default([]),
  /** アク禁の有効期限（Unix 秒）。null = 無期限 */
  akuExpiresAt: z.number().int().nullable().default(null),
  /** 画像投稿の一時禁止 */
  nopic: z.boolean().default(false),
  /** コテ禁 */
  ngk: z.boolean().default(false),
  /** 自演防止 ID 表示 */
  jien: z.boolean().default(false),
  /** `!add` の使用回数（上限 50） */
  addCount: z.number().int().min(0).max(50).default(0),
  /** `!reset` の最終実行時刻 */
  resetAt: z.number().int().nullable().default(null),
});
export type ThreadState = z.infer<typeof threadStateSchema>;

export const threadSchema = z.object({
  id: z.number().int().positive(),
  boardId: z.number().int().positive(),
  boardSlug: z.string(),
  boardName: z.string(),
  title: z.string(),
  titleFlags: threadTitleFlagsSchema,
  live: z.boolean(),
  postCount: z.number().int().nonnegative(),
  maxPosts: z.number().int().positive(),
  lastPostAt: z.number().int(),
  bumpAt: z.number().int(),
  pinned: z.boolean(),
  status: threadStatusSchema,
  createdAt: z.number().int(),
});
export type Thread = z.infer<typeof threadSchema>;

export const threadSummarySchema = threadSchema.pick({
  id: true,
  boardId: true,
  boardSlug: true,
  boardName: true,
  title: true,
  postCount: true,
  lastPostAt: true,
  createdAt: true,
  live: true,
  pinned: true,
  status: true,
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const createThreadRequestSchema = z.object({
  boardId: z.number().int().positive().optional(),
  boardSlug: z.string().max(32).optional(),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(4096),
  name: z.string().max(64).optional(),
  mail: z.string().max(256).optional(),
  attachments: z.array(z.string().max(64)).max(10).optional(),
  turnstileToken: z.string().optional(),
});
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const threadListQuerySchema = z.object({
  sort: threadSortSchema.default("bump"),
  q: z.string().max(100).optional(),
  tag: z.string().max(30).optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
});

export const threadPostsQuerySchema = z.object({
  /** open2ch の read.cgi 作法: `l50` / `1-100` / `7` / `3,4,8` / `-100` / `all` */
  r: z.string().max(64).optional(),
  /** 指定レス番以降（`l50` と併用可） */
  from: z.coerce.number().int().min(1).optional(),
  /** レス ID 抽出（ID 文字列 or jien の 2 文字） */
  id: z.string().max(16).optional(),
  /** スレ内ワード検索 */
  q: z.string().max(100).optional(),
  /** 画像付きレスのみ */
  images: z.enum(["1", "true"]).optional(),
  /** ポーリング用: この post id より新しいレスだけ */
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
});
export type ThreadPostsQuery = z.infer<typeof threadPostsQuerySchema>;

export interface ResolvedRange {
  /** 取得対象のレス番号（昇順・重複なし）。null = 範囲全体 */
  nums: number[] | null;
  from: number | null;
  to: number | null;
  limit: number;
  mode: "last" | "range" | "nums" | "single" | "first" | "all";
}

/**
 * `?r=` の範囲指定を解釈する（open2ch read.cgi 互換）。
 * - `l50`   最新 50（既定）
 * - `1-100` 1〜100
 * - `7`     7 のみ
 * - `3,4,8` 該当レス（最大 100 件）
 * - `-100`  先頭 100
 * - `all`   全件（上限 1000）
 */
export function parsePostRange(range: string | undefined, totalPosts: number): ResolvedRange {
  const fallback: ResolvedRange = { nums: null, from: null, to: null, limit: 50, mode: "last" };
  if (!range) return fallback;
  const value = range.trim().toLowerCase();

  if (value === "all") {
    return { nums: null, from: 1, to: null, limit: Math.min(Math.max(totalPosts, 1), 1000), mode: "all" };
  }

  const last = /^l(\d{1,4})$/.exec(value);
  if (last) {
    const count = Math.min(Math.max(Number(last[1]), 1), PAGE_LIMIT_MAX);
    return { nums: null, from: null, to: null, limit: count, mode: "last" };
  }

  const first = /^-(\d{1,4})$/.exec(value);
  if (first) {
    const count = Math.min(Math.max(Number(first[1]), 1), 1000);
    return { nums: null, from: 1, to: count, limit: count, mode: "first" };
  }

  const span = /^(\d{1,4})-(\d{1,4})$/.exec(value);
  if (span) {
    const from = Math.max(1, Number(span[1]));
    const to = Math.max(from, Number(span[2]));
    return { nums: null, from, to, limit: Math.min(to - from + 1, 1000), mode: "range" };
  }

  if (/^\d{1,4}$/.test(value)) {
    const num = Number(value);
    return { nums: [num], from: num, to: num, limit: 1, mode: "single" };
  }

  if (/^\d{1,4}(,\d{1,4})*$/.test(value)) {
    const nums = Array.from(new Set(value.split(",").map(Number))).sort((a, b) => a - b).slice(0, 100);
    return {
      nums,
      from: nums[0] ?? null,
      to: nums[nums.length - 1] ?? null,
      limit: nums.length,
      mode: "nums",
    };
  }

  return fallback;
}

/** スレの実効レス上限（スレ主は +5）。 */
export function effectiveMaxPosts(maxPosts: number, requesterIsOwner: boolean): number {
  const base = Math.min(Math.max(maxPosts, 10), THREAD_MAX_POSTS);
  return requesterIsOwner ? Math.min(base + 5, THREAD_MAX_POSTS_OWNER) : base;
}