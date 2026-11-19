// ログイン状態と、その人が板ごとに持つ役割を返すツール。
// 書き込み系のツールも「板の管理だけができる操作」の案内に `loadMe()` を使う。

import { z } from "zod";
import { apiGet } from "../../../lib/api";
import { api } from "../../board-ui/api";
import type { PetReadTool } from "../contract";
import { runWithArgs, toolParameters } from "./args";

export type BoardLevel = "admin" | "deputy" | "moderator";

export interface MyBoard {
  slug: string;
  name: string;
  level: BoardLevel;
}

export interface Me {
  authenticated: boolean;
  /** アカウントの表示名（未ログインは null）。 */
  name: string | null;
  /** サイト全体の役割（owner / special_admin / user。未ログインは null）。 */
  role: string | null;
  boards: MyBoard[];
  /** 板のスタッフを務める板の slug（モデレーター以上）。 */
  staffBoards: string[];
}

const LEVEL_LABEL: Readonly<Record<BoardLevel, string>> = {
  admin: "板の管理人",
  deputy: "板の副管理人",
  moderator: "板のモデレーター",
};

export function boardLevelLabel(level: BoardLevel): string {
  return LEVEL_LABEL[level];
}

/** `/v1/accounts/me/boards` の応答から、必要な項目だけを取り出す（形が違えば捨てる）。 */
export function readMyBoards(data: unknown): MyBoard[] {
  if (typeof data !== "object" || data === null || !("items" in data)) return [];
  const { items } = data;
  if (!Array.isArray(items)) return [];
  const boards: MyBoard[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    if (!("slug" in item) || !("level" in item)) continue;
    const { slug, level } = item;
    if (typeof slug !== "string" || slug.length === 0) continue;
    if (level !== "admin" && level !== "deputy" && level !== "moderator") continue;
    const name = "name" in item && typeof item.name === "string" ? item.name : slug;
    boards.push({ slug, name, level });
  }
  return boards;
}

/** ログイン状態と板の役割をまとめて取る（未ログイン・取得失敗でも例外にしない）。 */
export async function loadMe(): Promise<Me> {
  const [session, boards] = await Promise.all([
    api.getSession().catch(() => null),
    apiGet<unknown>("/accounts/me/boards").catch(() => null),
  ]);
  const rows = readMyBoards(boards);
  return {
    authenticated: session !== null,
    name: session?.name ?? null,
    role: session?.role ?? null,
    boards: rows,
    staffBoards: rows.map((row) => row.slug),
  };
}

const noArgs = z.object({}).strict();

export const getMeTool: PetReadTool = {
  name: "get_me",
  label: "ログイン状態を確認しています",
  description:
    "利用者本人のログイン状態と、板ごとの役割（板の管理人・副管理人・モデレーター）を返す。管理操作ができるか迷ったら最初に呼ぶ。メールアドレスやトークンは返さない。",
  parameters: toolParameters(noArgs),
  kind: "read",
  async run(args, ctx) {
    return runWithArgs(noArgs, args, async () => {
      if (ctx.signal.aborted) return { ok: false, code: "ABORTED", error: "操作を中止しました。" };
      const me = await loadMe();
      return {
        ok: true,
        data: {
          authenticated: me.authenticated,
          name: me.name,
          role: me.role,
          /** サイト運営（owner か特別管理人）か。ペットはこの情報を使わないが、案内には使える。 */
          siteAdmin: me.role === "owner" || me.role === "special_admin",
          boards: me.boards.map((board) => ({
            slug: board.slug,
            name: board.name,
            level: board.level,
            levelLabel: boardLevelLabel(board.level),
          })),
        },
      };
    });
  },
};