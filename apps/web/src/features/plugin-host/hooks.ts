"use client";

// プラグイン連携用の React フック。
// WP2 はスレ画面で `usePluginPostRenderRules` を呼び、得た規則を applyPostRenderRules に渡す。

import { useEffect, useState } from "react";
import type { PluginPostRenderRule } from "shared";
import { loadActiveInstalls } from "./api";

export interface PluginRulesParams {
  boardId?: number;
  boardSlug?: string;
  threadId?: number;
  /** 停止（キル）反映のための再取得間隔。0 で無効 */
  refreshIntervalMs?: number;
}

/** 現在のページに適用されるプラグインの宣言的レンダー規則を集める。 */
export function usePluginPostRenderRules(params: PluginRulesParams = {}): PluginPostRenderRule[] {
  const { boardId, boardSlug, threadId, refreshIntervalMs } = params;
  const [rules, setRules] = useState<PluginPostRenderRule[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await loadActiveInstalls({ boardId, boardSlug, threadId });
        if (cancelled) return;
        setRules(
          response.items
            .filter((install) => !install.stopped)
            .flatMap((install) => install.manifest.render?.post ?? []),
        );
      } catch {
        if (!cancelled) setRules([]);
      }
    };
    void load();
    if (refreshIntervalMs === 0) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(load, refreshIntervalMs ?? 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [boardId, boardSlug, threadId, refreshIntervalMs]);

  return rules;
}
