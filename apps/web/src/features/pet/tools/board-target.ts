// 板を slug から解決する小さな共通部品（読み取りツールと書き込みツールの両方が使う）。
// 既存の画面（board-view / manage-view）と同じ `GET /v1/boards/:slug` を使う。

import { api } from "../../board-ui/api";
import type { BoardDetail, BoardSettings, StaffEntry } from "../../board-ui/types";

export interface BoardTarget {
  slug: string;
  board: BoardDetail;
  staff: StaffEntry[];
  /** 板の管理人（admin）としての操作ができるか（サーバーの判定をそのまま受け取る）。 */
  canManage: boolean;
}

export async function loadBoard(slug: string): Promise<BoardTarget> {
  const data = await api.getBoard(slug);
  return { slug, board: data.board, staff: data.staff, canManage: data.canManage };
}

/** `BoardDetail.id` は string | number。プラグイン API は数値の板 ID を要求する。 */
export function boardIdOf(board: BoardDetail): number {
  const id = Number(board.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("板の ID を取得できませんでした");
  }
  return id;
}

/** ロボット確認（Turnstile）の方針。未設定は API の既定（anonymous）に合わせる。 */
export function turnstilePolicy(settings: BoardSettings | undefined): "off" | "anonymous" | "always" {
  return settings?.turnstile ?? "anonymous";
}