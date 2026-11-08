// 板（boards / board_staff / board_bans）の契約スキーマ。

import { z } from "zod";
import { BOARD_AUTODELETE_DAYS, BOARD_CREATE_LIMIT_PER_ACCOUNT, RESERVED_BOARD_SLUGS } from "../constants";

/** 板スラッグ。静的ルート・予約語と衝突しない小文字英数（`-`/`_` 可）。 */
export const boardSlugSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "スラッグは小文字英数字・ハイフン・アンダースコアのみ使用できます")
  .refine(
    (slug) => !(RESERVED_BOARD_SLUGS as readonly string[]).includes(slug),
    "このスラッグは予約されています",
  );

/** 板ごとの NG ワード（部分一致・大文字小文字無視）。 */
export const ngWordSchema = z.string().min(1).max(64);

/** 板設定。`settings` カラムに JSON で保存する。 */
export const boardSettingsSchema = z.object({
  /** 同一端末の連投間隔（秒）。0 = 無効 */
  cooldownSeconds: z.number().int().min(0).max(3600).default(0),
  /** Turnstile 要求方針。anonymous = 未ログインのみ / always = 全投稿 */
  turnstile: z.enum(["off", "anonymous", "always"]).default("anonymous"),
  /** NG ワード。ヒット時の挙動は ngWordAction */
  ngWords: z.array(ngWordSchema).max(200).default([]),
  ngWordAction: z.enum(["reject", "mask"]).default("reject"),
  /** 実況板（スレを live 扱いにできる） */
  live: z.boolean().default(false),
  /** 板全体で ID 非表示（`???`） */
  noId: z.boolean().default(false),
  /** 画像添付の許可 */
  allowImages: z.boolean().default(true),
  /** kome（コメント流し）の許可 */
  kome: z.boolean().default(true),
  /** 既定のレス上限（スレ作成時に `!maxNNN` が無い場合） */
  maxPosts: z.number().int().min(10).max(1000).default(1000),
  /** 使用するアップローダアダプタ（null = サイト既定） */
  uploader: z.string().max(32).nullable().default(null),
  /** 強制 sage（板全体） */
  forceSage: z.boolean().default(false),
  /** アカウント作成可能な板数（サイト既定の上書き。null = 既定値） */
  maxBoardsPerAccount: z.number().int().min(1).max(50).nullable().default(null),
});
export type BoardSettings = z.infer<typeof boardSettingsSchema>;

export const boardDesignSchema = z.object({
  themeColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#ccffcc"),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#228811"),
  /** 板バナー（独自素材のみ。外部 URL 可） */
  bannerUrl: z.string().url().max(512).nullable().default(null),
  /** 追加 CSS（サイズ上限つき。サニタイズは描画側の責任） */
  css: z.string().max(8192).default(""),
});
export type BoardDesign = z.infer<typeof boardDesignSchema>;

export const boardStatusSchema = z.enum(["active", "deleted"]);

export const boardSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string(),
  rulesMd: z.string(),
  design: boardDesignSchema,
  settings: boardSettingsSchema,
  ownerAccountId: z.string().nullable(),
  status: boardStatusSchema,
  lastPostAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type Board = z.infer<typeof boardSchema>;

/** 一覧用の軽量板情報。 */
export const boardSummarySchema = boardSchema
  .pick({
    id: true,
    slug: true,
    name: true,
    category: true,
    description: true,
    status: true,
    lastPostAt: true,
    createdAt: true,
  })
  .extend({
    threadCount: z.number().int().nonnegative(),
    postCount: z.number().int().nonnegative(),
  });
export type BoardSummary = z.infer<typeof boardSummarySchema>;

export const createBoardRequestSchema = z.object({
  slug: boardSlugSchema,
  name: z.string().min(1).max(64),
  category: z.string().min(1).max(32).default("雑談"),
  description: z.string().max(2000).default(""),
  rulesMd: z.string().max(20000).default(""),
  design: boardDesignSchema.partial().optional(),
  settings: boardSettingsSchema.partial().optional(),
  turnstileToken: z.string().optional(),
});
export type CreateBoardRequest = z.infer<typeof createBoardRequestSchema>;

export const updateBoardRequestSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  category: z.string().min(1).max(32).optional(),
  description: z.string().max(2000).optional(),
  rulesMd: z.string().max(20000).optional(),
  design: boardDesignSchema.partial().optional(),
  settings: boardSettingsSchema.partial().optional(),
});
export type UpdateBoardRequest = z.infer<typeof updateBoardRequestSchema>;

export const boardStaffLevelSchema = z.enum(["admin", "deputy", "moderator"]);
export type BoardStaffLevelName = z.infer<typeof boardStaffLevelSchema>;

export const boardStaffSchema = z.object({
  boardId: z.number().int(),
  accountId: z.string(),
  accountName: z.string(),
  level: boardStaffLevelSchema,
  createdAt: z.number().int(),
});
export type BoardStaff = z.infer<typeof boardStaffSchema>;

/** 任免リクエスト。accountId か accountName のどちらかを指定する。 */
export const setBoardStaffRequestSchema = z
  .object({
    accountId: z.string().min(1).max(64).optional(),
    accountName: z.string().min(1).max(64).optional(),
    level: boardStaffLevelSchema,
  })
  .refine((value) => Boolean(value.accountId || value.accountName), {
    message: "accountId または accountName が必要です",
  });
export type SetBoardStaffRequest = z.infer<typeof setBoardStaffRequestSchema>;

export const boardBanKindSchema = z.enum(["device", "ip", "account"]);

export const boardBanSchema = z.object({
  id: z.string(),
  boardId: z.number().int().nullable(),
  identity: z.string(),
  kind: boardBanKindSchema,
  reason: z.string(),
  byAccountId: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type BoardBan = z.infer<typeof boardBanSchema>;

/** アクセス禁止作成。identity は device_hash / ip_hash / account id（kind で解釈）。 */
export const createBoardBanRequestSchema = z.object({
  identity: z.string().min(8).max(128),
  kind: boardBanKindSchema.default("device"),
  reason: z.string().max(500).default(""),
  /** 時間指定（時間単位）。null = 無期限 */
  durationHours: z.number().int().min(1).max(24 * 365).nullable().default(24),
  /** true = サイト全体 BAN（owner / special_admin のみ） */
  site: z.boolean().default(false),
});
export type CreateBoardBanRequest = z.infer<typeof createBoardBanRequestSchema>;

/** 板一覧クエリ。 */
export const boardListQuerySchema = z.object({
  category: z.string().max(32).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const BOARD_DEFAULTS = {
  autoDeleteDays: BOARD_AUTODELETE_DAYS,
  createLimitPerAccount: BOARD_CREATE_LIMIT_PER_ACCOUNT,
} as const;
