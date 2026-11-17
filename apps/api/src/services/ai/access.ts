// AI から見た板の可視範囲。
// `allowed_boards` は「担当にしてよい範囲」であり、削除板を読む実権限ではない（レビュー 11 / T11-02）。
// 委譲元アカウント（ai_agents.created_by）の実際の権限（サイト管理者・板スタッフ）を基準にする。
// 削除板の ID を全件アプリへ持ち出さず、判定は対象板 1 件の状態＋staff 行で行う（レビュー 13 / T13-01）。
// REST (`/v1/ai/*`) と MCP は同じ `executeAiAction` を通るため、ここ 1 か所で両方に効く。

import { ApiError } from "shared";
import type { Env } from "../../lib/env";
import { assertBoardContentWritable } from "../board";

export interface AiBoardVisibility {
  /** 委譲元がサイト管理者か（全板を見られる）。 */
  siteAdmin: boolean;
  /** 委譲元アカウント。null なら削除板は一切見られない。 */
  accountId: string | null;
}

/** エージェントの委譲元アカウントを求める（削除板の全件列挙はしない）。 */
export async function aiBoardVisibility(env: Env, agentId: string): Promise<AiBoardVisibility> {
  const agent = await env.DB.prepare("SELECT created_by FROM ai_agents WHERE id = ?")
    .bind(agentId)
    .first<{ created_by: string }>();
  if (!agent) return { siteAdmin: false, accountId: null };
  const account = await env.DB.prepare("SELECT role, status FROM accounts WHERE id = ?")
    .bind(agent.created_by)
    .first<{ role: string; status: string }>();
  const siteAdmin =
    account !== null && account.status === "active" && (account.role === "owner" || account.role === "special_admin");
  return { siteAdmin, accountId: agent.created_by };
}

/**
 * 削除板の内容をこの AI に返してよいか。
 * サイト管理者は常に可。それ以外は、委譲元が**いま**その板の板スタッフ（moderator 以上）のときだけ可。
 * 対象板 1 件だけを引くため、無関係な削除板の件数に依存しない。
 */
export async function assertAiBoardVisible(
  env: Env,
  visibility: AiBoardVisibility,
  boardId: number,
): Promise<void> {
  if (visibility.siteAdmin) return;
  const board = await env.DB.prepare("SELECT status FROM boards WHERE id = ?")
    .bind(boardId)
    .first<{ status: string }>();
  if (!board) throw ApiError.notFound("板が見つかりません");
  if (board.status === "active") return;
  if (visibility.accountId !== null) {
    const staff = await env.DB.prepare("SELECT level FROM board_staff WHERE board_id = ? AND account_id = ?")
      .bind(boardId, visibility.accountId)
      .first<{ level: string }>();
    if (staff) return;
  }
  throw ApiError.notFound("板が見つかりません");
}

/**
 * 横断クエリ用の「読めない削除板」除外スコープ。
 * サイト管理者は `undefined`（除外なし）。それ以外は委譲元アカウント ID を渡す（bind は常に 1 個）。
 * null を渡すと全削除板を除外する（委譲元が見つからない agent）。
 */
export function aiDeletedBoardScope(visibility: AiBoardVisibility): string | null | undefined {
  return visibility.siteAdmin ? undefined : visibility.accountId;
}

/** 削除板の内容は AI からも変更しない（K2 / T11-04）。投稿パイプラインと同じ 409。 */
export async function assertAiBoardWritable(env: Env, boardId: number): Promise<void> {
  await assertBoardContentWritable(env.DB, boardId);
}