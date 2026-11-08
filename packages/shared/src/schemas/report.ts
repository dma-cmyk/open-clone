// 通報（削除依頼）の契約スキーマ。open2ch の理由選択に準拠。

import { z } from "zod";

export const REPORT_REASONS = ["abuse", "spam", "offtopic", "adult", "csam", "illegal", "other"] as const;
export const reportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof reportReasonSchema>;

/** 理由の日本語ラベル（UI と通知で共用）。 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  abuse: "荒らし・嫌がらせ",
  spam: "宣伝・スパム",
  offtopic: "板・スレ違い",
  adult: "エロ・グロ",
  csam: "児童ポルノ",
  illegal: "違法行為",
  other: "その他",
};

export const reportStatusSchema = z.enum(["pending", "accepted", "rejected", "resolved"]);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const reportSchema = z.object({
  id: z.string(),
  boardId: z.number().int(),
  boardSlug: z.string(),
  threadId: z.number().int(),
  threadTitle: z.string(),
  postIds: z.array(z.number().int()),
  nums: z.string(),
  reason: reportReasonSchema,
  comment: z.string(),
  status: reportStatusSchema,
  handledBy: z.string().nullable(),
  handledAt: z.number().int().nullable(),
  note: z.string().nullable(),
  createdAt: z.number().int(),
});
export type Report = z.infer<typeof reportSchema>;

export const createReportRequestSchema = z.object({
  boardId: z.number().int().positive().optional(),
  boardSlug: z.string().max(32).optional(),
  threadId: z.number().int().positive(),
  posts: z.string().max(256).default("all"),
  reason: reportReasonSchema,
  comment: z.string().max(1000).default(""),
  turnstileToken: z.string().optional(),
});
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

export const handleReportRequestSchema = z.object({
  action: z.enum(["reject", "resolve", "hide", "delete"]),
  note: z.string().max(1000).default(""),
});
export type HandleReportRequest = z.infer<typeof handleReportRequestSchema>;

export const reportListQuerySchema = z.object({
  status: reportStatusSchema.optional(),
  boardId: z.coerce.number().int().positive().optional(),
  boardSlug: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(64).optional(),
});