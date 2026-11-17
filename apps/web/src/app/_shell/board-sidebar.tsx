"use client";

// 左の板一覧（open2ch の frameset 左 103px 相当）。
// PC のみ表示。カテゴリ見出し＋板リンクを密に並べ、本文の邪魔をしない。
import { useMemo } from "react";
import { api } from "@/features/board-ui/api";
import { useApiData } from "@/features/board-ui/use-api-data";
import { PluginSlot } from "@/components/plugin-slot";
import { Link, useLocation, useRoute } from "./router";

export function BoardSidebar() {
  const boards = useApiData(() => api.listBoards(), []);
  const location = useLocation();
  // 板スコープのプラグインを解決するための slug とスレ ID。スレ本体のスロットと同じ条件に
  // して `/plugins/active` をページで 1 回に保つ。互換 URL（/test/read.cgi/<board>/<key>/）も
  // シェルと同じ `parseRoute` で解決する（レビュー 63 M2）。
  const route = useRoute();
  const boardSlug =
    route.name === "board" || route.name === "thread" || route.name === "manage" ? route.slug : undefined;
  const threadId = route.name === "thread" ? route.threadId : undefined;

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
              title={`${board.name}（/b/${board.slug}）`}
            >
              {/* C7 / museAI #6: 省略表示でも同名板を区別できるよう slug を 2 行目に出す */}
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{board.name}</span>
              <span
                style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", color: "#666", fontSize: 10 }}
              >
                /b/{board.slug}
              </span>
            </Link>
          ))}
        </div>
      ))}
      {boards.error ? <div className="oc-sidebar-title">板一覧を取得できません</div> : null}
      {/* 板のサイドバー（板ページでは板スコープのプラグインも対象）。 */}
      <PluginSlot slot="board-sidebar" boardSlug={boardSlug} threadId={threadId} />
    </nav>
  );
}