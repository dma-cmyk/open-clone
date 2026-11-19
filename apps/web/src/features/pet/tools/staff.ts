// 板スタッフ・サイト管理者向けの管理ツール（確認カードは警告色）。
//
// ペット専用の権限は作らない。呼ぶのは画面の管理タブと同じ API（`board-ui/api.ts`）で、
// 利用者本人のログイン状態のまま。板のスタッフでなければサーバーが `FORBIDDEN` を返すので、
// ツールはその code をそのまま返す（権限の判定をツール側で緩めない）。
// step-up（TOTP の再確認）を要求された場合も `STEP_UP_REQUIRED` をそのまま返し、確認を省かない。

import { z } from "zod";
import { boardSettingsSchema, type BoardSettings } from "shared";
import { api } from "../../board-ui/api";
import type { BoardSettings as WebBoardSettings } from "../../board-ui/types";
import type { PetConfirmRequest, PetToolResult, PetWriteTool, PetReadTool } from "../contract";
import { prepareWithArgs, runWithArgs, toolParameters, truncateText, untrusted } from "./args";
import { loadBoard } from "./board-target";
import { invalidArgs } from "./errors";

const REPORT_ACTION_LABEL: Readonly<Record<"reject" | "resolve" | "hide" | "delete", string>> = {
  reject: "却下する（問題なし・何もしない）",
  resolve: "対応済みにする（レスはそのまま）",
  hide: "対象のレスを全員から非表示にする",
  delete: "対象のレスを削除する",
};

/** 通報の状態（サーバーの `status`）。未対応だけが処理できる。 */
const REPORT_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: "未対応",
  accepted: "受理済み",
  rejected: "却下済み",
  resolved: "対応済み",
};

const TURNSTILE_LABEL: Readonly<Record<"off" | "anonymous" | "always", string>> = {
  off: "要求しない",
  anonymous: "未ログインのみ要求",
  always: "全投稿で要求",
};

const listReportsArgs = z
  .object({
    board: z.string().trim().max(64).optional().describe("板の slug（任意）"),
    status: z
      .enum(["pending", "accepted", "rejected", "resolved"])
      .optional()
      .describe("状態（未対応は pending）"),
    limit: z.number().int().min(1).max(50).optional().describe("件数（既定 20）"),
  })
  .strict();

const postArgs = z
  .object({
    postId: z.number().int().min(1).describe("レスの ID"),
    threadId: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("そのレスがあるスレ番号（渡すとカードにレスの内容とスレを出す）"),
  })
  .strict();

const threadArgs = z
  .object({
    threadId: z.number().int().min(1).describe("スレ番号"),
  })
  .strict();

const handleReportArgs = z
  .object({
    reportId: z.string().trim().min(1).max(64).describe("通報の id（list_reports の reportId。文字列で渡す）"),
    action: z
      .enum(["reject", "resolve", "hide", "delete"])
      .describe("処理の内容（reject=却下 / resolve=対応済み / hide=非表示 / delete=削除）"),
    note: z.string().max(1000).optional().describe("メモ（監査ログに残る）"),
  })
  .strict();

/**
 * 板設定のうち、ペットから変えてよい項目だけを検証する。
 * `boardSettingsSchema` の各項目を 1 つずつ当てる（`.partial()` は既定値が埋まって
 * 「指定していない項目まで変更」になるため使わない）。
 */
/** shared の zod スキーマの 1 項目を、必要な API だけの形で受ける。 */
interface SettingsFieldParser {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { message: string }[] } };
}

const SETTINGS_SHAPE: Record<string, SettingsFieldParser> = boardSettingsSchema.shape;

export type SettingsPatchResult =
  | { ok: true; patch: Partial<BoardSettings> }
  | { ok: false; message: string };

export function parseSettingsPatch(raw: Record<string, unknown>): SettingsPatchResult {
  const patch: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const field = SETTINGS_SHAPE[key];
    if (!field) {
      problems.push(`${key} は変更できません`);
      continue;
    }
    const parsed = field.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      problems.push(`${key}: ${issue?.message ?? "値が不正です"}`);
      continue;
    }
    patch[key] = parsed.data;
  }
  if (problems.length > 0) return { ok: false, message: `板設定が不正です。${problems.join(" / ")}` };
  return { ok: true, patch };
}

const updateSettingsArgs = z
  .object({
    board: z.string().trim().min(1).max(64).describe("板の slug"),
    name: z.string().trim().min(1).max(64).optional().describe("板名"),
    category: z.string().trim().min(1).max(32).optional().describe("カテゴリ"),
    description: z.string().max(2000).optional().describe("板の説明"),
    rulesMd: z.string().max(20_000).optional().describe("板のルール（Markdown）"),
    settings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("板設定のうち変える項目だけ（turnstile・maxPosts など。項目ごとに検証する）"),
  })
  .strict();

/** 設定値をカード用の文字にする（真偽は する/しない、Turnstile は日本語）。 */
export function settingsValueText(value: unknown): string {
  if (value === undefined) return "（未設定）";
  if (typeof value === "boolean") return value ? "する" : "しない";
  if (value === null) return "（なし）";
  if (Array.isArray(value)) return value.length === 0 ? "（なし）" : value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") {
    const label = Object.entries(TURNSTILE_LABEL).find(([key]) => key === value)?.[1];
    if (label) return label;
  }
  return String(value);
}

/** 変更前 → 変更後の行を作る（変わらない項目は出さない）。 */
export function settingsDiffRows(
  current: Partial<WebBoardSettings>,
  patch: Partial<BoardSettings>,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const currentRecord: Record<string, unknown> = { ...current };
  for (const [key, next] of Object.entries(patch)) {
    if (next === undefined) continue;
    const before = currentRecord[key];
    if (JSON.stringify(before) === JSON.stringify(next)) continue;
    rows.push({
      label: `設定: ${key}`,
      value: `${settingsValueText(before)} → ${settingsValueText(next)}`,
    });
  }
  return rows;
}

async function postSummary(postId: number, threadId?: number) {
  if (!threadId) return null;
  const page = await api.getThread(threadId, { r: "l100" });
  const post = page.posts.find((item) => item.id === postId);
  if (!post) return null;
  return {
    threadTitle: page.thread.title,
    num: post.num,
    name: post.name,
    body: post.body,
  };
}

export const listReportsTool: PetReadTool = {
  name: "list_reports",
  label: "通報の一覧を見ています",
  description:
    "通報の一覧（板スタッフ・サイト管理者のみ）。board で板を絞り、status は pending（未対応）など。返るのは通報の id・対象スレ・理由・本文の抜粋。",
  parameters: toolParameters(listReportsArgs),
  kind: "read",
  async run(args) {
    return runWithArgs(listReportsArgs, args, async (input) => {
      const page = await api.listReports({
        board: input.board,
        status: input.status,
        limit: input.limit ?? 20,
      });
      return {
        ok: true,
        data: {
          items: page.items.map((item) =>
            untrusted({
              reportId: item.id,
              boardSlug: item.boardSlug ?? null,
              threadId: item.threadId ?? null,
              threadTitle: item.threadTitle ?? null,
              nums: item.nums ?? null,
              reason: item.reason ?? null,
              comment: truncateText(item.comment ?? "", 300),
              status: item.status ?? null,
              createdAt: item.createdAt ?? null,
            }),
          ),
          nextCursor: page.nextCursor,
        },
      };
    });
  },
};

export const deletePostStaffTool: PetWriteTool = {
  name: "delete_post_staff",
  label: "レスの削除を準備しています",
  description:
    "板スタッフとしてレスを削除する（確認カードの後で実行。取り消せません）。レスを消せるのは板の副管理人以上（サイト管理者は常に可）。",
  parameters: toolParameters(postArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(postArgs, args, async (input): Promise<PetConfirmRequest> => {
      const post = await postSummary(input.postId, input.threadId);
      return {
        title: "レスを削除します（板のスタッフ）",
        danger: true,
        details: [
          { label: "対象", value: `レス ID ${input.postId}${post ? `（${post.num} 番）` : ""}` },
          ...(post ? [{ label: "スレ", value: truncateText(post.threadTitle, 200) }] : []),
          ...(post ? [{ label: "投稿者", value: post.name }] : []),
          ...(post ? [{ label: "本文", value: truncateText(post.body, 1200) }] : []),
          { label: "結果", value: "レスが消えます。元に戻せません。" },
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(postArgs, args, async (input) => {
      await api.deletePost(input.postId);
      return { ok: true, data: { postId: input.postId, deleted: true } };
    });
  },
};

export const deleteThreadStaffTool: PetWriteTool = {
  name: "delete_thread_staff",
  label: "スレの削除を準備しています",
  description:
    "板スタッフとしてスレを削除する（確認カードの後で実行。取り消せません）。副管理人以上が対象。",
  parameters: toolParameters(threadArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(threadArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const page = await api.getThread(input.threadId, { r: "l1" });
      const thread = page.thread;
      return {
        title: "スレを削除します（板のスタッフ）",
        danger: true,
        details: [
          { label: "スレ", value: `スレ ${input.threadId}` },
          ...(thread && thread.id !== 0
            ? [
                { label: "スレタイ", value: truncateText(thread.title, 200) },
                { label: "板", value: `/b/${thread.boardSlug}` },
                { label: "レス数", value: String(thread.postCount) },
              ]
            : []),
          { label: "結果", value: "スレとレスの一覧から消えます。元に戻せません。" },
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(threadArgs, args, async (input) => {
      const result = await api.deleteThread(input.threadId);
      return { ok: true, data: { threadId: result.threadId, deleted: result.deleted } };
    });
  },
};

export const hidePostTool: PetWriteTool = {
  name: "hide_post",
  label: "非表示の準備をしています",
  description:
    "レスを全員から非表示にする（板スタッフ moderator 以上。確認カードの後で実行）。管理画面の「非表示のレス」から戻せる。",
  parameters: toolParameters(postArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(postArgs, args, async (input): Promise<PetConfirmRequest> => {
      const post = await postSummary(input.postId, input.threadId);
      return {
        title: "レスを非表示にします",
        danger: true,
        details: [
          { label: "対象", value: `レス ID ${input.postId}${post ? `（${post.num} 番）` : ""}` },
          ...(post ? [{ label: "スレ", value: truncateText(post.threadTitle, 200) }] : []),
          ...(post ? [{ label: "投稿者", value: post.name }] : []),
          ...(post ? [{ label: "本文", value: truncateText(post.body, 1200) }] : []),
          { label: "結果", value: "全員に「非表示」として扱われます。管理画面から再表示できます。" },
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(postArgs, args, async (input) => {
      await api.hidePost(input.postId);
      return { ok: true, data: { postId: input.postId, hidden: true } };
    });
  },
};

export const restorePostTool: PetWriteTool = {
  name: "restore_post",
  label: "再表示の準備をしています",
  description:
    "非表示にしたレスを全員に再表示する（板スタッフ moderator 以上。確認カードの後で実行）。",
  parameters: toolParameters(postArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(postArgs, args, async (input): Promise<PetConfirmRequest> => {
      const post = await postSummary(input.postId, input.threadId);
      return {
        title: "レスを再表示します",
        danger: false,
        details: [
          { label: "対象", value: `レス ID ${input.postId}${post ? `（${post.num} 番）` : ""}` },
          ...(post ? [{ label: "スレ", value: truncateText(post.threadTitle, 200) }] : []),
          { label: "結果", value: "全員に見えるようになります。" },
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(postArgs, args, async (input) => {
      await api.restorePost(input.postId);
      return { ok: true, data: { postId: input.postId, hidden: false } };
    });
  },
};

export const handleReportTool: PetWriteTool = {
  name: "handle_report",
  label: "通報の処理を準備しています",
  description:
    "通報を処理する（板スタッフ moderator 以上。確認カードの後で実行）。未対応（pending）の通報だけを処理できる（処理済みなら ALREADY_HANDLED を返す）。action は reject（却下）・resolve（対応済み）・hide（対象レスを非表示）・delete（削除）。hide と delete は対象のレスに効く。",
  parameters: toolParameters(handleReportArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(handleReportArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const reportId = input.reportId;
      // 処理済みの通報も一覧には出るので、状態で絞らずに直近 100 件（API の上限）から探す。
      const recent = await api.listReports({ limit: 100 });
      const report = recent.items.find((item) => String(item.id) === reportId);
      // サーバーは状態を見ずに処理する（hide/delete をもう一度かけると件数がずれる）。
      // 未対応以外はカードを出さずに断る。
      if (report && report.status !== undefined && report.status !== "pending") {
        const label = REPORT_STATUS_LABEL[report.status] ?? report.status;
        return {
          ok: false,
          code: "ALREADY_HANDLED",
          error: `この通報は処理済みです（状態: ${label}）。`,
        };
      }
      return {
        title: "通報を処理します",
        danger: input.action === "hide" || input.action === "delete",
        details: [
          { label: "通報", value: reportId },
          ...(report
            ? [
                { label: "板", value: report.boardSlug ?? "（不明）" },
                { label: "スレ", value: truncateText(report.threadTitle ?? "", 200) },
                { label: "対象", value: report.nums ?? "（指定なし）" },
                { label: "理由", value: report.reason ?? "（不明）" },
                { label: "状態", value: report.status ?? "（不明）" },
                { label: "通報の本文", value: truncateText(report.comment ?? "", 400) },
              ]
            : [
                {
                  label: "状態",
                  value: "直近 100 件の通報に見つかりませんでした（古い通報か、対象外の板かもしれません）。",
                },
              ]),
          { label: "処理", value: REPORT_ACTION_LABEL[input.action] },
          ...(input.note ? [{ label: "メモ", value: input.note }] : []),
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(handleReportArgs, args, async (input) => {
      await api.handleReport(input.reportId, input.action, input.note);
      return { ok: true, data: { reportId: input.reportId, action: input.action } };
    });
  },
};

export const updateBoardSettingsTool: PetWriteTool = {
  name: "update_board_settings",
  label: "板の設定変更を準備しています",
  description:
    "板の設定を変える（板の管理人。確認カードの後で実行）。name・category・description・rulesMd と settings（turnstile・cooldownSeconds・maxPosts・allowImages など）を渡す。カードに変更前と変更後を並べる。",
  parameters: toolParameters(updateSettingsArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(updateSettingsArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const target = await loadBoard(input.board);
      const details: { label: string; value: string }[] = [
        { label: "板", value: `${target.board.name}（/b/${target.slug}）` },
      ];
      if (input.name !== undefined && input.name !== target.board.name) {
        details.push({ label: "板名", value: `${target.board.name} → ${input.name}` });
      }
      if (input.category !== undefined && input.category !== target.board.category) {
        details.push({ label: "カテゴリ", value: `${target.board.category} → ${input.category}` });
      }
      if (input.description !== undefined && input.description !== (target.board.description ?? "")) {
        details.push({
          label: "説明",
          value: `${truncateText(target.board.description ?? "（なし）", 200)} → ${truncateText(input.description, 200)}`,
        });
      }
      if (input.rulesMd !== undefined && input.rulesMd !== (target.board.rulesMd ?? "")) {
        details.push({
          label: "ルール",
          value: `${truncateText(target.board.rulesMd ?? "（なし）", 300)} → ${truncateText(input.rulesMd, 300)}`,
        });
      }
      if (input.settings) {
        const parsed = parseSettingsPatch(input.settings);
        if (!parsed.ok) return invalidArgs(parsed.message);
        details.push(...settingsDiffRows(target.board.settings ?? {}, parsed.patch));
      }
      if (details.length === 1) {
        return invalidArgs("変更する項目がありません（いまの値と同じです）。");
      }
      details.push({ label: "権限", value: "板の管理人だけが実行できます（サーバーが拒否したら何も変わりません）。" });
      return { title: "板の設定を変更します", danger: true, details };
    });
  },
  async run(args) {
    return runWithArgs(updateSettingsArgs, args, async (input) => {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch["name"] = input.name;
      if (input.category !== undefined) patch["category"] = input.category;
      if (input.description !== undefined) patch["description"] = input.description;
      if (input.rulesMd !== undefined) patch["rulesMd"] = input.rulesMd;
      if (input.settings !== undefined) {
        const parsed = parseSettingsPatch(input.settings);
        if (!parsed.ok) return invalidArgs(parsed.message);
        patch["settings"] = parsed.patch;
      }
      const board = await api.updateBoard(input.board, patch);
      return { ok: true, data: { slug: input.board, name: board.name, updated: Object.keys(patch) } };
    });
  },
};