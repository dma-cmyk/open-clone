// アカウント系サービスの公開窓口。
// CONTRACTS §12 の結合点（verifySession / issueInvite）はここから再輸出する。
// 注: 実装上の都合で D1Database を第 1 引数に取る（WP0 の requestContext は同一クエリを内包しており未使用）。

export { verifySession, createSession, revokeSession, revokeAllSessions, listSessions, countActiveSessions, SESSION_SECONDS } from "./session";
export type { SessionVerification, CreatedSession, SessionRow } from "./session";
export {
  issueInvite,
  findInviteByKey,
  inspectInvite,
  consumeInvite,
  listInvites,
  revokeInvite,
  inviteState,
  inviteSummary,
  inviteMeta,
  countPendingInvites,
} from "./invite";
export type { InviteRow, InviteMeta, InviteOptions } from "./invite";
export { hashPassword, verifyPassword } from "./password";
export { encryptSecret, decryptSecret } from "./crypto";
export * as totpService from "./totp";
export * as recoveryService from "./recovery";
export { getSiteSettings, updateSiteSettings, DEFAULT_SITE_SETTINGS } from "./site-config";
export { createSuspension, liftSuspension, listSuspensions, findActiveSiteSuspension } from "./suspension";
export { ownerExists, bootstrapOwner } from "./bootstrap";
export { grantStepUp, getStepUpExpiry, requireStepUp, STEP_UP_TTL_SECONDS } from "./step-up";
export { requireAdminActive, requireOwnerActive } from "./guards";
export { getSpecialAdminState, getSpecialAdminStop, stopSpecialAdmin, restoreSpecialAdmin, listSpecialAdmins } from "./special-admin";
export { buildAuthSession, accountDto, getAccountRow } from "./view";
export type { AccountRow } from "./view";