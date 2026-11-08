// 板スコープの権限判定（DESIGN §5.4）。
// ルートのパラメータがスラッグのため、requireBoardStaff ミドルウェアの代わりに明示的に評価する。

import { ApiError, type AuthAccount, type BoardStaffLevel } from "shared";
import { loadStaffLevel, resolveBoardRow, type BoardRow } from "./store";

const RANK: Record<BoardStaffLevel, number> = { admin: 3, deputy: 2, moderator: 1 };

export interface AccessActor {
  accountId: string | null;
  role: AuthAccount["role"] | null;
}

export function actorFrom(account: AuthAccount | null | undefined): AccessActor {
  return { accountId: account?.id ?? null, role: account?.role ?? null };
}

export function isSiteAdmin(actor: AccessActor): boolean {
  return actor.role === "owner" || actor.role === "special_admin";
}

/** 板スタッフ（minLevel 以上）か。owner/special_admin は全板で通す。 */
export async function hasBoardStaff(
  db: D1Database,
  actor: AccessActor,
  boardId: number,
  minLevel: BoardStaffLevel = "moderator",
): Promise<boolean> {
  if (isSiteAdmin(actor)) return true;
  const level = await loadStaffLevel(db, boardId, actor.accountId);
  if (!level) return false;
  return RANK[level] >= RANK[minLevel];
}

export async function assertBoardStaff(
  db: D1Database,
  actor: AccessActor,
  boardId: number,
  minLevel: BoardStaffLevel = "moderator",
): Promise<void> {
  if (!actor.accountId) throw ApiError.unauthorized();
  if (!(await hasBoardStaff(db, actor, boardId, minLevel))) {
    throw ApiError.forbidden(`板スタッフ権限（${minLevel}以上）が必要です`);
  }
}

/** 板管理（設定・スタッフ任免）権限。board_admin 以上。 */
export async function assertBoardAdmin(db: D1Database, actor: AccessActor, boardId: number): Promise<void> {
  await assertBoardStaff(db, actor, boardId, "admin");
}

/** 板を ID/スラッグから解決し、権限込みで返す。 */
export async function resolveManageableBoard(
  db: D1Database,
  actor: AccessActor,
  idOrSlug: string | number,
  minLevel: BoardStaffLevel | "owner",
): Promise<{ board: BoardRow; isOwner: boolean; isStaff: boolean }> {
  const board = await resolveBoardRow(db, idOrSlug);
  if (!board) throw ApiError.notFound("板が見つかりません");
  const isOwner = isSiteAdmin(actor);
  const isStaff = isOwner || (await hasBoardStaff(db, actor, board.id, "moderator"));
  if (minLevel === "owner") {
    if (!isOwner) throw ApiError.forbidden("サイト管理者（owner / special_admin）が必要です");
  } else if (!(await hasBoardStaff(db, actor, board.id, minLevel))) {
    throw ApiError.forbidden(`板スタッフ権限（${minLevel}以上）が必要です`);
  }
  return { board, isOwner, isStaff };
}

/** レス削除は moderator 不可（非表示のみ）。deputy 以上。 */
export async function canHardDeletePost(
  db: D1Database,
  actor: AccessActor,
  boardId: number,
): Promise<boolean> {
  if (isSiteAdmin(actor)) return true;
  const level = await loadStaffLevel(db, boardId, actor.accountId);
  return level === "admin" || level === "deputy";
}