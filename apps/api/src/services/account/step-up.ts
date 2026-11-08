// 高リスク操作の TOTP 再認証（step-up）。
// ログイン時の TOTP 成功・または POST /v1/auth/step-up の成功で 5 分間だけ付与する。

import { createMiddleware } from "hono/factory";
import { ApiError, ErrorCode } from "shared";
import { getReqCtx } from "../../lib/context";
import type { AppEnv } from "../../lib/env";

export const STEP_UP_TTL_SECONDS = 300;

export async function grantStepUp(
  db: D1Database,
  tokenHash: string,
  accountId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<number> {
  const expiresAt = now + STEP_UP_TTL_SECONDS;
  await db
    .prepare(
      `INSERT INTO session_stepup (token_hash, account_id, verified_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token_hash) DO UPDATE SET
         account_id = excluded.account_id,
         verified_at = excluded.verified_at,
         expires_at = excluded.expires_at`,
    )
    .bind(tokenHash, accountId, now, expiresAt)
    .run();
  return expiresAt;
}

export async function getStepUpExpiry(
  db: D1Database,
  tokenHash: string,
  now = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  const row = await db
    .prepare("SELECT expires_at FROM session_stepup WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, now)
    .first<{ expires_at: number }>();
  return row?.expires_at ?? null;
}

/** 高リスク操作のミドルウェア。付与が無い・期限切れなら 403 STEP_UP_REQUIRED。 */
export function requireStepUp() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const ctx = getReqCtx(c);
    if (!ctx.session) throw ApiError.unauthorized();
    const expiry = await getStepUpExpiry(c.env.DB, ctx.session.tokenHash);
    if (expiry === null) {
      throw new ApiError(403, ErrorCode.STEP_UP_REQUIRED, "この操作には TOTP による再認証が必要です");
    }
    await next();
  });
}