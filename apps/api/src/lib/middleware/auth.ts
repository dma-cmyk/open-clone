// 認証・認可ミドルウェア。
// requireRole / requireBoardStaff / requireOwner / optionalTurnstile を提供する。
// DESIGN §5.4 のサーバ側強制はこのミドルウェアで行う（UI 制御は補助）。

import { createMiddleware } from "hono/factory";
import { ApiError, canAny, rolesOf, type GlobalRole, type PermissionAction, type CanOptions } from "shared";
import type { AppEnv } from "../env";
import { getReqCtx } from "../context";

/** このファイルが返すミドルウェアの型（AppEnv を束縛した Hono ミドルウェア）。 */
export type AppMiddleware = ReturnType<typeof createMiddleware<AppEnv>>;

/** ログイン必須。未ログインなら 401。 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!getReqCtx(c).session) throw ApiError.unauthorized();
  await next();
});

/**
 * 役割必須（グローバルロール）。`roles` は許可するロールのリスト（OR）。
 * 例: `requireRole("owner")`, `requireRole("owner", "special_admin")`
 */
export function requireRole(...roles: GlobalRole[]): AppMiddleware {
  return createMiddleware<AppEnv>(async (c, next) => {
    const session = getReqCtx(c).session;
    if (!session) throw ApiError.unauthorized();
    if (!roles.includes(session.account.role)) throw ApiError.forbidden();
    await next();
  });
}

/** オーナー専用（最終権限）。 */
export const requireOwner = requireRole("owner");

/** オーナー or 特別管理人。 */
export const requireAdmin = requireRole("owner", "special_admin");

/** 板スタッフ必須（WP1 の board_staff に依存）。param 名は板 ID。 */
export function requireBoardStaff(
  minLevel: "admin" | "deputy" | "moderator" = "moderator",
  boardIdParam = "boardId",
): AppMiddleware {
  const levelRank = { admin: 3, deputy: 2, moderator: 1 } as const;
  return createMiddleware<AppEnv>(async (c, next) => {
    const ctx = getReqCtx(c);
    if (!ctx.session) throw ApiError.unauthorized();
    const account = ctx.session.account;

    // owner / special_admin は全板でスタッフ相当
    if (account.role === "owner" || account.role === "special_admin") {
      await next();
      return;
    }

    const boardId = Number(c.req.param(boardIdParam));
    if (!Number.isInteger(boardId) || boardId <= 0) throw ApiError.validation("boardId が不正です");

    const row = await c.env.DB.prepare("SELECT level FROM board_staff WHERE board_id = ? AND account_id = ?")
      .bind(boardId, account.id)
      .first<{ level: keyof typeof levelRank }>();

    if (!row || levelRank[row.level] < levelRank[minLevel]) {
      throw ApiError.forbidden(`板スタッフ権限（${minLevel}以上）が必要です`);
    }
    await next();
  });
}

/** 権限マトリクス（`can()`）の合成ロール評価で action をチェック。 */
export function requireAction(action: PermissionAction, options: CanOptions = {}): AppMiddleware {
  return createMiddleware<AppEnv>(async (c, next) => {
    const roles = rolesOf({
      globalRole: getReqCtx(c).session?.account.role,
      isAiAgent: false, // AI 用は WP5 の policy engine が別途評価
    });
    if (!canAny(roles, action, options)) throw ApiError.forbidden();
    await next();
  });
}
