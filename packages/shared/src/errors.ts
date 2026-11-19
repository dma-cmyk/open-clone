// エラーコードと ApiError。全 API のエラー応答はこの envelope に統一する（CONTRACTS.md §3）。

export const ErrorCode = {
  INTERNAL: "INTERNAL",
  MISCONFIGURED: "MISCONFIGURED",
  NOT_FOUND: "NOT_FOUND",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  VALIDATION: "VALIDATION",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  BAD_ORIGIN: "BAD_ORIGIN",
  TURNSTILE_FAILED: "TURNSTILE_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  BANNED: "BANNED",
  CONFLICT: "CONFLICT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  AI_STOPPED: "AI_STOPPED",
  BAD_GATEWAY: "BAD_GATEWAY",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** プラグイン AI 連携がサイト側で未設定（接続先なし）。ダミー応答は返さない。 */
  AI_DISABLED: "AI_DISABLED",
  // WP6: 認証・TOTP・招待（CONTRACTS §2.1 の新設手順に従い追加）
  TOTP_REQUIRED: "TOTP_REQUIRED",
  TOTP_INVALID: "TOTP_INVALID",
  TOTP_LOCKED: "TOTP_LOCKED",
  STEP_UP_REQUIRED: "STEP_UP_REQUIRED",
  INVITE_INVALID: "INVITE_INVALID",
  OWNER_SETUP_CLOSED: "OWNER_SETUP_CLOSED",
  /** パスワード再設定の復旧コード・再設定 URL が無効（存在しないメール・誤り・期限切れ・使用済み・失効を区別しない） */
  RESET_INVALID: "RESET_INVALID",
  // AI ペットの中継（POST /v1/pet/chat）。事業者側の失敗を区別して画面で案内する。
  /** 事業者が API キーを拒否した（401/403）。502 で返す（このサイトの認証失敗と混同させない）。 */
  PET_PROVIDER_AUTH: "PET_PROVIDER_AUTH",
  /** 事業者側の回数・残高制限（429）。 */
  PET_PROVIDER_RATE_LIMITED: "PET_PROVIDER_RATE_LIMITED",
  /** 事業者がモデル名などの要求を拒否した、または応答を解釈できない。 */
  PET_PROVIDER_ERROR: "PET_PROVIDER_ERROR",
  /** 事業者が時間内に応答しなかった。 */
  PET_PROVIDER_TIMEOUT: "PET_PROVIDER_TIMEOUT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** API が投げる想定内エラー。error middleware が envelope に変換する。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(400, ErrorCode.VALIDATION, message, details);
  }
  static unauthorized(message = "認証が必要です"): ApiError {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
  }
  static forbidden(message = "権限がありません"): ApiError {
    return new ApiError(403, ErrorCode.FORBIDDEN, message);
  }
  static notFound(message = "見つかりません"): ApiError {
    return new ApiError(404, ErrorCode.NOT_FOUND, message);
  }
  static conflict(message: string): ApiError {
    return new ApiError(409, ErrorCode.CONFLICT, message);
  }
  static rateLimited(message = "リクエストが多すぎます"): ApiError {
    return new ApiError(429, ErrorCode.RATE_LIMITED, message);
  }
  static notImplemented(owner: string): ApiError {
    return new ApiError(501, ErrorCode.NOT_IMPLEMENTED, `このエンドポイントは ${owner} が実装予定です`);
  }
}
