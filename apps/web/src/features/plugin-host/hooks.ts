"use client";

// プラグイン連携用の React フック。
// WP2 はスレ画面で `usePluginPostRenderRules` を呼び、得た規則を applyPostRenderRules に渡す。
// 適用中プラグインの取得は `useActiveInstalls`（ページ単位で共有）に任せ、
// スロットと二重に `/plugins/active` を呼ばない。

import { useMemo } from "react";
import type { PluginPostRenderRule } from "shared";
import { useActiveInstalls } from "./active-installs";

export interface PluginRulesParams {
  boardId?: number;
  boardSlug?: string;
  threadId?: number;
}

/** 現在のページに適用されるプラグインの宣言的レンダー規則を集める。 */
export function usePluginPostRenderRules(params: PluginRulesParams = {}): PluginPostRenderRule[] {
  const { boardId, boardSlug, threadId } = params;
  const installs = useActiveInstalls({ boardId, boardSlug, threadId });
  return useMemo(
    () => installs.flatMap((install) => install.manifest.render?.post ?? []),
    [installs],
  );
}