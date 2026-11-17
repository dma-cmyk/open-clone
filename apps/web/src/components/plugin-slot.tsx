"use client";

// プラグインの UI スロット（ホスト側の差し込み点）。
// 実体のサンドボックス iframe ランナーは WP3 が `features/plugin-host/` に実装し、
// ここへレンダラを登録する（registerPluginSlotRenderer）。WP2 はスロット位置だけを提供する。

import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePluginPageScope } from "./plugin-scope";

export type PluginSlotName =
  | "site-header"
  | "site-top"
  | "board-top"
  | "board-sidebar"
  | "thread-top"
  | "thread-nav"
  | "post-form-extra"
  | "thread-bottom"
  | "board-manage"
  | "post-actions";

export interface PluginSlotContext {
  slot: PluginSlotName;
  boardSlug?: string;
  threadId?: number;
  postId?: number;
  /** レス個別スロット（post-actions）の本文。装飾系プラグインの判定材料。 */
  postBody?: string;
}

export type PluginSlotRenderer = (context: PluginSlotContext) => ReactNode;

const renderers = new Set<PluginSlotRenderer>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

/** WP3 のプラグインホストが呼ぶ。戻り値で解除できる。 */
export function registerPluginSlotRenderer(renderer: PluginSlotRenderer): () => void {
  renderers.add(renderer);
  emit();
  return () => {
    renderers.delete(renderer);
    emit();
  };
}

export function PluginSlot(props: Omit<PluginSlotContext, "slot"> & { slot: PluginSlotName }) {
  // プラグインホストはブラウザ専用（iframe/sandbox）。SSR とハイドレーション初回を一致させるため、
  // マウント後にだけレンダラを呼ぶ（サーバー側のスロット出力とクライアント出力の不一致を防ぐ）。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => 0,
  );

  const scope = usePluginPageScope();

  // シェルが実際の URL を確定する前（静的書き出しの初期描画）は何も出さない。
  // 仮の文脈（トップ）で `/plugins/active` を 1 回余計に呼ばないため。
  if (!mounted || scope === null || renderers.size === 0) {
    return null;
  }
  // スロット自身が持たない板・スレ文脈は、シェルが配るページ文脈で補う
  //（ヘッダー等もページと同じ `/plugins/active` を共有する）。
  const context: PluginSlotContext = {
    ...props,
    boardSlug: props.boardSlug ?? scope.boardSlug,
    threadId: props.threadId ?? scope.threadId,
  };
  // ラッパー要素は置かない（レスごとのスロットが 1000 件並ぶ。プラグイン未導入なら
  // DOM を増やさない）。`data-plugin-slot` は各レンダラ側の実体が持つ。
  return (
    <>
      {Array.from(renderers).map((renderer, index) => (
        <Fragment key={index}>{renderer(context)}</Fragment>
      ))}
    </>
  );
}