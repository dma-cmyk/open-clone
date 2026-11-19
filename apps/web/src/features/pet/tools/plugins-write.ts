// プラグインの導入・解除と、自分用プラグインの作成（確認カードの後で実行）。
// 保存・導入の前に必ず既存の静的検査（`POST /v1/plugins/preview-check`）を通す（設計 00 §3-6）。

import { z } from "zod";
import {
  PLUGIN_ANON_CODE_MAX_BYTES,
  PLUGIN_CODE_MAX_BYTES,
  pluginManifestSchema,
  type PluginManifest,
} from "shared";
import { pluginApi } from "../../plugin-host/api";
import { api } from "../../board-ui/api";
import type { PetConfirmRequest, PetToolResult, PetWriteTool } from "../contract";
import { describeIssues, prepareWithArgs, runWithArgs, toolParameters, truncateText } from "./args";
import { boardIdOf, loadBoard } from "./board-target";
import { invalidArgs, notAllowed } from "./errors";
import { permissionRows, slotRows } from "./plugins-read";

/**
 * サーバーが版を指定しないときに付ける版（`apps/api/src/services/plugins/registry.ts` の
 * `nextPatchVersion` と同じ規則）。カードと実行で同じ版を送るために写している。
 */
export function nextPatchVersion(current: string | null): string {
  if (!current) return "1.0.0";
  const parts = (current.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  return `${parts[0] ?? 1}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** プラグインのコード（サーバーはバイト数で数える。上限はアカウント所有 512KB・端末所有 64KB）。 */
const codeField = z
  .string()
  .min(1)
  .refine((value) => utf8Bytes(value) <= PLUGIN_CODE_MAX_BYTES, {
    message: `コードが大きすぎます（上限 ${Math.floor(PLUGIN_CODE_MAX_BYTES / 1024)}KB。バイト数で数えます）`,
  })
  .describe("プラグインの JS コード（上限 512KB。未ログインの端末所有は 64KB）");

/**
 * 未ログイン（端末所有）のコード上限 64KB を超えていないかを、通信して確かめる。
 * 超えていれば案内（`INVALID_ARGS`）、問題なければ null。create / add_version の両方で使う。
 */
async function checkAnonCodeLimit(code: string): Promise<PetToolResult | null> {
  if (utf8Bytes(code) <= PLUGIN_ANON_CODE_MAX_BYTES) return null;
  const session = await api.getSession();
  if (session !== null) return null;
  return invalidArgs(
    `コードが未ログイン（端末所有）の上限 ${
      PLUGIN_ANON_CODE_MAX_BYTES / 1024
    }KB を超えています。ログインすると上限は ${PLUGIN_CODE_MAX_BYTES / 1024}KB になります。`,
  );
}

const scopeField = z
  .enum(["personal", "board"])
  .optional()
  .describe("導入先（既定 personal。板に導入するなら board と board を渡す）");

const installArgs = z
  .object({
    pluginId: z.string().trim().min(1).max(64).describe("プラグインの id"),
    scope: scopeField,
    board: z.string().trim().max(64).optional().describe("板に導入するときの板の slug"),
    version: z.string().trim().max(40).optional().describe("版（省略すると最新）"),
    pinned: z.boolean().optional().describe("版を固定する"),
  })
  .strict();

const uninstallArgs = z
  .object({
    pluginId: z.string().trim().min(1).max(64).describe("プラグインの id"),
    scope: z
      .enum(["personal", "board"])
      .optional()
      .describe("解除する導入先（既定 personal。板の導入なら board と board を渡す）"),
    board: z.string().trim().max(64).optional().describe("板の導入を解除するときの板の slug"),
  })
  .strict();

const createMyPluginArgs = z
  .object({
    manifest: z.record(z.string(), z.unknown()).describe("プラグインの manifest（name・version・summary・scope など）"),
    code: codeField,
    changelog: z.string().max(2000).optional().describe("変更点（任意）"),
  })
  .strict();

const addVersionArgs = z
  .object({
    pluginId: z.string().trim().min(1).max(64).describe("プラグインの id"),
    code: codeField.describe("新しい版の JS コード（上限 512KB）"),
    version: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+$/, "版は 1.2.3 の形で指定してください")
      .optional()
      .describe("付ける版（省略すると現行版の次のパッチ。カードに出た値をそのまま送る）"),
    manifest: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("新しい manifest（版を上げるとき。省略すると今の manifest を使う）"),
    changelog: z.string().max(2000).optional().describe("変更点（任意）"),
  })
  .strict();

type InstallTarget = { scope: "personal" } | { scope: "board"; board: string };

/**
 * scope と board から導入先を決める。板に導入するのに board が無ければ null（引数エラー）。
 * （`scope: personal` と `board` の同時指定は「自分だけ」を優先する）
 */
function resolveTarget(input: { scope?: "personal" | "board"; board?: string }): InstallTarget | null {
  if (input.scope === "board" || (!input.scope && input.board !== undefined)) {
    return input.board ? { scope: "board", board: input.board } : null;
  }
  return { scope: "personal" };
}

/** カードに出す権限の行（日本語名・危険度）。 */
function permissionDetails(manifest: PluginManifest): { label: string; value: string }[] {
  const rows = permissionRows(manifest.permissions);
  if (rows.length === 0) return [{ label: "権限", value: "なし（何もできません）" }];
  return rows.map((row) => ({ label: `権限: ${row.name}`, value: `危険度 ${row.riskLabel}` }));
}

function slotDetails(manifest: PluginManifest): { label: string; value: string }[] {
  const rows = slotRows(manifest.slots);
  return rows.length === 0 ? [] : [{ label: "表示場所", value: rows.map((row) => row.name).join(" / ") }];
}

export const installPluginTool: PetWriteTool = {
  name: "install_plugin",
  label: "プラグインの導入を準備しています",
  description:
    "プラグインを導入する（確認カードの後で実行）。scope を省略すると自分だけ（personal）。板に導入するときは scope=board と board（板の slug）。板に導入できるのはその板の管理人だけ。",
  parameters: toolParameters(installArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(installArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const target = resolveTarget(input);
      if (!target) return invalidArgs("板に導入するときは board（板の slug）を渡してください。");
      const plugin = await pluginApi.detail(input.pluginId);
      const details: { label: string; value: string }[] = [
        { label: "プラグイン", value: `${plugin.name}（${plugin.latestVersion ?? "版なし"}）` },
        { label: "概要", value: truncateText(plugin.summary, 200) },
        ...permissionDetails(plugin.manifest),
        ...slotDetails(plugin.manifest),
        ...(plugin.connectAllowlist.length > 0
          ? [{ label: "通信先", value: plugin.connectAllowlist.join(", ") }]
          : []),
      ];
      let danger = false;
      if (target.scope === "personal") {
        details.push({ label: "導入先", value: "この端末（自分だけ）" });
      } else {
        const board = await loadBoard(target.board);
        if (!board.canManage) {
          return notAllowed(`板 ${board.slug} にプラグインを導入できるのは板の管理人だけです。`);
        }
        details.push({ label: "導入先", value: `板「${board.board.name}」（/b/${board.slug}）の全員` });
        danger = true;
      }
      return { title: "プラグインを導入します", danger, details };
    });
  },
  async run(args) {
    return runWithArgs(installArgs, args, async (input) => {
      const target = resolveTarget(input);
      if (!target) return invalidArgs("板に導入するときは board（板の slug）を渡してください。");
      const boardId = target.scope === "personal" ? undefined : boardIdOf((await loadBoard(target.board)).board);
      const result = await pluginApi.install(input.pluginId, {
        scope: target.scope,
        boardId,
        version: input.version,
        pinned: input.pinned,
      });
      return {
        ok: true,
        data: {
          pluginId: input.pluginId,
          scope: target.scope,
          board: target.scope === "personal" ? null : target.board,
          created: result.created,
          version: result.install.version,
        },
      };
    });
  },
};

export const uninstallPluginTool: PetWriteTool = {
  name: "uninstall_plugin",
  label: "プラグインの解除を準備しています",
  description:
    "導入したプラグインを解除する（確認カードの後で実行）。scope を省略すると自分の導入。板の導入は scope=board と board（板の slug）。",
  parameters: toolParameters(uninstallArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(uninstallArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const target = resolveTarget(input);
      if (!target) return invalidArgs("板の導入を解除するときは board（板の slug）を渡してください。");
      const plugin = await pluginApi.detail(input.pluginId);
      const details: { label: string; value: string }[] = [
        { label: "プラグイン", value: `${plugin.name}（${plugin.latestVersion ?? "版なし"}）` },
      ];
      if (target.scope === "personal") {
        details.push({ label: "解除する対象", value: "この端末の導入（自分だけ）" });
      } else {
        const board = await loadBoard(target.board);
        if (!board.canManage) {
          return notAllowed(`板 ${board.slug} の導入を解除できるのは板の管理人だけです。`);
        }
        details.push({ label: "解除する対象", value: `板「${board.board.name}」（/b/${board.slug}）の導入` });
      }
      details.push({ label: "結果", value: "この画面での表示が止まります。プラグイン自体は消えません。" });
      return { title: "プラグインの導入を解除します", danger: target.scope === "board", details };
    });
  },
  async run(args) {
    return runWithArgs(uninstallArgs, args, async (input) => {
      const target = resolveTarget(input);
      if (!target) return invalidArgs("板の導入を解除するときは board（板の slug）を渡してください。");
      const boardId = target.scope === "personal" ? undefined : boardIdOf((await loadBoard(target.board)).board);
      const result = await pluginApi.uninstall(input.pluginId, { scope: target.scope, boardId });
      return {
        ok: true,
        data: { pluginId: input.pluginId, scope: target.scope, uninstalled: result.uninstalled },
      };
    });
  },
};

export const createMyPluginTool: PetWriteTool = {
  name: "create_my_plugin",
  label: "プラグインの作成を準備しています",
  description:
    "自分用のプラグインを作り、自分に導入する（確認カードの後で実行）。保存の前に静的検査を通す。manifest は name・version・summary・scope などが必要。",
  parameters: toolParameters(createMyPluginArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(createMyPluginArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const parsed = pluginManifestSchema.safeParse(input.manifest);
      if (!parsed.success) return invalidArgs(`manifest が不正です。${describeIssues(parsed.error)}`);
      const manifest = parsed.data;
      const check = await pluginApi.previewCheck(input.code, manifest);
      if (!check.checks.allowed) {
        return {
          ok: false,
          code: "PLUGIN_CHECK_FAILED",
          error: `静的検査に通りませんでした: ${check.checks.reasons.join(" / ") || "理由は返されませんでした"}`,
        };
      }
      // 未ログイン（端末所有）はコード上限が 64KB と厳しい。413 で失敗する前にカードで断る。
      const codeLimit = await checkAnonCodeLimit(input.code);
      if (codeLimit) return codeLimit;
      return {
        title: "自分用のプラグインを作ります",
        danger: false,
        details: [
          { label: "名前", value: `${manifest.name}（v${manifest.version}）` },
          { label: "概要", value: truncateText(manifest.summary, 200) },
          { label: "対象", value: manifest.scope.join(" / ") },
          ...permissionDetails(manifest),
          ...slotDetails(manifest),
          { label: "コード", value: `${input.code.split("\n").length} 行（${input.code.length} 文字）` },
          ...(input.changelog ? [{ label: "変更点", value: truncateText(input.changelog, 300) }] : []),
          ...(check.warnings.length > 0 ? [{ label: "検査の警告", value: check.warnings.join(" / ") }] : []),
          { label: "作成後", value: "この端末に導入します（あとから解除できます）。" },
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(createMyPluginArgs, args, async (input) => {
      const parsed = pluginManifestSchema.safeParse(input.manifest);
      if (!parsed.success) return invalidArgs(`manifest が不正です。${describeIssues(parsed.error)}`);
      const manifest = parsed.data;
      const created = await pluginApi.create({
        manifest,
        code: input.code,
        changelog: input.changelog,
        visibility: "private",
      });
      // 作成できたが導入に失敗した場合も、作れた事実は隠さない（作り直すと重複する）。
      try {
        await pluginApi.install(created.id, { scope: "personal" });
      } catch (cause) {
        return {
          ok: true,
          data: {
            pluginId: created.id,
            version: created.version,
            installed: false,
            installError: cause instanceof Error ? cause.message : "導入できませんでした",
            warnings: created.warnings,
          },
        };
      }
      return {
        ok: true,
        data: { pluginId: created.id, version: created.version, installed: true, warnings: created.warnings },
      };
    });
  },
};

export const addMyPluginVersionTool: PetWriteTool = {
  name: "add_my_plugin_version",
  label: "プラグインの新版を準備しています",
  description:
    "自分が作ったプラグインに新しい版を足す（確認カードの後で実行）。保存の前に静的検査を通す。manifest を省略すると今の manifest を使う。版は version で指定でき、省略すると現行版の次のパッチ（例 1.2.3 → 1.2.4）になる。カードに出た版がそのまま付く。",
  parameters: toolParameters(addVersionArgs),
  kind: "write",
  async prepare(args) {
    return prepareWithArgs(addVersionArgs, args, async (input): Promise<PetConfirmRequest | PetToolResult> => {
      const plugin = await pluginApi.detail(input.pluginId);
      if (!plugin.viewer.canEdit) {
        return notAllowed("版を足せるのはそのプラグインの作者だけです。");
      }
      let manifest = plugin.manifest;
      if (input.manifest) {
        const parsed = pluginManifestSchema.safeParse(input.manifest);
        if (!parsed.success) return invalidArgs(`manifest が不正です。${describeIssues(parsed.error)}`);
        manifest = parsed.data;
      }
      // サーバーは `params.version ?? nextPatchVersion(latest)` を付ける（manifest.version は上書きされる）。
      // カードと実行で同じ値を送るため、ここで決めた版を run でも同じ規則で決めて送る。
      const version = input.version ?? nextPatchVersion(plugin.latestVersion);
      const check = await pluginApi.previewCheck(input.code, manifest);
      if (!check.checks.allowed) {
        return {
          ok: false,
          code: "PLUGIN_CHECK_FAILED",
          error: `静的検査に通りませんでした: ${check.checks.reasons.join(" / ") || "理由は返されませんでした"}`,
        };
      }
      // サーバーは「端末が持つ（匿名作成）プラグイン」に 64KB の上限をかける（ログイン状態では変わらない）。
      // 後からログインした人が編集する場合もあるので、持ち主の種類で判定する。
      if (plugin.ownership === "device" && utf8Bytes(input.code) > PLUGIN_ANON_CODE_MAX_BYTES) {
        return invalidArgs(
          `端末が持つプラグインのコード上限は ${PLUGIN_ANON_CODE_MAX_BYTES / 1024}KB です（ログインしても変わりません）。` +
            "これより大きい版は、ログインした状態で新しいプラグインとして作ってください。",
        );
      }
      return {
        title: "プラグインに新しい版を足します",
        danger: false,
        details: [
          { label: "プラグイン", value: `${plugin.name}（いまの版 ${plugin.latestVersion ?? "なし"}）` },
          {
            label: "新しい版",
            value: `${version}${input.version ? "" : `（現行 ${plugin.latestVersion ?? "なし"} の次のパッチ）`}`,
          },
          ...(manifest.version !== version
            ? [{ label: "manifest の版", value: `${manifest.version}（サーバーは ${version} に上書きします）` }]
            : []),
          ...permissionDetails(manifest),
          { label: "コード", value: `${input.code.split("\n").length} 行（${input.code.length} 文字）` },
          ...(input.changelog ? [{ label: "変更点", value: truncateText(input.changelog, 300) }] : []),
          ...(check.warnings.length > 0 ? [{ label: "検査の警告", value: check.warnings.join(" / ") }] : []),
        ],
      };
    });
  },
  async run(args) {
    return runWithArgs(addVersionArgs, args, async (input) => {
      let manifest: PluginManifest | undefined;
      if (input.manifest) {
        const parsed = pluginManifestSchema.safeParse(input.manifest);
        if (!parsed.success) return invalidArgs(`manifest が不正です。${describeIssues(parsed.error)}`);
        manifest = parsed.data;
      }
      // カードと同じ版を送る（サーバーの自動採番に任せない）。
      const plugin = await pluginApi.detail(input.pluginId);
      const version = input.version ?? nextPatchVersion(plugin.latestVersion);
      const result = await pluginApi.addVersion(input.pluginId, {
        version,
        manifest,
        code: input.code,
        changelog: input.changelog,
      });
      return {
        ok: true,
        data: { pluginId: input.pluginId, version: result.version, warnings: result.warnings },
      };
    });
  },
};