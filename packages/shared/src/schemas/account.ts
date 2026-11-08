// アカウント関連スキーマ。

import { z } from "zod";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  TOTP_DIGITS,
} from "../constants";

export const globalRoleSchema = z.enum(["owner", "special_admin", "user"]);
export const accountStatusSchema = z.enum(["active", "suspended"]);

export const accountSchema = z.object({
  id: z.string().length(26), // ULID
  name: z.string().min(1).max(64),
  email: z.string().email().nullable(),
  role: globalRoleSchema,
  status: accountStatusSchema,
  createdAt: z.number().int(), // Unix seconds
});
export type Account = z.infer<typeof accountSchema>;

export const registerRequestSchema = z.object({
  name: z.string().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  turnstileToken: z.string().optional(), // 異常検知時のみ必須（middleware が判定）
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  totpCode: z.string().regex(new RegExp(`^\\d{${TOTP_DIGITS}}$`)).optional(),
  turnstileToken: z.string().optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionSchema = z.object({
  account: accountSchema,
  expiresAt: z.number().int(),
});
export type Session = z.infer<typeof sessionSchema>;
