// `/mcp-plugin` の 9 ツール executor（報告書28 §4.2 / §4.3、報告書30 §2.3）。
//
// 原則:
// - 入力は必ず shared の strict schema で検証する（権限フィールドの混入を構文排除）。
// - プラグインを対象とする全ツールで「トークン所有者 = プラグイン所有者」を DB で確認し、
//   不一致は 404（存在自体を隠す）。サイト管理者バイパスは無い（トークンは人間セッションではない）。
// - 作成・版追加・公開・導入は既存 registry 関数に委譲し、静的検査も同じ経路で必ず通す。
// - すべての呼び出しを plugin_author_audit に記録する（コード全文は保存しない）。

import {
  ApiError,
  ErrorCode,
  PLUGIN_TEMPLATES,
  analyzeRegexPattern,
  authoringAddVersionOutputSchema,
  authoringAddVersionSchema,
  authoringCheckOutputSchema,
  authoringCheckSchema,
  authoringCreateDraftOutputSchema,
  authoringCreateDraftSchema,
  authoringGetOutputSchema,
  authoringGetSchema,
  authoringInstallSelfOutputSchema,
  authoringInstallSelfSchema,
  authoringListOutputSchema,
  authoringListSchema,
  authoringListTemplatesInputSchema,
  authoringListTemplatesOutputSchema,
  authoringPreviewOutputSchema,
  authoringPreviewSchema,
  authoringPublishOutputSchema,
  authoringPublishSchema,
  toAuthoringTemplateInfo,
  type AuthoringToolName,
  type AuthoringVersionSummary,
  type PluginManifest,
} from "shared";
import type { Env } from "../../lib/env";
import { manifestPermissionWarnings, runStaticChecks } from "../plugins/static-checks";
import {
  addVersion,
  createPlugin,
  findInstall,
  getPluginRowById,
  getVersionRow,
  installPlugin,
  listPlugins,
  listVersions,
  parseManifest,
  publishPlugin,
  resolveInstallVersion,
  uninstallPlugin,
  type PluginRow,
} from "../plugins/registry";
import { writeAuthorAudit, type AuthorAuditResult } from "./audit";
import { assertAuthorRate, assertDraftLimit, consumeAuthorUsage } from "./limits";
import type { AuthenticatedPluginToken } from "./tokens";

export interface AuthorToolMeta {
  ipHash?: string | null;
  requestId?: string | null;
}

interface SchemaLike<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

function parseInput<T>(schema: SchemaLike<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  throw ApiError.validation("入力が不正です", parsed.error.issues);
}

function assertStaticAllowed(checks: { allowed: boolean; reasons: string[] }): void {
  if (checks.allowed) return;
  throw new ApiError(400, ErrorCode.VALIDATION, "静的検査を通過していません", { reasons: checks.reasons });
}

/** `templateId` を changelog 先頭に付記する（報告書29 決定4。新カラムは作らない）。 */
function annotateChangelog(changelog: string | undefined, templateId?: string): string | undefined {
  if (!templateId) return changelog;
  const tag = `[template:${templateId}]`;
  const base = changelog?.trim();
  const value = base ? `${tag} ${base}` : tag;
  return value.length <= 2000 ? value : value.slice(0, 2000);
}

/** トークン所有者のプラグインだけを返す。他人のもの・存在しないものは同じ 404。 */
async function loadOwnedPlugin(env: Env, token: AuthenticatedPluginToken, pluginId: string): Promise<PluginRow> {
  // トークン経路は ID だけを受け付ける（名前で引けると仕様表記が揺らぐ。L-1）。
  const plugin = await getPluginRowById(env.DB, pluginId);
  if (!plugin || plugin.owner_account_id !== token.accountId) {
    throw ApiError.notFound("プラグインが見つかりません");
  }
  return plugin;
}

async function listReviewSummaries(
  env: Env,
  pluginId: string,
): Promise<{ id: string; scope: "board" | "site"; status: "pending" | "approved" | "rejected"; createdAt: number }[]> {
  const result = await env.DB.prepare(
    `SELECT id, scope, status, created_at FROM plugin_reviews
     WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(pluginId)
    .all<{ id: string; scope: "board" | "site"; status: "pending" | "approved" | "rejected"; created_at: number }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    scope: row.scope,
    status: row.status,
    createdAt: row.created_at,
  }));
}

function toVersionSummary(row: {
  version: string;
  status: string;
  changelog: string | null;
  created_at: number;
}): AuthoringVersionSummary {
  // plugin_versions の status は draft/pending/approved/rejected。
  // 出力スキーマ（authoringVersionSummarySchema）はプラグイン状態の語彙なので
  // approved は「公開済み」= published に写像する。
  const status = row.status === "approved" ? "published" : row.status;
  return {
    version: row.version,
    status: status as AuthoringVersionSummary["status"],
    ...(row.changelog ? { changelog: row.changelog.slice(0, 2000) } : {}),
    createdAt: row.created_at,
  };
}

interface ToolOutcome {
  output: Record<string, unknown>;
  pluginId?: string;
  version?: string;
}

async function dispatch(
  env: Env,
  token: AuthenticatedPluginToken,
  tool: AuthoringToolName,
  args: unknown,
): Promise<ToolOutcome> {
  switch (tool) {
    case "authoring.list_templates": {
      parseInput(authoringListTemplatesInputSchema, args);
      const output = authoringListTemplatesOutputSchema.parse({
        ok: true,
        templates: PLUGIN_TEMPLATES.map(toAuthoringTemplateInfo),
      });
      return { output };
    }

    case "authoring.create_draft": {
      const input = parseInput(authoringCreateDraftSchema, args);
      await consumeAuthorUsage(env, token.accountId, "create");
      await assertDraftLimit(env, token.accountId);

      const checks = await runStaticChecks(input.code, input.manifest);
      assertStaticAllowed(checks);
      const warnings = manifestPermissionWarnings(input.manifest, input.code);

      const created = await createPlugin(env.DB, {
        ownerAccountId: token.accountId,
        manifest: input.manifest,
        code: input.code,
        changelog: annotateChangelog(input.changelog, input.templateId),
        visibility: input.visibility,
      });

      const output = authoringCreateDraftOutputSchema.parse({
        ok: true,
        pluginId: created.id,
        name: input.manifest.name,
        version: created.version,
        checks,
        warnings,
      });
      return { output, pluginId: created.id, version: created.version };
    }

    case "authoring.add_version": {
      const input = parseInput(authoringAddVersionSchema, args);
      const plugin = await loadOwnedPlugin(env, token, input.pluginId);
      await consumeAuthorUsage(env, token.accountId, "version");

      if (input.manifest && input.manifest.name !== plugin.name) {
        throw ApiError.validation("manifest.name は変更できません");
      }
      const manifest: PluginManifest = input.manifest ?? parseManifest(plugin.manifest_json);
      const checks = await runStaticChecks(input.code, manifest);
      assertStaticAllowed(checks);
      const warnings = manifestPermissionWarnings(manifest, input.code);

      const added = await addVersion(env.DB, plugin, {
        version: input.version,
        manifest: input.manifest,
        code: input.code,
        changelog: annotateChangelog(input.changelog, input.templateId),
        actorAccountId: token.accountId,
      });

      const output = authoringAddVersionOutputSchema.parse({
        ok: true,
        pluginId: plugin.id,
        version: added.version,
        checks,
        warnings,
      });
      return { output, pluginId: plugin.id, version: added.version };
    }

    case "authoring.check": {
      const input = parseInput(authoringCheckSchema, args);
      await consumeAuthorUsage(env, token.accountId, "check");
      const checks = await runStaticChecks(input.code, input.manifest);
      const warnings = input.manifest ? manifestPermissionWarnings(input.manifest, input.code) : [];
      const output = authoringCheckOutputSchema.parse({ ok: true, checks, warnings });
      return { output };
    }

    case "authoring.preview": {
      const input = parseInput(authoringPreviewSchema, args);
      const plugin = await loadOwnedPlugin(env, token, input.pluginId);
      await consumeAuthorUsage(env, token.accountId, "check");

      if (!plugin.latest_version) throw ApiError.validation("確認できるバージョンがありません");
      const versionRow = await getVersionRow(env.DB, plugin.id, plugin.latest_version);
      if (!versionRow) throw ApiError.notFound("最新バージョンが見つかりません");

      const manifest = parseManifest(versionRow.manifest_json);
      const checks = await runStaticChecks(versionRow.code, manifest);
      const warnings = manifestPermissionWarnings(manifest, versionRow.code);
      const regex = (manifest.render?.post ?? []).slice(0, 20).map((rule) => {
        const safety = analyzeRegexPattern(rule.pattern, rule.flags);
        return {
          pattern: rule.pattern.slice(0, 500),
          flags: rule.flags.slice(0, 6),
          safe: safety.safe,
          ...(safety.safe ? {} : { reason: (safety.reason ?? "").slice(0, 500) }),
        };
      });
      const [versions, reviews] = await Promise.all([
        listVersions(env.DB, plugin.id, { includeUnapproved: true }),
        listReviewSummaries(env, plugin.id),
      ]);

      // 決定2: サーバーでの描画 dry-run はしない。ブラウザ sandbox の確認 URL を返す。
      const output = authoringPreviewOutputSchema.parse({
        ok: true,
        pluginId: plugin.id,
        manifest,
        checks,
        warnings,
        regex,
        versions: versions.slice(0, 100).map(toVersionSummary),
        reviews,
        previewUrl: `/plugins/new?id=${encodeURIComponent(plugin.id)}`,
      });
      return { output, pluginId: plugin.id, version: plugin.latest_version };
    }

    case "authoring.publish": {
      const input = parseInput(authoringPublishSchema, args);
      const plugin = await loadOwnedPlugin(env, token, input.pluginId);
      await consumeAuthorUsage(env, token.accountId, "publish");

      if (!plugin.latest_version) throw ApiError.validation("公開するバージョンがありません");
      const versionRow = await getVersionRow(env.DB, plugin.id, plugin.latest_version);
      if (!versionRow) throw ApiError.notFound("最新バージョンが見つかりません");

      const checks = await runStaticChecks(versionRow.code, parseManifest(versionRow.manifest_json));
      assertStaticAllowed(checks);

      const published = await publishPlugin(env.DB, plugin, {
        scopes: input.scopes,
        visibility: input.visibility,
        actorAccountId: token.accountId,
        staticResult: checks,
      });

      const output = authoringPublishOutputSchema.parse({
        ok: true,
        pluginId: plugin.id,
        status: published.status,
        needsReview: published.needsReview,
        ...(published.reviewId ? { reviewId: published.reviewId } : {}),
        ...(published.needsReview ? { message: "サイト公開は人間の審査待ちです" } : {}),
        checks,
      });
      return { output, pluginId: plugin.id, version: plugin.latest_version };
    }

    case "authoring.install_self": {
      const input = parseInput(authoringInstallSelfSchema, args);
      const plugin = await loadOwnedPlugin(env, token, input.pluginId);
      // 導入先は常に「トークン所有者の personal」。scope は入力に存在しない（strict schema）。
      const existing = await findInstall(env.DB, plugin.id, "personal", token.accountId);

      if (input.uninstall) {
        if (existing) await uninstallPlugin(env.DB, existing);
        const output = authoringInstallSelfOutputSchema.parse({
          ok: true,
          pluginId: plugin.id,
          scope: "personal",
          installed: false,
          uninstalled: Boolean(existing),
          ...(existing ? { version: existing.version } : {}),
          pinned: existing ? existing.pinned === 1 : false,
        });
        return { output, pluginId: plugin.id, version: existing?.version };
      }

      let version: string;
      if (existing && existing.pinned === 1) {
        if (input.version && input.version !== existing.version) {
          throw new ApiError(409, ErrorCode.CONFLICT, "この導入はバージョン固定されています。変更するには先に固定を解除してください");
        }
        version = existing.version;
      } else {
        version = await resolveInstallVersion(env.DB, plugin, input.version, {
          requireApproved: false,
          allowUnpublished: true,
        });
      }

      const installed = await installPlugin(env.DB, plugin, {
        scope: "personal",
        scopeRef: token.accountId,
        version,
        pinned: input.pinned,
        installedBy: token.accountId,
      });

      const output = authoringInstallSelfOutputSchema.parse({
        ok: true,
        pluginId: plugin.id,
        scope: "personal",
        installed: true,
        uninstalled: false,
        version,
        pinned: installed.install.pinned,
      });
      return { output, pluginId: plugin.id, version };
    }

    case "authoring.get": {
      const input = parseInput(authoringGetSchema, args);
      const plugin = await loadOwnedPlugin(env, token, input.pluginId);
      const [versions, reviews] = await Promise.all([
        listVersions(env.DB, plugin.id, { includeUnapproved: true }),
        listReviewSummaries(env, plugin.id),
      ]);
      const output = authoringGetOutputSchema.parse({
        ok: true,
        plugin: {
          id: plugin.id,
          name: plugin.name,
          status: plugin.status,
          visibility: plugin.visibility,
          ...(plugin.latest_version ? { version: plugin.latest_version } : {}),
          updatedAt: plugin.updated_at,
          manifest: parseManifest(plugin.manifest_json),
          createdAt: plugin.created_at,
        },
        versions: versions.slice(0, 100).map(toVersionSummary),
        reviews,
      });
      return { output, pluginId: plugin.id, version: plugin.latest_version ?? undefined };
    }

    case "authoring.list": {
      const input = parseInput(authoringListSchema, args);
      const page = await listPlugins(env.DB, {
        ownerAccountId: token.accountId,
        includeAllStatuses: true,
        status: input.status,
        q: input.q,
        limit: input.limit,
        cursor: input.cursor,
      });
      const output = authoringListOutputSchema.parse({
        ok: true,
        plugins: page.items.slice(0, 100).map((item) => ({
          id: item.id,
          name: item.name,
          status: item.status,
          visibility: item.visibility,
          ...(item.latestVersion ? { version: item.latestVersion } : {}),
          updatedAt: item.updatedAt,
        })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      });
      return { output };
    }

    default:
      throw ApiError.validation(`未対応のツールです: ${String(tool)}`);
  }
}

function auditResultFor(error: unknown): AuthorAuditResult {
  if (!(error instanceof ApiError)) return "error";
  if (error.status === 429) return "rate_limited";
  if (error.status === 401 || error.status === 403 || error.status === 404) return "denied";
  return "error";
}

/**
 * 1 回分のツール呼び出し。分窓 →（必要なら）日次上限 → 実行 → 監査、を必ず通す。
 * 監査の失敗でツール結果を壊さない（ログに残すだけ）。
 */
export async function runAuthoringTool(
  env: Env,
  token: AuthenticatedPluginToken,
  tool: AuthoringToolName,
  args: unknown,
  meta: AuthorToolMeta = {},
): Promise<Record<string, unknown>> {
  const audit = (entry: {
    pluginId?: string | null;
    version?: string | null;
    result: AuthorAuditResult;
    errorCode?: string | null;
  }) =>
    writeAuthorAudit(env, {
      tokenId: token.id,
      accountId: token.accountId,
      tool,
      params: args,
      ipHash: meta.ipHash,
      requestId: meta.requestId,
      ...entry,
    }).catch((error: unknown) => console.warn("PLUGIN_AUTHOR_AUDIT_FAILED", error));

  try {
    await assertAuthorRate(env, token.id);
    const outcome = await dispatch(env, token, tool, args);
    await audit({ pluginId: outcome.pluginId, version: outcome.version, result: "ok" });
    return outcome.output;
  } catch (error) {
    await audit({
      result: auditResultFor(error),
      errorCode: error instanceof ApiError ? error.code : "INTERNAL",
    });
    throw error;
  }
}