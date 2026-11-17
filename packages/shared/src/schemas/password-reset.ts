// パスワードを忘れたときの復旧の共有スキーマ（報告書 50 設計）。
// ① 復旧コードでの再設定（未ログイン・TOTP なしでも可）
// ② 所有者が発行する 1 回限りの再設定 URL（未ログイン・24 時間）

import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../constants";
import { recoveryCodeSchema } from "./auth";
import { accountSchema } from "./account";

/** 「パスワードを忘れた」画面: メール＋復旧コード＋新しいパスワード。 */
export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
  code: recoveryCodeSchema,
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/**
 * 復旧コードでの再設定の結果。
 * アカウントの有無は成否でしか分からない（失敗は存在しないメールでも同じエラー）。
 * セッションは発行しない（成功後はログイン画面へ戻す）。
 */
export const passwordResetResultSchema = z.object({
  reset: z.literal(true),
  /** 残りの復旧コード数（成功時のみ。コードの持ち主にだけ返す） */
  recoveryRemaining: z.number().int().nonnegative(),
});
export type PasswordResetResult = z.infer<typeof passwordResetResultSchema>;

/** 運営が発行した URL を開いたときの再設定（トークン＋新しいパスワード）。 */
export const operatorPasswordResetRequestSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type OperatorPasswordResetRequest = z.infer<typeof operatorPasswordResetRequestSchema>;

export const operatorPasswordResetResultSchema = z.object({
  reset: z.literal(true),
  account: accountSchema,
});
export type OperatorPasswordResetResult = z.infer<typeof operatorPasswordResetResultSchema>;

// --- 所有者による発行・失効 ---------------------------------------------

export const passwordResetIssueRequestSchema = z.object({
  accountId: z.string().min(1).max(64),
});
export type PasswordResetIssueRequest = z.infer<typeof passwordResetIssueRequestSchema>;

/** 発行結果。生トークン・URL・mailto はこのレスポンスでのみ返す（DB はハッシュのみ）。 */
export const passwordResetIssueResultSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  /** 送信先（登録メールアドレス）。発行には登録メールが必要。 */
  email: z.string().email(),
  token: z.string(),
  url: z.string(),
  /** mailto: の雛形（宛先・件名・本文に URL 入り） */
  mailtoUrl: z.string(),
  expiresAt: z.number().int(),
});
export type PasswordResetIssueResult = z.infer<typeof passwordResetIssueResultSchema>;

/** 発行済みで未使用の URL（生トークンは返さない）。 */
export const passwordResetTokenSummarySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type PasswordResetTokenSummary = z.infer<typeof passwordResetTokenSummarySchema>;

export const passwordResetTokenListSchema = z.object({
  items: z.array(passwordResetTokenSummarySchema),
  now: z.number().int(),
});
export type PasswordResetTokenList = z.infer<typeof passwordResetTokenListSchema>;