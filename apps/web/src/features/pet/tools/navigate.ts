// 画面移動のツール。
// - open_page: 同じサイト内のパスだけを受け付ける（外部 URL・`//` で始まるものは拒む）。
// - open_plugin_editor: 作った manifest とコードをエディタの下書きとして渡して開く（保存は利用者が行う）。

import { z } from "zod";
import { pluginManifestSchema } from "shared";
import { saveTemplateDraft } from "../../plugin-templates/draft";
import type { PetReadTool } from "../contract";
import { describeIssues, runWithArgs, toolParameters } from "./args";
import { invalidArgs } from "./errors";

/** プラグインのエディタ（`/plugins/new`）へ渡す下書きの目印。 */
export const PET_DRAFT_TEMPLATE_ID = "pet";

/**
 * 同一オリジンのパスか。`/` で始まり `//`（プロトコル相対）でないこと。
 * 空白・制御文字・`\` を含むものは拒む（ブラウザが別の解釈をする余地を残さない）。
 */
export function isInternalPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f\s]/.test(path)) return false;
  // `/%2f%2fexample.com` のような二重エンコードで `//` になるものを拒む。
  try {
    const decoded = decodeURIComponent(path);
    if (decoded.startsWith("//") || decoded.includes("\\")) return false;
  } catch {
    return false;
  }
  return true;
}

const openPageArgs = z
  .object({
    path: z.string().min(1).max(300).describe("移動先のパス（`/` で始まる。クエリ可）"),
  })
  .strict();

const openEditorArgs = z
  .object({
    manifest: z
      .record(z.string(), z.unknown())
      .describe("プラグインの manifest（name・version・summary・scope など）"),
    code: z.string().min(1).max(200_000).describe("プラグインの JS コード"),
  })
  .strict();

export const openPageTool: PetReadTool = {
  name: "open_page",
  label: "画面を移動しています",
  description:
    "同じサイト内のパスへ移動する（例: /b/news、/b/news/t/12、/help/、/plugins/）。外部の URL や `//` で始まるものは開かない。移動は会話の最後に行われる。",
  parameters: toolParameters(openPageArgs),
  kind: "navigate",
  async run(args, ctx) {
    return runWithArgs(openPageArgs, args, async (input) => {
      if (!isInternalPath(input.path)) {
        return invalidArgs(
          "同じサイト内のパスだけ開けます（`/` で始まり、`//` で始まらないもの）。例: /b/news",
        );
      }
      ctx.navigate(input.path);
      return { ok: true, data: { path: input.path } };
    });
  },
};

export const openPluginEditorTool: PetReadTool = {
  name: "open_plugin_editor",
  label: "プラグインのエディタを開いています",
  description:
    "作った manifest とコードをプラグインのエディタに下書きとして渡して開く（保存は利用者がエディタで行う）。manifest はプラグインの正しい形であること。",
  parameters: toolParameters(openEditorArgs),
  kind: "navigate",
  async run(args, ctx) {
    return runWithArgs(openEditorArgs, args, async (input) => {
      const manifest = pluginManifestSchema.safeParse(input.manifest);
      if (!manifest.success) return invalidArgs(`manifest が不正です。${describeIssues(manifest.error)}`);
      const saved = saveTemplateDraft({
        templateId: PET_DRAFT_TEMPLATE_ID,
        values: {},
        manifest: manifest.data,
        code: input.code,
      });
      if (!saved) {
        return {
          ok: false,
          code: "DRAFT_UNAVAILABLE",
          error: "この端末に下書きを保存できませんでした（ブラウザの保存領域が使えない設定かもしれません）。",
        };
      }
      ctx.navigate("/plugins/new?from=template");
      return { ok: true, data: { path: "/plugins/new?from=template", name: manifest.data.name } };
    });
  },
};