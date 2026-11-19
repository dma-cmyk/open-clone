// プラグインの読み取りツール（レジストリ・自分の物・導入済み・テンプレート・静的検査）。
// API は画面と同じ `plugin-host/api.ts`（`/v1/plugins...`）だけを使う。
// 権限と表示場所は shared の説明表（plugin-labels.ts）から日本語名を作る（画面と同じ文言）。

import { z } from "zod";
import {
  PLUGIN_RISK_LABEL,
  PLUGIN_TEMPLATES,
  pluginManifestSchema,
  pluginPermissionInfo,
  pluginSlotInfo,
  type PluginDetail,
  type PluginManifest,
  type PluginPermission,
  type PluginSlotName,
  type PluginSummary,
  type PluginTemplateDefinition,
} from "shared";
import { pluginApi } from "../../plugin-host/api";
import type { PetReadTool } from "../contract";
import { describeIssues, runWithArgs, toolParameters, truncateText, untrusted } from "./args";
import { boardIdOf, loadBoard } from "./board-target";
import { invalidArgs } from "./errors";

export function permissionRows(permissions: readonly PluginPermission[]) {
  return permissions.map((permission) => {
    const info = pluginPermissionInfo(permission);
    return { key: permission, name: info.name, risk: info.risk, riskLabel: PLUGIN_RISK_LABEL[info.risk] };
  });
}

export function slotRows(slots: readonly PluginSlotName[]) {
  return slots.map((slot) => {
    const info = pluginSlotInfo(slot);
    return { key: slot, name: info.label, placed: info.placed };
  });
}

/** 一覧・詳細で共通の要約（他人が書いた名前・概要は untrusted で包む）。 */
export function summarizePlugin(plugin: PluginSummary) {
  return untrusted({
    pluginId: plugin.id,
    name: plugin.name,
    summary: truncateText(plugin.summary, 300),
    version: plugin.latestVersion,
    status: plugin.status,
    visibility: plugin.visibility,
    scopes: plugin.scopes,
    permissions: permissionRows(plugin.permissions),
    slots: slotRows(plugin.slots),
    hasRenderRules: plugin.hasRenderRules,
    installCount: plugin.installCount,
    ownership: plugin.ownership,
    ownerName: plugin.owner?.name ?? null,
  });
}

function detailForModel(plugin: PluginDetail) {
  return {
    ...summarizePlugin(plugin),
    description: truncateText(plugin.description ?? "", 2000),
    connectAllowlist: plugin.connectAllowlist,
    viewer: {
      isOwner: plugin.viewer.isOwner,
      canEdit: plugin.viewer.canEdit,
      isAdmin: plugin.viewer.isAdmin,
    },
    versions: plugin.versions.slice(0, 10).map((version) => ({
      version: version.version,
      status: version.status,
      createdAt: version.createdAt,
      changelog: truncateText(version.changelog ?? "", 300),
    })),
  };
}

export function templateForModel(template: PluginTemplateDefinition) {
  const manifest = template.baseManifest;
  return untrusted({
    templateId: template.id,
    label: template.label,
    description: truncateText(template.description, 400),
    kind: template.kind === "render" ? "レスの表示ルール" : "ボタン・情報の表示",
    risk: template.risk === "medium" ? "中リスク（投稿あり）" : "低リスク",
    permissions: permissionRows(manifest.permissions ?? []),
    slots: slotRows(manifest.slots ?? []),
    parameters: template.parameters.map((parameter) => ({
      key: parameter.key,
      label: parameter.label,
      type: parameter.type,
      required: parameter.required,
      default: parameter.default ?? null,
    })),
  });
}

const listPluginsArgs = z
  .object({
    q: z.string().trim().max(60).optional().describe("名前・概要の検索語"),
    scope: z.enum(["personal", "board", "site"]).optional().describe("導入できる対象"),
    sort: z.enum(["updated", "popular", "new"]).optional().describe("並び順"),
    limit: z.number().int().min(1).max(50).optional().describe("件数（既定 20）"),
  })
  .strict();

const getPluginArgs = z
  .object({
    pluginId: z.string().trim().min(1).max(64).describe("プラグインの id"),
  })
  .strict();

const installedArgs = z
  .object({
    board: z.string().trim().max(64).optional().describe("板の slug（板の導入も見たいとき）"),
  })
  .strict();

const checkPluginArgs = z
  .object({
    code: z.string().min(1).max(200_000).describe("プラグインの JS コード"),
    manifest: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("manifest（省略可。名前・版・権限などを渡す）"),
  })
  .strict();

/** 引数を取らないツール用。 */
const noArgs = z.object({}).strict();

export const listPluginsTool: PetReadTool = {
  name: "list_plugins",
  label: "プラグインを探しています",
  description:
    "公開プラグインの一覧（名前・概要・権限・表示場所の日本語名つき）。q で検索、scope で対象（personal/board/site）を絞る。",
  parameters: toolParameters(listPluginsArgs),
  kind: "read",
  async run(args) {
    return runWithArgs(listPluginsArgs, args, async (input) => {
      const page = await pluginApi.list({
        q: input.q,
        scope: input.scope,
        sort: input.sort,
        limit: input.limit ?? 20,
      });
      return {
        ok: true,
        data: { items: page.items.map(summarizePlugin), nextCursor: page.nextCursor },
      };
    });
  },
};

export const getPluginTool: PetReadTool = {
  name: "get_plugin",
  label: "プラグインの詳細を見ています",
  description:
    "プラグイン 1 件の詳細（説明・版・権限・表示場所・通信先）。権限と表示場所は日本語名で、危険度つきで返す。",
  parameters: toolParameters(getPluginArgs),
  kind: "read",
  async run(args) {
    return runWithArgs(getPluginArgs, args, async (input) => {
      const plugin = await pluginApi.detail(input.pluginId);
      return { ok: true, data: detailForModel(plugin) };
    });
  },
};

export const listMyPluginsTool: PetReadTool = {
  name: "list_my_plugins",
  label: "自分が作ったプラグインを見ています",
  description: "自分（またはこの端末）が作ったプラグインの一覧を返す。未ログインなら端末で作ったものが返る。",
  parameters: toolParameters(noArgs),
  kind: "read",
  async run(args) {
    return runWithArgs(noArgs, args, async () => {
      const page = await pluginApi.mine();
      return { ok: true, data: { items: page.items.map(summarizePlugin), nextCursor: page.nextCursor } };
    });
  },
};

export const listInstalledPluginsTool: PetReadTool = {
  name: "list_installed_plugins",
  label: "導入済みプラグインを見ています",
  description:
    "この端末・このアカウントに導入されているプラグイン（個人の導入と、board を渡したときはその板の導入）を返す。",
  parameters: toolParameters(installedArgs),
  kind: "read",
  async run(args) {
    return runWithArgs(installedArgs, args, async (input) => {
      const personal = await pluginApi.installed("personal");
      const result: Record<string, unknown> = {
        personal: personal.items.map((item) =>
          untrusted({
            pluginId: item.pluginId,
            name: item.name,
            version: item.version,
            enabled: item.enabled,
            pinned: item.pinned,
            status: item.pluginStatus,
            permissions: permissionRows(item.manifest.permissions ?? []),
            slots: slotRows(item.manifest.slots ?? []),
          }),
        ),
      };
      if (input.board) {
        try {
          const target = await loadBoard(input.board);
          const boardId = boardIdOf(target.board);
          const board = await pluginApi.installed("board", boardId);
          result["board"] = {
            slug: input.board,
            items: board.items.map((item) =>
              untrusted({
                pluginId: item.pluginId,
                name: item.name,
                version: item.version,
                enabled: item.enabled,
                status: item.pluginStatus,
              }),
            ),
          };
        } catch {
          // 板の導入は管理者だけが見られる（417 など）。個人の一覧は返す。
          result["board"] = { slug: input.board, error: "この板の導入一覧は見られませんでした（権限がありません）。" };
        }
      }
      return { ok: true, data: result };
    });
  },
};

export const listPluginTemplatesTool: PetReadTool = {
  name: "list_plugin_templates",
  label: "プラグインのテンプレートを見ています",
  description:
    "コードを書かずに作れるプラグインのテンプレート一覧（種類・リスク・権限・表示場所・入力する項目）。自分用プラグインを作るときの出発点に使う。",
  parameters: toolParameters(noArgs),
  kind: "read",
  async run(args) {
    return runWithArgs(noArgs, args, async () => ({
      ok: true,
      data: { items: PLUGIN_TEMPLATES.map(templateForModel) },
    }));
  },
};

export const checkPluginTool: PetReadTool = {
  name: "check_plugin",
  label: "プラグインのコードを検査しています",
  description:
    "プラグインのコード（と manifest）を保存せずに静的検査だけ行う。検査に通るか・警告は何かを返す。作成や版の追加の前に使う。",
  parameters: toolParameters(checkPluginArgs),
  kind: "read",
  async run(args) {
    return runWithArgs(checkPluginArgs, args, async (input) => {
      let manifest: PluginManifest | undefined;
      if (input.manifest) {
        const parsed = pluginManifestSchema.safeParse(input.manifest);
        if (!parsed.success) return invalidArgs(`manifest が不正です。${describeIssues(parsed.error)}`);
        manifest = parsed.data;
      }
      const result = await pluginApi.previewCheck(input.code, manifest);
      return {
        ok: true,
        data: {
          allowed: result.checks.allowed,
          reasons: result.checks.reasons,
          riskScore: result.checks.riskScore ?? null,
          warnings: result.warnings,
        },
      };
    });
  },
};