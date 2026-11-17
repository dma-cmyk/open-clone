"use client";

// 現在のページ（板・スレ）の文脈をプラグインスロットへ配る。
// ヘッダーやサイドバーのスロットは板 slug / スレ ID を知らないため、シェルが 1 回配る。
// これでページ内の全スロットが同じ条件で `/plugins/active` を共有できる（ページで 1 回）。
//
// null は「シェルがまだ実際の URL を確定していない」の意味。シェル外の画面
// （Next の個別ページ）は既定値 {} を使う。

import { createContext, useContext } from "react";

export interface PluginPageScope {
  boardSlug?: string;
  threadId?: number;
}

const PluginPageScopeContext = createContext<PluginPageScope | null>({});

export const PluginPageScopeProvider = PluginPageScopeContext.Provider;

export function usePluginPageScope(): PluginPageScope | null {
  return useContext(PluginPageScopeContext);
}