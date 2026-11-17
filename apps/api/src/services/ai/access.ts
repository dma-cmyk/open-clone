// AI から見た板の可視範囲。
// `allowed_boards` は「担当にしてよい範囲」であり、削除板を読む実権限ではない（レビュー 11 / T11-02）。
// 委譲元アカウント（ai_agents.created_by）の実際の権限（サイト管理者・板スタッフ）を基準にする。
// REST (`/v1/ai/*`) と MCP は同じ `executeAiAction` を通るため、ここ 1 か所で両方に効く。

import { ApiError } from "shared";
import type { Env } from "../../lib/env";
import { assertBoardContentWritable } from "../board";

export interface AiBoardVisibility {
  /** 委譲元がサイト管理者か（全板を見られる）。 */
  siteAdmin: boolean;
  /** 削除板でも内容を読める板（委譲元が板スタッフ moderator 以上）。 */
  readableDeletedBoardIds: number[];
  /** 読めない削除板（横断一覧・検索・feed から除外する）。 */
  hiddenDeletedBoardIds: number[];
}

async function deletedBoardIds(env: Env): Promise<number[]> {
  const result = await env.DB.prepare("SELECT id FROM boards WHERE status != 'active'").all<{ id: number }>();
  return result.results.map((row) => row.id);
}

/** エージェントの委譲元アカウントから、削除板を読める範囲を求める。 */
export async function aiBoardVisibility(env: Env, agentId: string): Promise<AiBoardVisibility> {
  const agent = await env.DB.prepare("SELECT created_by FROM ai_agents WHERE id = ?")
    .bind(agentId)
    .first<{ created_by: string }>();
  const allDeleted = await deletedBoardIds(env);
  if (!agent) {
    return { siteAdmin: false, readableDeletedBoardIds: [], hiddenDeletedBoardIds: allDeleted };
  }
  const account = await env.DB.prepare("SELECT role, status FROM accounts WHERE id = ?")
    .bind(agent.created_by)
    .first<{ role: string; status: string }>();
  const siteAdmin =
    account !== null && account.status === "active" && (account.role === "owner" || account.role === "special_admin");
  if (siteAdmin) {
    return { siteAdmin: true, readableDeletedBoardIds: allDeleted, hiddenDeletedBoardIds: [] };
  }
  if (allDeleted.length === 0) {
    return { siteAdmin: false, readableDeletedBoardIds: [], hiddenDeletedBoardIds: [] };
  }
  // 委譲元が現在も板スタッフ（moderator 以上）の板だけ読める（削除でスタッフ行は消えない）。
  const staff = await env.DB.prepare("SELECT board_id FROM board_staff WHERE account_id = ?")
    .bind(agent.created_by)
    .all<{ board_id: number }>();
  const staffBoards = new Set(staff.results.map((row) => row.board_id));
  const readable = allDeleted.filter((id) => staffBoards.has(id));
  return {
    siteAdmin: false,
    readableDeletedBoardIds: readable,
    hiddenDeletedBoardIds: allDeleted.filter((id) => !staffBoards.has(id)),
  };
}

/** 削除板の内容をこの AI に返してよいか。読めない削除板は「無い板」として 404。 */
export function assertAiBoardVisible(visibility: AiBoardVisibility, boardId: number): void {
  if (visibility.hiddenDeletedBoardIds.includes(boardId)) throw ApiError.notFound("板が見つかりません");
}

/** 削除板の内容は AI からも変更しない（K2 / T11-04）。投稿パイプラインと同じ 409。 */
export async function assertAiBoardWritable(env: Env, boardId: number): Promise<void> {
  await assertBoardContentWritable(env.DB, boardId);
}