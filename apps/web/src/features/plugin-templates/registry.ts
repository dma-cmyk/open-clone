// テンプレート定義の web 側入口（報告書 27 §7.1 / 28 §6.1）。
// 定義そのものは shared に 1 つだけ置き、web（① フォーム）と api（② authoring.list_templates）が
// 同じデータを参照する。ここでは画面表示用の派生（権限バッジ・リスク表示・作成元の解析）だけを持つ。

import {
  PLUGIN_TEMPLATES as SHARED_TEMPLATES,
  findPluginTemplate,
  pluginPermissionInfo,
  type PluginTemplateDefinition,
} from "shared";

export { SHARED_TEMPLATES as PLUGIN_TEMPLATES, findPluginTemplate };
export type { PluginTemplateDefinition };

/** 一覧カードに出す権限バッジ（権限なしなら「権限なし」1 件）。 */
export function templatePermissionLabels(template: PluginTemplateDefinition): string[] {
  const permissions = template.baseManifest.permissions ?? [];
  if (permissions.length === 0) return ["権限なし"];
  return permissions.map((permission) => pluginPermissionInfo(permission).name);
}

/** リスク表示（report27 §4.2: low=緑 / medium=黄）。 */
export function templateRiskBadge(template: PluginTemplateDefinition): {
  tone: "ok" | "warn";
  label: string;
} {
  return template.risk === "medium"
    ? { tone: "warn", label: "中リスク（投稿あり）" }
    : { tone: "ok", label: "低リスク" };
}

/** 種別の日本語表示。 */
export function templateKindLabel(template: PluginTemplateDefinition): string {
  return template.kind === "render" ? "レスの表示ルール" : "ボタン・情報の表示";
}

/** changelog 先頭の `[template:<id>]`（report28 §6.3）を解析する。 */
export function parseTemplateOrigin(
  changelog: string | null | undefined,
): { templateId: string; label: string } | null {
  if (!changelog) return null;
  const matched = /^\s*\[template:([a-z0-9-]{1,64})\]/.exec(changelog);
  if (!matched) return null;
  const templateId = matched[1] ?? "";
  return { templateId, label: findPluginTemplate(templateId)?.label ?? templateId };
}