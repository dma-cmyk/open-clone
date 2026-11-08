// プラグイン作者向けエントリポイント。
// サンドボックス iframe ではホストのブートストラップが `register` を定義する。
// バンドルせず単一ファイルで配布する場合も、この関数を経由すると型補完が効く。

import type { PluginDefinition } from "./types";

/** SDK のバージョン（manifest の version とは別。互換性表示用）。 */
export const PLUGIN_SDK_VERSION = "1.0.0";

/**
 * プラグインを登録する。
 *
 * ```js
 * register({
 *   slots: {
 *     "thread-post-inline": ({ data, root }) => {
 *       root.textContent = data.post.body;
 *     },
 *   },
 * });
 * ```
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  if (typeof globalThis.register !== "function") {
    throw new Error(
      "register が見つかりません。プラグインは open-clone のサンドボックス（plugin-host）内で実行してください",
    );
  }
  globalThis.register(definition);
  return definition;
}

/** 実行中の API を取得する（activate 以降でのみ有効）。 */
export function getPluginApi() {
  if (!globalThis.plugin) {
    throw new Error("plugin API はまだ初期化されていません（activate 内で呼んでください）");
  }
  return globalThis.plugin;
}