// 書き込み系のツール（レス・スレ立て・自分のレスの編集と削除）。
//
// 契約（contract.ts）のとおり、`prepare` は確認カードを作るだけで書き込まない。`run` は利用者が
// カードの「実行」を押した後だけ呼ばれる。ツール側から確認を省く手段は無い。
// API は画面と同じ `features/board-ui/api.ts` を、利用者本人のログイン状態（未ログインなら端末）で呼ぶ。

import { z } from "zod";
import { api } from "../../board-ui/api";
import type { Post, ThreadDetail } from "../../board-ui/types";
import type { PetConfirmRequest, PetToolResult, PetWriteTool } from "../contract";
import { prepareWithArgs, runWithArgs, toolParameters, truncateText } from "./args";
import { loadBoard } from "./board-target";
import { notAllowed, notFound } from "./errors";
import { postingNeedsTurnstile, turnstileNeededNow } from "./turnstile-plan";

/**
 * 投稿本文の上限（サーバーの `POST_BODY_MAX_BYTES` = 4096 UTF-8 バイト）。
 * 文字数ではなくバイト数で数える（日本語は 1 文字 3 バイト。サーバーと同じ基準）。
 */
const BODY_MAX_BYTES = 4096;
/** 確認カードに出す本文の上限（長い本文はカードでも切る。全文は書き込みに使う）。 */
const CARD_BODY_MAX_CHARS = 1200;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

const bodyField = z
  .string()
  .min(1)
  .refine((value) => utf8Bytes(value) <= BODY_MAX_BYTES, {
    message: "本文が長すぎます（上限 4096 バイト。日本語は 1 文字 3 バイトです）",
  })
  .describe("本文（4096 バイトまで。日本語は 1 文字 3 バイト）");
const nameField = z.string().trim().max(64).optional().describe("名前（任意・64 文字まで。省略すると名無しさん）");

const createPostArgs = z
  .object({
    threadId: z.number().int().min(1).describe("スレ番号"),
    body: bodyField,
    name: nameField,
    sage: z.boolean().optional().describe("sage（既定 false。true ならスレを上げない）"),
  })
  .strict();

const createThreadArgs = z
  .object({
    board: z.string().trim().min(1).max(64).describe("板の slug"),
    title: z.string().trim().min(1).max(120).describe("スレタイ（120 文字まで）"),
    body: bodyField,
    name: nameField,
    mail: z.string().trim().max(64).optional().describe("メール欄（任意）"),
  })
  .strict();

const editMyPostArgs = z
  .object({
    postId: z.number().int().min(1).describe("レスの ID（read_thread の postId）"),
    body: bodyField.describe("新しい本文（4096 バイトまで）"),
    threadId: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("そのレスがあるスレ番号（渡すと確認カードに変更前の本文を出す）"),
  })
  .strict();

const deleteMyPostArgs = z
  .object({
    postId: z.number().int().min(1).describe("レスの ID"),
    threadId: z.number().int().min(1).optional().describe("そのレスがあるスレ番号（任意）"),
  })
  .strict();

interface ThreadHead {
  thread: ThreadDetail;
}

async function loadThreadHead(threadId: number): Promise<ThreadHead | null> {
  const page = await api.getThread(threadId, { r: "l1" });
  if (!page.thread || page.thread.id === 0) return null;
  return { thread: page.thread };
}

/** `threadId` の範囲から `postId` のレスを探す（見つからなければ null）。 */
async function findPost(threadId: number, postId: number): Promise<Post | null> {
  const page = await api.getThread(threadId, { r: "l100" });
  return page.posts.find((post) => post.id === postId) ?? null;
}

function bodyDetail(body: string): { label: string; value: string } {
  return { label: "本文", value: truncateText(body, CARD_BODY_MAX_CHARS) };
}

export const createPostTool: PetWriteTool = {
  name: "create_post",
  label: "書き込みの準備をしています",
  description:
    "スレにレスを書き込む（確認カードの後で実行）。threadId はスレ番号。name を省略すると名無しさん。sage を true にすると sage 扱い。",
  parameters: toolParameters(createPostArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(createPostArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const head = await loadThreadHead(input.threadId);
      if (!head) return notFound(`スレ ${input.threadId} は見つかりませんでした（削除された可能性があります）。`);
      const target = await loadBoard(head.thread.boardSlug);
      const turnstile = await postingNeedsTurnstile(target.slug, target.board.settings);
      return {
        title: "このスレに書き込みます",
        danger: false,
        turnstile,
        details: [
          { label: "板", value: `${target.board.name}（/b/${target.slug}）` },
          { label: "スレ", value: truncateText(head.thread.title, 200) },
          { label: "名前", value: input.name ?? "名無しさん" },
          ...(input.sage ? [{ label: "sage", value: "する（スレを上げない）" }] : []),
          bodyDetail(input.body),
        ],
      };
    });
  },
  async run(args, _ctx, approval) {
    return runWithArgs(createPostArgs, args, async (input) => {
      const result = await api.createPost(input.threadId, {
        body: input.body,
        name: input.name,
        sage: input.sage ?? false,
        turnstileToken: approval.turnstileToken ?? undefined,
      });
      return {
        ok: true,
        data: {
          threadId: input.threadId,
          postId: result.post.id,
          num: result.post.num,
          createdAt: result.post.createdAt,
        },
      };
    });
  },
};

export const createThreadTool: PetWriteTool = {
  name: "create_thread",
  label: "スレ立ての準備をしています",
  description:
    "板に新しいスレを立てる（確認カードの後で実行）。board は板の slug、title はスレタイ、body は >>1 の本文。",
  parameters: toolParameters(createThreadArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(createThreadArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const target = await loadBoard(input.board);
      const session = await api.getSession();
      // スレ立ては「確認済み（省略）」が効かない（サーバーも同じ）。
      const turnstile = await turnstileNeededNow(target.slug, target.board.settings, {
        loggedIn: session !== null,
        allowPass: false,
      });
      return {
        title: "新しいスレを立てます",
        danger: false,
        turnstile,
        details: [
          { label: "板", value: `${target.board.name}（/b/${target.slug}）` },
          { label: "スレタイ", value: truncateText(input.title, 200) },
          { label: "名前", value: input.name ?? "名無しさん" },
          ...(input.mail ? [{ label: "メール欄", value: input.mail }] : []),
          bodyDetail(input.body),
        ],
      };
    });
  },
  async run(args, _ctx, approval) {
    return runWithArgs(createThreadArgs, args, async (input) => {
      const result = await api.createThread(input.board, {
        title: input.title,
        body: input.body,
        name: input.name,
        mail: input.mail,
        turnstileToken: approval.turnstileToken ?? undefined,
      });
      return { ok: true, data: { threadId: result.threadId, board: input.board } };
    });
  },
};

export const editMyPostTool: PetWriteTool = {
  name: "edit_my_post",
  label: "編集の準備をしています",
  description:
    "自分が書いたレスの本文を書き換える（確認カードの後で実行）。threadId を渡すと変更前の本文と、Turnstile が必要かの確認もカードに出せる。",
  parameters: toolParameters(editMyPostArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(editMyPostArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      let before: Post | null = null;
      let boardSlug: string | null = null;
      if (input.threadId) {
        const page = await api.getThread(input.threadId, { r: "l100" });
        before = page.posts.find((post) => post.id === input.postId) ?? null;
        if (before && before.mine === false) {
          return notAllowed("自分のレスだけ編集できます（このレスは別の利用者の投稿です）。");
        }
        boardSlug = page.thread && page.thread.id !== 0 ? page.thread.boardSlug : null;
      }
      // サーバーは編集でもレス投稿と同じ条件で Turnstile を求める（always 板・anonymous 板の未ログイン）。
      // 板が分かる（threadId がある）ときだけ確認できる。分からないときはカードに出さず、run がサーバーの拒否を返す。
      let turnstile: boolean | undefined;
      if (boardSlug) {
        const target = await loadBoard(boardSlug);
        turnstile = await postingNeedsTurnstile(target.slug, target.board.settings);
      }
      return {
        title: "自分のレスを書き換えます",
        danger: false,
        ...(turnstile === undefined ? {} : { turnstile }),
        details: [
          { label: "対象", value: `レス ID ${input.postId}${input.threadId ? `（スレ ${input.threadId}）` : ""}` },
          ...(before ? [{ label: "変更前", value: truncateText(before.body, CARD_BODY_MAX_CHARS) }] : []),
          ...(before ? [{ label: "変更前の名前", value: before.name }] : []),
          { label: "変更後", value: truncateText(input.body, CARD_BODY_MAX_CHARS) },
          ...(turnstile === undefined
            ? [{ label: "ロボット確認", value: "threadId を渡していないため、必要かどうかを先に確かめられません。" }]
            : []),
        ],
      };
    });
  },
  async run(args, _ctx, approval) {
    return runWithArgs(editMyPostArgs, args, async (input) => {
      const post = await api.editPost(input.postId, input.body, approval.turnstileToken ?? undefined);
      return { ok: true, data: { postId: post.id, num: post.num, editedCount: post.editedCount ?? 0 } };
    });
  },
};

export const deleteMyPostTool: PetWriteTool = {
  name: "delete_my_post",
  label: "削除の準備をしています",
  description:
    "自分が書いたレスを取り消す（確認カードの後で実行）。自分の投稿は「投稿者により削除されました」になり、レス番号は残る。板の副管理人以上の権限がある場合、他人のレスはこの API では完全に削除されるため、他人のレスの削除には delete_post_staff を使う。スレの削除はできない。",
  parameters: toolParameters(deleteMyPostArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(deleteMyPostArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      let before: Post | null = null;
      if (input.threadId) {
        before = await findPost(input.threadId, input.postId);
        if (before && before.mine === false) {
          return notAllowed(
            "自分のレスだけ取り消せます（このレスは別の利用者の投稿です）。板のスタッフとして削除するなら delete_post_staff を使ってください。",
          );
        }
      }
      return {
        title: "自分のレスを取り消します",
        danger: true,
        details: [
          { label: "対象", value: `レス ID ${input.postId}${input.threadId ? `（スレ ${input.threadId}）` : ""}` },
          ...(before ? [{ label: "本文", value: truncateText(before.body, CARD_BODY_MAX_CHARS) }] : []),
          {
            label: "結果（自分の投稿）",
            value: "「投稿者により削除されました」と表示されます。レス番号は残り、元に戻せません。",
          },
          {
            label: "結果（他人の投稿）",
            value:
              "板の副管理人以上の権限がある場合、サーバーはレス自体を消します（完全削除。元に戻せません）。他人のレスの削除は delete_post_staff を使ってください。",
          },
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(deleteMyPostArgs, args, async (input) => {
      const result = await api.deletePostSelf(input.postId);
      return { ok: true, data: { postId: result.postId, selfDeleted: result.selfDeleted } };
    });
  },
};