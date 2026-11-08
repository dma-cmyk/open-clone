// 管理 API の認可ガード。
// owner / special_admin を判定し、特別管理人の「停止」「TOTP 必須」をサーバ側で強制する。
// UI の表示制御は補助に過ぎない（DESIGN §5.4）。

import { createMiddleware } from "hono/factory";
import { ApiError, ErrorCode } from "shared";
import { getReqCtx } from "../../lib/context";
import type { AppEnv } from "../../lib/env";
import { getSpecialAdminStop } from "./special-admin";

/** owner または special_admin。特別管理人が停止中なら 403。 */
export const requireAdminActive = createMiddleware<AppEnv>(async (c, next) => {
  const ctx = getReqCtx(c);
  const session = ctx.session;
  if (!session) throw ApiError.unauthorized();
  if (session.account.status !== "active") {
    throw ApiError.forbidden("アカウントが停止されています");
  }
  const role = session.account.role;
  if (role === "owner") {
    await next();
    return;
  }
  if (role !== "special_admin") throw ApiError.forbidden("管理者権限が必要です");
  const stop = await getSpecialAdminStop(c.env.DB, session.account.id);
  if (stop) {
    throw new ApiError(403, ErrorCode.FORBIDDEN, "特別管理人権限は停止されています", {
      reason: "special_admin_stopped",
      stoppedAt: stop.stoppedAt,
      note: stop.reason,
    });
  }
  await next();
});

/** 所有者専用（最終権限）。特別管理人は 403。 */
export const requireOwnerActive = createMiddleware<AppEnv>(async (c, next) => {
  const ctx = getReqCtx(c);
  const session = ctx.session;
  if (!session) throw ApiError.unauthorized();
  if (session.account.status !== "active") throw ApiError.forbidden("アカウントが停止されています");
  if (session.account.role !== "owner") throw ApiError.forbidden("サイト所有者のみ実行できます");
  await next();
});