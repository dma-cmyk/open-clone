// ヘルプ（`help-view.tsx`）の節一覧と本文を返すツール。
// 本文はヘルプ画面の正本を描画して読む（help-source.ts）。文面をツール側に写さない。

import { z } from "zod";
import type { PetReadTool, PetToolResult } from "../contract";
import { runWithArgs, toolParameters, truncateText } from "./args";
import { notFound } from "./errors";
import {
  HELP_SECTION_MAX_CHARS,
  findHelpSection,
  helpFailure,
  loadHelpSections,
  matchesHelp,
  type HelpSection,
} from "./help-source";

const helpArgsSchema = z
  .object({
    section: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe("節の id（例: posting, plugins, admin）。節の一覧は引数なしで取れる。"),
    query: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe("節を探す言葉（例: 書き込み, 通報）。section と同時には使わない。"),
  })
  .strict();

export type HelpArgs = z.infer<typeof helpArgsSchema>;

/** 検索で返す節の最大数と、そのときの 1 節の長さ。 */
const QUERY_MATCH_MAX = 5;
const QUERY_TEXT_MAX_CHARS = 1200;

/**
 * 引数と節の一覧から結果を作る（描画から切り離してあるので単体で試験できる）。
 * - 引数なし: 節の一覧（目次）。
 * - `section`: その節の本文。
 * - `query`: 見出し・本文に当たる節の抜粋。
 */
export function buildHelpResult(args: HelpArgs, sections: readonly HelpSection[]): PetToolResult {
  if (sections.length === 0) {
    return { ok: false, code: "HELP_UNAVAILABLE", error: "ヘルプの節がありません。" };
  }
  if (args.section) {
    const section = findHelpSection([...sections], args.section);
    if (!section) {
      return notFound(
        `「${args.section}」という節はありません。節は ${sections.map((item) => item.id).join(", ")} です。`,
      );
    }
    return {
      ok: true,
      data: {
        id: section.id,
        title: section.title,
        text: truncateText(section.text, HELP_SECTION_MAX_CHARS),
      },
    };
  }
  if (args.query) {
    const matched = sections.filter((section) => matchesHelp(section, args.query ?? "")).slice(0, QUERY_MATCH_MAX);
    if (matched.length === 0) {
      return notFound(
        `「${args.query}」に当たる節はありません。節は ${sections.map((item) => item.id).join(", ")} です。`,
      );
    }
    return {
      ok: true,
      data: {
        query: args.query,
        matches: matched.map((section) => ({
          id: section.id,
          title: section.title,
          text: truncateText(section.text, QUERY_TEXT_MAX_CHARS),
        })),
      },
    };
  }
  return {
    ok: true,
    data: {
      sections: sections.map((section) => ({ id: section.id, title: section.title })),
      note: "節の本文は section に id を渡すと返します。",
    },
  };
}

export const readHelpTool: PetReadTool = {
  name: "read_help",
  label: "ヘルプを読んでいます",
  description:
    "このサイトのヘルプ（使い方・書き込み方・板の管理・プラグイン・通報など）の節一覧と本文を返す。引数なしなら節の一覧、section に節の id、query に検索語を渡すと本文を返す。使い方や決まりを聞かれたら最初にこれを使う。",
  parameters: toolParameters(helpArgsSchema),
  kind: "read",
  async run(args, ctx) {
    return runWithArgs(helpArgsSchema, args, async (input) => {
      if (ctx.signal.aborted) return { ok: false, code: "ABORTED", error: "操作を中止しました。" };
      try {
        const sections = await loadHelpSections();
        return buildHelpResult(input, sections);
      } catch (cause) {
        return helpFailure(cause);
      }
    });
  },
};