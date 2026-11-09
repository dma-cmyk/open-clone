// 管理系（招待・停止・サイト設定・監査・特別管理人）の共有スキーマ。

import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../constants";
import { accountSchema } from "./account";
import { totpCodeSchema } from "./auth";

// --- 招待（一回限りの就任キー） ----------------------------------------

export const inviteKindSchema = z.enum(["special_admin", "board_staff"]);
export type InviteKind = z.infer<typeof inviteKindSchema>;

export const inviteIssueRequestSchema = z.object({
  kind: inviteKindSchema.default("special_admin"),
  /** 有効時間（時間）。既定 72h・上限 720h */
  expiresInHours: z.number().int().min(1).max(720).optional(),
  note: z.string().max(200).optional(),
  /** 既存アカウントへの再招待（TOTP リセット後の復旧など）。owner のみ指定可 */
  accountId: z.string().length(26).optional(),
  /** kind=board_staff のときの割当先（WP1 の board_staff へ引き継ぐメタ情報） */
  boardId: z.number().int().positive().optional(),
  level: z.enum(["admin", "deputy", "moderator"]).optional(),
});
export type InviteIssueRequest = z.infer<typeof inviteIssueRequestSchema>;

export const inviteIssueResultSchema = z.object({
  id: z.string(),
  /** 生キーはこのレスポンスでのみ返す（DB にはハッシュのみ保存） */
  key: z.string(),
  kind: inviteKindSchema,
  expiresAt: z.number().int(),
  acceptPath: z.string(),
});
export type InviteIssueResult = z.infer<typeof inviteIssueResultSchema>;

export const inviteSummarySchema = z.object({
  id: z.string(),
  kind: inviteKindSchema,
  note: z.string().nullable(),
  issuedBy: z.string().nullable(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  usedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
  state: z.enum(["pending", "used", "expired", "revoked"]),
});
export type InviteSummary = z.infer<typeof inviteSummarySchema>;

export const inviteInspectSchema = z.object({
  valid: z.boolean(),
  kind: inviteKindSchema.nullable(),
  expiresAt: z.number().int().nullable(),
  note: z.string().nullable(),
  /** 再招待（既存アカウント）のときのみ、本人が入力済みの情報をプリフィルする */
  accountName: z.string().nullable(),
  email: z.string().nullable(),
  reason: z.string().nullable(),
});
export type InviteInspect = z.infer<typeof inviteInspectSchema>;

export const totpSecretPrepareRequestSchema = z.object({ key: z.string().min(8) });
export type TotpSecretPrepareRequest = z.infer<typeof totpSecretPrepareRequestSchema>;

export const totpSecretPrepareResultSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
});
export type TotpSecretPrepareResult = z.infer<typeof totpSecretPrepareResultSchema>;

export const inviteAcceptRequestSchema = z.object({
  key: z.string().min(8),
  name: z.string().trim().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  totpSecret: z.string().min(16),
  totpCode: totpCodeSchema,
});
export type InviteAcceptRequest = z.infer<typeof inviteAcceptRequestSchema>;

export const inviteAcceptResultSchema = z.object({
  account: accountSchema,
  expiresAt: z.number().int(),
  recoveryCodes: z.array(z.string()),
  /** kind=board_staff の場合の割当情報（WP1 の板スタッフ API で確定させる） */
  boardAssignment: z
    .object({ boardId: z.number().int(), level: z.enum(["admin", "deputy", "moderator"]) })
    .nullable(),
});
export type InviteAcceptResult = z.infer<typeof inviteAcceptResultSchema>;

// --- 所有者ブートストラップ --------------------------------------------

// 所有者の有無は未認証で公開しない（報告書 24 L-3）。status 用スキーマは廃止した。

export const ownerBootstrapRequestSchema = z.object({
  bootstrapKey: z.string().min(1),
  name: z.string().trim().min(1).max(64),
  email: z.string().email(),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  totpSecret: z.string().min(16),
  totpCode: totpCodeSchema,
});
export type OwnerBootstrapRequest = z.infer<typeof ownerBootstrapRequestSchema>;

export const ownerBootstrapResultSchema = z.object({
  account: accountSchema,
  expiresAt: z.number().int(),
  recoveryCodes: z.array(z.string()),
});
export type OwnerBootstrapResult = z.infer<typeof ownerBootstrapResultSchema>;

// --- 停止・規制（suspensions） -----------------------------------------

export const suspensionScopeSchema = z.enum(["site", "board"]);
export type SuspensionScope = z.infer<typeof suspensionScopeSchema>;

export const suspensionCreateRequestSchema = z
  .object({
    accountId: z.string().length(26).optional(),
    email: z.string().email().optional(),
    deviceHash: z.string().min(8).max(128).optional(),
    scope: suspensionScopeSchema,
    boardId: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(500),
    /** 有効期限（Unix 秒）。省略時は無期限／durationHours を優先 */
    expiresAt: z.number().int().positive().optional(),
    durationHours: z.number().int().min(1).max(24 * 365).optional(),
  })
  .refine((v) => v.accountId !== undefined || v.email !== undefined || v.deviceHash !== undefined, {
    message: "accountId・email・deviceHash のいずれかが必要です",
  })
  .refine((v) => v.scope !== "board" || v.boardId !== undefined, {
    message: "board スコープには boardId が必要です",
  });
export type SuspensionCreateRequest = z.infer<typeof suspensionCreateRequestSchema>;

export const suspensionSchema = z.object({
  id: z.string(),
  accountId: z.string().nullable(),
  email: z.string().nullable(),
  deviceHash: z.string().nullable(),
  scope: suspensionScopeSchema,
  boardId: z.number().int().nullable(),
  reason: z.string(),
  by: z.string(),
  expiresAt: z.number().int().nullable(),
  liftedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  /** 現時点で有効か（lifted/expired を考慮） */
  active: z.boolean(),
});
export type Suspension = z.infer<typeof suspensionSchema>;

// --- サイト設定 ---------------------------------------------------------

export const siteSettingsSchema = z.object({
  "site.name": z.string().trim().min(1).max(80),
  "site.description": z.string().max(300),
  "registration.open": z.boolean(),
  "security.require_turnstile": z.enum(["always", "auto", "off"]),
  "security.special_admin_totp_required": z.boolean(),
  "security.login_max_failures": z.number().int().min(3).max(50),
  /**
   * プラグイン AI 連携（ai:complete）の接続先。空文字なら無効（ダミー応答は返さない）。
   * API キーは site_config に置かず Worker secret `PLUGIN_AI_API_KEY` を使う。
   * baseUrl は OpenAI 互換 API のベース（例: https://api.openai.com/v1）。
   */
  "plugin.ai.baseUrl": z.union([z.literal(""), z.string().url().max(500)]),
  "plugin.ai.model": z.string().trim().min(1).max(100),
});
export type SiteSettings = z.infer<typeof siteSettingsSchema>;
export type SiteSettingKey = keyof SiteSettings;

export const siteSettingsUpdateSchema = siteSettingsSchema.partial();
export type SiteSettingsUpdate = z.infer<typeof siteSettingsUpdateSchema>;

// --- 監査ログ -----------------------------------------------------------

export const auditLogQuerySchema = z.object({
  action: z.string().optional(),
  actorId: z.string().optional(),
  since: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  actorType: z.enum(["owner", "special_admin", "account", "board_staff", "system"]),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  detail: z.unknown(),
  createdAt: z.number().int(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

// --- 管理画面用ユーザー/概要 ------------------------------------------

export const adminUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: z.enum(["owner", "special_admin", "user"]),
  status: z.enum(["active", "suspended"]),
  createdAt: z.number().int(),
  specialAdminStopped: z.boolean(),
  activeSuspensions: z.number().int(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminOverviewSchema = z.object({
  accounts: z.number().int(),
  activeSessions: z.number().int(),
  specialAdmins: z.number().int(),
  stoppedSpecialAdmins: z.number().int(),
  activeSuspensions: z.number().int(),
  pendingInvites: z.number().int(),
  auditEvents24h: z.number().int(),
  ownerExists: z.boolean(),
});
export type AdminOverview = z.infer<typeof adminOverviewSchema>;

// --- 特別管理人 ---------------------------------------------------------

export const specialAdminSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  status: z.enum(["active", "suspended"]),
  stoppedAt: z.number().int().nullable(),
  stoppedBy: z.string().nullable(),
  stopReason: z.string().nullable(),
  totpEnabled: z.boolean(),
  recoveryRemaining: z.number().int(),
  createdAt: z.number().int(),
});
export type SpecialAdmin = z.infer<typeof specialAdminSchema>;

export const specialAdminStopRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type SpecialAdminStopRequest = z.infer<typeof specialAdminStopRequestSchema>;

export const specialAdminTotpResetRequestSchema = z.object({
  /** true なら復旧用の就任キーを同時発行する */
  reinvite: z.boolean().default(false),
  note: z.string().max(200).optional(),
});
export type SpecialAdminTotpResetRequest = z.infer<typeof specialAdminTotpResetRequestSchema>;

export const specialAdminTotpResetResultSchema = z.object({
  invite: inviteIssueResultSchema.nullable(),
  sessionsRevoked: z.number().int(),
});
export type SpecialAdminTotpResetResult = z.infer<typeof specialAdminTotpResetResultSchema>;