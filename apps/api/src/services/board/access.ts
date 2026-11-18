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

/**
 * 監査ログの actor_type。板の管理操作は板スタッフとして残す（サイト管理者は owner /
 * special_admin をそのまま使う）。post.hide / post.restore のように、板スタッフと
 * サイト管理者の両方が実行できる操作で共通に使う。
 */
export function auditActorType(actor: AccessActor): "owner" | "special_admin" | "board_staff" {
  if (actor.role === "owner") return "owner";
  if (actor.role === "special_admin") return "special_admin";
  return "board_staff";
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

/**
 * 板の内容（スレ・レス・板の設定など）を読み取ってよいか。
 * 削除板（`boards.status !== 'active'`）は一般の閲覧者には「無い板」として扱い、
 * 板スタッフ（moderator 以上）とサイト管理者だけが見られる（管理・確認のため）。
 * `/v1/posts/:id/history` の既存の扱い（板削除後は 404、板スタッフには見える）に揃える。
 */
export async function canReadBoardContent(
  db: D1Database,
  actor: AccessActor,
  board: BoardRow,
): Promise<boolean> {
  if (board.status === "active") return true;
  return hasBoardStaff(db, actor, board.id, "moderator");
}

/** 板管理（設定・スタッフ任免）権限。board_admin 以上。 */
export async function assertBoardAdmin(db: D1Database, actor: AccessActor, boardId: number): Promise<void> {
  await assertBoardStaff(db, actor, boardId, "admin");
}

/** 板を ID/スラッグから解決し、権限込みで返す（閲覧にも使う。書き込み可否は呼び出し側で判定）。 */
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