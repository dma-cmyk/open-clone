// 今見ている画面の情報（パス・題名・板・スレ・選択中の文字）を返すツール。

import { z } from "zod";
import { parseRoute } from "../../../app/_shell/router";
import type { PetPageContext, PetReadTool } from "../contract";
import { toolParameters } from "./args";

const SELECTION_MAX_CHARS = 2000;

/** 会話の進行役がツール実行のたびに呼び、`PetToolContext.page` に入れる。 */
export function readPageContext(): PetPageContext {
  const path = `${window.location.pathname}${window.location.search}`;
  const route = parseRoute(window.location.pathname);
  const boardSlug = route.name === "board" || route.name === "thread" || route.name === "manage" ? route.slug : null;
  const threadId = route.name === "thread" ? route.threadId : null;
  const selectionText = (window.getSelection()?.toString() ?? "").slice(0, SELECTION_MAX_CHARS);
  return { path, title: document.title, boardSlug, threadId, selectionText };
}

export const getPageContextTool: PetReadTool = {
  name: "get_page_context",
  label: "今の画面を確認しています",
  description:
    "利用者が今開いている画面のパス・題名・板の slug・スレ番号・選択中の文字を返す。「この板」「このスレ」「ここ」と言われたら最初に呼ぶ。",
  parameters: toolParameters(z.object({}).strict()),
  kind: "read",
  async run(_args, ctx) {
    return { ok: true, data: ctx.page };
  },
};
