// 板・スレの読み取りツール（板一覧・スレ一覧・スレ本文・サイト内検索）。
// 既存の画面のクライアント（`features/board-ui/api.ts`・`apps/web/src/app/_wp1/api.ts`）だけを使う。
// 他の利用者が書いた文（板の説明・スレタイ・レスの本文）は `{ untrusted: true, ... }` で包む。

import { z } from "zod";
import { search as searchApi } from "../../../app/_wp1/api";
import { api } from "../../board-ui/api";
import type { Post, ThreadPage, ThreadSummary } from "../../board-ui/types";
import type { PetReadTool, PetToolResult } from "../contract";
import { runWithArgs, toolParameters, truncateText, untrusted } from "./args";
import { notFound } from "./errors";

/** 1 レス・1 節あたりの本文の上限。 */
const POST_BODY_MAX_CHARS = 2000;
/** 1 回のツール結果に入れる本文の合計上限。 */
const TOTAL_BODY_MAX_CHARS = 12_000;

const listBoardsArgs = z
  .object({
    category: z.string().trim().max(32).optional().describe("カテゴリ名（完全一致）"),
    q: z.string().trim().max(60).optional().describe("板の名前・slug・説明に含まれる言葉"),
  })
  .strict();

const listThreadsArgs = z
  .object({
    board: z.string().trim().min(1).max(64).describe("板の slug（例: news）"),
    sort: z
      .enum(["speed", "bump", "created", "posts"])
      .optional()
      .describe("並び順（既定 speed。speed=勢い / bump=新レス / created=新スレ / posts=レス数）"),
    q: z.string().trim().max(100).optional().describe("スレタイの部分一致"),
    limit: z.number().int().min(1).max(100).optional().describe("件数（既定 50）"),
  })
  .strict();

const readThreadArgs = z
  .object({
    threadId: z.number().int().min(1).describe("スレ番号"),
    from: z.number().int().min(1).optional().describe("読み始めるレス番号（省略すると最新から limit 件）"),
    limit: z.number().int().min(1).max(100).optional().describe("件数（既定 30）"),
  })
  .strict();

const searchArgs = z
  .object({
    q: z.string().trim().min(1).max(100).describe("検索語"),
    type: z
      .enum(["thread", "full", "id", "image"])
      .optional()
      .describe("検索の種類（既定 thread。full=全文 / id=表示 ID / image=画像付き）"),
    board: z.string().trim().max(64).optional().describe("板の slug（任意）"),
    limit: z.number().int().min(1).max(50).optional().describe("件数（既定 20）"),
  })
  .strict();

/** レスを AI に渡す形にする（本文は切り、他人の文として包む）。 */
function postForModel(post: Post, remaining: number): { value: Record<string, unknown>; used: number } {
  const budget = Math.max(0, Math.min(POST_BODY_MAX_CHARS, remaining));
  const body = truncateText(post.body, budget);
  return {
    value: untrusted({
      num: post.num,
      name: post.name,
      idHash: post.idHash ?? null,
      createdAt: post.createdAt,
      isOp: Boolean(post.isOp),
      body,
      ...(post.attachments && post.attachments.length > 0
        ? { attachments: post.attachments.map((item) => ({ url: item.url, contentType: item.contentType ?? null })) }
        : {}),
    }),
    used: body.length,
  };
}

/** `?r=` に渡す範囲。from があれば `from-to`、無ければ最新 limit 件。 */
export function threadRange(from: number | undefined, limit: number): string {
  return from === undefined ? `l${limit}` : `${from}-${from + limit - 1}`;
}

function summarizeThread(thread: ThreadSummary): Record<string, unknown> {
  return untrusted({
    threadId: thread.id,
    title: thread.title,
    postCount: thread.postCount,
    lastPostAt: thread.lastPostAt ?? null,
    pinned: Boolean(thread.pinned),
    live: Boolean(thread.live),
    ...(thread.excerpt ? { excerpt: truncateText(thread.excerpt, 200) } : {}),
  });
}

export const listBoardsTool: PetReadTool = {
  name: "list_boards",
  label: "板の一覧を見ています",
  description:
    "板（カテゴリごとの集まり）の一覧を返す。slug・名前・カテゴリ・説明つき。category で絞り込み、q で名前や説明の部分一致。",
  parameters: toolParameters(listBoardsArgs),
  kind: "read",
  async run(args, ctx) {
    return runWithArgs(listBoardsArgs, args, async (input) => {
      const { items } = await api.listBoards(input.category);
      const needle = input.q?.toLowerCase();
      const filtered = needle
        ? items.filter((board) =>
            `${board.name} ${board.slug} ${board.description ?? ""}`.toLowerCase().includes(needle),
          )
        : items;
      if (ctx.signal.aborted) return { ok: false, code: "ABORTED", error: "操作を中止しました。" };
      return {
        ok: true,
        data: {
          total: filtered.length,
          items: filtered.slice(0, 100).map((board) =>
            untrusted({
              slug: board.slug,
              name: board.name,
              category: board.category,
              description: truncateText(board.description ?? "", 200),
              threadCount: board.threadCount ?? null,
              postCount: board.postCount ?? null,
            }),
          ),
        },
      };
    });
  },
};

export const listThreadsTool: PetReadTool = {
  name: "list_threads",
  label: "スレの一覧を見ています",
  description:
    "板の中のスレ一覧を返す（スレ番号・題名・レス数・最終レス時刻）。board には板の slug を渡す。sort は speed（勢い）・bump（新レス）・created（新スレ）・posts（レス数）。",
  parameters: toolParameters(listThreadsArgs),
  kind: "read",
  async run(args, ctx) {
    return runWithArgs(listThreadsArgs, args, async (input) => {
      const page = await api.listThreads(input.board, {
        sort: input.sort ?? "speed",
        q: input.q,
        limit: input.limit ?? 50,
      });
      if (ctx.signal.aborted) return { ok: false, code: "ABORTED", error: "操作を中止しました。" };
      return {
        ok: true,
        data: {
          board: input.board,
          items: page.items.map(summarizeThread),
          nextCursor: page.nextCursor ?? null,
        },
      };
    });
  },
};

export const readThreadTool: PetReadTool = {
  name: "read_thread",
  label: "スレを読んでいます",
  description:
    "スレの題名とレスを読む。threadId はスレ番号、from は読み始めるレス番号（省略すると最新から limit 件）。長い本文は切り詰める。",
  parameters: toolParameters(readThreadArgs),
  kind: "read",
  async run(args, ctx) {
    return runWithArgs(readThreadArgs, args, async (input) => {
      const limit = input.limit ?? 30;
      const page: ThreadPage = await api.getThread(input.threadId, { r: threadRange(input.from, limit) });
      if (ctx.signal.aborted) return { ok: false, code: "ABORTED", error: "操作を中止しました。" };
      if (!page.thread || page.thread.id === 0) {
        return notFound(`スレ ${input.threadId} は見つかりませんでした（削除された可能性があります）。`);
      }
      const posts: Record<string, unknown>[] = [];
      let used = 0;
      for (const post of page.posts) {
        if (used >= TOTAL_BODY_MAX_CHARS) break;
        const next = postForModel(post, TOTAL_BODY_MAX_CHARS - used);
        used += next.used;
        posts.push(next.value);
      }
      return {
        ok: true,
        data: {
          thread: untrusted({
            threadId: page.thread.id,
            title: page.thread.title,
            boardSlug: page.thread.boardSlug,
            boardName: page.thread.boardName ?? null,
            postCount: page.thread.postCount,
            maxPosts: page.thread.maxPosts ?? null,
            status: page.thread.status ?? null,
            live: Boolean(page.thread.live),
          }),
          range: threadRange(input.from, limit),
          posts,
          omittedPosts: Math.max(0, page.posts.length - posts.length),
          hasMore: Boolean(page.hasMore),
        },
      };
    });
  },
};

export const searchTool: PetReadTool = {
  name: "search",
  label: "サイト内を検索しています",
  description:
    "サイト内の検索。type は thread（スレタイ）・full（全文）・id（表示 ID）・image（画像付き）。board を渡すとその板だけ。",
  parameters: toolParameters(searchArgs),
  kind: "read",
  async run(args, ctx) {
    return runWithArgs(searchArgs, args, async (input): Promise<PetToolResult> => {
      const result = await searchApi({
        q: input.q,
        type: input.type ?? "thread",
        board: input.board,
        limit: input.limit ?? 20,
      });
      if (ctx.signal.aborted) return { ok: false, code: "ABORTED", error: "操作を中止しました。" };
      return {
        ok: true,
        data: {
          query: input.q,
          type: result.type,
          items: result.items.map((item) => {
            if (item.type === "thread") {
              return {
                kind: "thread",
                ...untrusted({
                  threadId: item.thread.id,
                  title: item.thread.title,
                  boardSlug: item.thread.boardSlug,
                  boardName: item.thread.boardName,
                  postCount: item.thread.postCount,
                  lastPostAt: item.thread.lastPostAt,
                }),
              };
            }
            return {
              kind: "post",
              threadId: item.thread.id,
              num: item.post.num,
              ...untrusted({
                threadTitle: item.thread.title,
                boardSlug: item.thread.boardSlug,
                name: item.post.name,
                body: truncateText(item.post.body, 400),
                createdAt: item.post.createdAt,
              }),
            };
          }),
          nextCursor: result.nextCursor,
        },
      };
    });
  },
};