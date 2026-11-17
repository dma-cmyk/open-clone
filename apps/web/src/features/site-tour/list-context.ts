// ツアーの一覧（ヘルプ `#tour`）が使う利用者の情報。
//
// 一覧の行を出すか・どこを開くかは `TourListContext` だけで決める（`types.ts`）。
// - ログイン・サイト所有者・特別管理人: `GET /v1/auth/session`
// - スタッフを務める板: `GET /v1/accounts/me/boards`（削除板は API が返さない）
//
// 取得に失敗しても一覧自体は出す（管理系の行だけ出さない）。

import { api } from "../board-ui/api";
import { apiGet } from "../../lib/api";
import type { TourListContext } from "./types";

/** 未ログイン・取得前の情報（管理系の行は出ない）。 */
export const ANONYMOUS_TOUR_LIST_CONTEXT: TourListContext = {
  loggedIn: false,
  siteOwner: false,
  siteSpecialAdmin: false,
  staffBoardSlugs: [],
  adminBoardSlugs: [],
};

interface MyBoardRow {
  slug: string;
  level: "admin" | "deputy" | "moderator";
}

/** `/v1/accounts/me/boards` の応答から、必要な項目だけを検証して取り出す。 */
function readMyBoards(data: unknown): MyBoardRow[] {
  if (typeof data !== "object" || data === null || !("items" in data)) return [];
  const { items } = data;
  if (!Array.isArray(items)) return [];
  const rows: MyBoardRow[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    if (!("slug" in item) || !("level" in item)) continue;
    const { slug, level } = item;
    if (typeof slug !== "string" || slug.length === 0) continue;
    if (level !== "admin" && level !== "deputy" && level !== "moderator") continue;
    rows.push({ slug, level });
  }
  return rows;
}

export async function loadTourListContext(): Promise<TourListContext> {
  const [session, boards] = await Promise.all([
    api.getSession().catch(() => null),
    apiGet<unknown>("/accounts/me/boards").catch(() => null),
  ]);
  const rows = readMyBoards(boards);
  const role = session?.role ?? null;
  return {
    loggedIn: session !== null,
    siteOwner: role === "owner",
    siteSpecialAdmin: role === "special_admin",
    // 板の管理人・副管理人・モデレーター（板の管理画面を開ける人）。
    staffBoardSlugs: rows.map((row) => row.slug),
    // 板にプラグインを導入できる人（板の管理人だけ）。
    adminBoardSlugs: rows.filter((row) => row.level === "admin").map((row) => row.slug),
  };
}