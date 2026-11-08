// API レスポンス envelope と cursor ページネーション（CONTRACTS.md §3）。

import { z } from "zod";

/** 成功応答: `{ ok: true, data }` */
export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ ok: z.literal(true), data });
}

/** 失敗応答: `{ ok: false, code, message, details? }` */
export const apiErrorSchema = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;
export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function err(code: string, message: string, details?: unknown): ApiErrorBody {
  return details === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, details };
}

/** cursor ページネーションのクエリ。cursor は opaque 文字列（実装側で base64 等にする）。 */
export const cursorPaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

export interface CursorPage<T> {
  items: T[];
  /** 続きがある場合のみ非 null */
  nextCursor: string | null;
}

export function cursorPageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
