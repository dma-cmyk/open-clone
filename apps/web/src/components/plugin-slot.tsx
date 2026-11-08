"use client";

// プラグインの UI スロット（ホスト側の差し込み点）。
// 実体のサンドボックス iframe ランナーは WP3 が `features/plugin-host/` に実装し、
// ここへレンダラを登録する（registerPluginSlotRenderer）。WP2 はスロット位置だけを提供する。

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

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

  if (!mounted || renderers.size === 0) {
    return null;
  }
  const context: PluginSlotContext = { ...props };
  const nodes = Array.from(renderers).map((renderer, index) => (
    <span key={index}>{renderer(context)}</span>
  ));
  return <div data-plugin-slot={props.slot}>{nodes}</div>;
}