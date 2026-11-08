"use client";

// 左の板一覧（open2ch の frameset 左 103px 相当）。
// PC のみ表示。カテゴリ見出し＋板リンクを密に並べ、本文の邪魔をしない。
import { useMemo } from "react";
import { api } from "@/features/board-ui/api";
import { useApiData } from "@/features/board-ui/use-api-data";
import { Link, useLocation } from "./router";

export function BoardSidebar() {
  const boards = useApiData(() => api.listBoards(), []);
  const location = useLocation();

  const grouped = useMemo(() => {
    const groups = new Map<string, { slug: string; name: string }[]>();
    for (const board of boards.data?.items ?? []) {
      const list = groups.get(board.category) ?? [];
      list.push({ slug: board.slug, name: board.name });
      groups.set(board.category, list);
    }
    return Array.from(groups.entries());
  }, [boards.data]);

  return (
    <nav className="oc-sidebar" aria-label="板一覧">
      <div className="oc-sidebar-top">板一覧</div>
      <Link href="/">トップ</Link>
      <Link href="/boards/new">板を作る</Link>
      <Link href="/settings">設定</Link>
      <a href="/ranking">ランキング</a>
      <a href="/headline">ヘッドライン</a>
      {grouped.map(([category, items]) => (
        <div key={category}>
          <div className="oc-sidebar-title">{category}</div>
          {items.map((board) => (
            <Link
              key={board.slug}
              href={`/b/${encodeURIComponent(board.slug)}`}
              className={location.startsWith(`/b/${board.slug}`) ? "oc-sidebar-active" : undefined}
              title={board.name}
            >
              {board.name}
            </Link>
          ))}
        </div>
      ))}
      {boards.error ? <div className="oc-sidebar-title">板一覧を取得できません</div> : null}
    </nav>
  );
}