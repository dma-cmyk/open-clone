// 認証・TOTP・セッションの共有スキーマ。
// API のリクエスト/レスポンス型と web クライアントの型を単一の定義から共有する。

import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, TOTP_DIGITS } from "../constants";
import { accountSchema, type Account } from "./account";

/** TOTP 6桁コード（RFC 6238 / 要件固定） */
export const totpCodeSchema = z.string().regex(new RegExp(`^\\d{${TOTP_DIGITS}}$`), "6桁の数字を入力してください");

/** リカバリーコード（例: ABC123-DEF456-GHI789-JKL012） */
export const recoveryCodeSchema = z.string().min(8).max(64);

// --- セッション ---------------------------------------------------------

export const authSessionSchema = z.object({
  account: accountSchema,
  expiresAt: z.number().int(),
  /** TOTP 必須アカウントが未登録（再登録待ち）のとき true */
  totpSetupRequired: z.boolean(),
  totp: z.object({
    enabled: z.boolean(),
    required: z.boolean(),
    recoveryRemaining: z.number().int().nonnegative(),
  }),
  /** 特別管理人が所有者により停止中なら true（管理 API は全て拒否） */
  specialAdminStopped: z.boolean(),
  /** 直近の高リスク操作に使える TOTP 再認証が有効か */
  stepUpActive: z.boolean(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const sessionStateSchema = z.union([
  z.object({ authenticated: z.literal(false) }),
  z.object({ authenticated: z.literal(true) }).merge(authSessionSchema),
]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const loginResultSchema = z.object({
  account: accountSchema,
  expiresAt: z.number().int(),
  totpSetupRequired: z.boolean(),
});
export type LoginResult = z.infer<typeof loginResultSchema>;

export const registerResultSchema = loginResultSchema;
export type RegisterResult = z.infer<typeof registerResultSchema>;

// --- TOTP ---------------------------------------------------------------

export const totpSetupResultSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TotpSetupResult = z.infer<typeof totpSetupResultSchema>;

export const totpEnableRequestSchema = z.object({
  /** setup で返した secret。再取得できない場合に備えて受け取れる（サーバ保存値と照合） */
  secret: z.string().optional(),
  code: totpCodeSchema,
});
export type TotpEnableRequest = z.infer<typeof totpEnableRequestSchema>;

export const totpEnableResultSchema = z.object({
  recoveryCodes: z.array(z.string()),
});
export type TotpEnableResult = z.infer<typeof totpEnableResultSchema>;

export const totpDisableRequestSchema = z.object({ code: totpCodeSchema });
export type TotpDisableRequest = z.infer<typeof totpDisableRequestSchema>;

export const totpStatusSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
  lockedUntil: z.number().int().nullable(),
  recoveryRemaining: z.number().int().nonnegative(),
});
export type TotpStatus = z.infer<typeof totpStatusSchema>;

// --- リカバリー ---------------------------------------------------------

export const recoveryRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  code: recoveryCodeSchema,
});
export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;

export const recoveryResultSchema = z.object({
  account: accountSchema,
  expiresAt: z.number().int(),
  /** リカバリー後は TOTP がリセットされ再登録が必要 */
  totpSetupRequired: z.boolean(),
  recoveryRemaining: z.number().int().nonnegative(),
});
export type RecoveryResult = z.infer<typeof recoveryResultSchema>;

export const regenerateRecoveryRequestSchema = z.object({ code: totpCodeSchema });
export type RegenerateRecoveryRequest = z.infer<typeof regenerateRecoveryRequestSchema>;

export const regenerateRecoveryResultSchema = z.object({ recoveryCodes: z.array(z.string()) });
export type RegenerateRecoveryResult = z.infer<typeof regenerateRecoveryResultSchema>;

// --- 高リスク操作の再認証（step-up） -----------------------------------

export const stepUpRequestSchema = z.object({
  /** TOTP コードまたはリカバリーコード */
  code: z.string().min(6).max(64),
});
export type StepUpRequest = z.infer<typeof stepUpRequestSchema>;

export const stepUpResultSchema = z.object({
  verifiedUntil: z.number().int(),
});
export type StepUpResult = z.infer<typeof stepUpResultSchema>;

// --- プロフィール -------------------------------------------------------

export const profileSchema = z.object({
  id: z.string().length(26),
  name: z.string().min(1).max(64),
  email: z.string().email().nullable(),
  role: z.enum(["owner", "special_admin", "user"]),
  status: z.enum(["active", "suspended"]),
  bio: z.string().max(500),
  createdAt: z.number().int(),
});
export type Profile = z.infer<typeof profileSchema>;

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  bio: z.string().max(500).optional(),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export const passwordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});
export type PasswordChangeRequest = z.infer<typeof passwordChangeRequestSchema>;

export const sessionInfoSchema = z.object({
  /** token の SHA-256（生トークンは返さない） */
  id: z.string(),
  ua: z.string().nullable(),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int(),
  expiresAt: z.number().int(),
  current: z.boolean(),
});
export type SessionInfoView = z.infer<typeof sessionInfoSchema>;

// --- GitHub OAuth ログイン ---------------------------------------------
// 連携（WP4 の /v1/github/oauth/*、要ログイン）とは別に、未認証で GitHub の確認済みメールから
// アカウントを作成/既存メールへ紐付けてログインする（WP6 の /v1/auth/github/*）。

export const githubLoginStatusSchema = z.object({
  /** GitHub OAuth App が設定済みでログインを開始できるか */
  available: z.boolean(),
});
export type GithubLoginStatus = z.infer<typeof githubLoginStatusSchema>;

export const githubLoginStartSchema = z.object({
  authorizeUrl: z.string().url(),
  state: z.string(),
});
export type GithubLoginStart = z.infer<typeof githubLoginStartSchema>;

export const githubLoginCallbackSchema = z.object({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(4096),
});
export type GithubLoginCallback = z.infer<typeof githubLoginCallbackSchema>;

export const githubLoginResultSchema = z.object({
  account: accountSchema,
  expiresAt: z.number().int(),
  /** このログインで新規アカウントを作成した */
  created: z.boolean(),
  /** 既存のメール一致アカウントへ GitHub を紐付けた */
  linkedExisting: z.boolean(),
  githubLogin: z.string(),
});
export type GithubLoginResult = z.infer<typeof githubLoginResultSchema>;

/** アカウント型の再輸出（web から `shared` の 1 import で済むように） */
export type { Account };