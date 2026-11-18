// プラグインのスロット名解決。
// サンプル/SDK が使う汎用名（thread-head など）を、WP2 のスレ画面が実際に置く
// スロット名（thread-top / post-actions など）へ割り当てる。React 非依存の純粋関数。
//
// 別名 → 置き先の対応は shared の説明表（PLUGIN_SLOT_ALIAS_HOSTS）を正本にし、
// ここでは「置き先 → 受け付ける別名の一覧」に組み替えるだけにする（二重管理しない）。

import { PLUGIN_SLOTS, pluginSlotAliases, type PluginSlotName } from "shared";

/**
 * 汎用スロット名（SDK/サンプルが宣言する名前）→ ホスト側スロット名。
 * 例: サンプルが `thread-post-footer` を宣言 → WP2 の `post-actions`（レスごと）に出す。
 */
export const SLOT_ALIASES: Record<string, readonly PluginSlotName[]> = Object.fromEntries(
  PLUGIN_SLOTS.flatMap((host) =>
    pluginSlotAliases(host).map((alias) => [alias, [host]] as const),
  ),
);

/** ホスト側スロットに出すべき、プラグインが宣言したスロット名を返す。 */
export function resolveDeclaredSlot(
  declared: readonly string[],
  hostSlot: PluginSlotName,
): PluginSlotName | null {
  if (declared.includes(hostSlot)) return hostSlot;
  for (const [generic, hosts] of Object.entries(SLOT_ALIASES)) {
    if (hosts.includes(hostSlot) && declared.includes(generic)) return generic as PluginSlotName;
  }
  return null;
}