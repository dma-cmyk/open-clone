"use client";

// トップページ（板一覧・カテゴリ・最近見たスレ）。
import { useMemo, useState } from "react";
import { api } from "@/features/board-ui/api";
import { historyStore } from "@/features/board-ui/history";
import { formatRelative } from "@/features/board-ui/format";
import { useApiData, errorMessage } from "@/features/board-ui/use-api-data";
import { PluginSlot } from "@/components/plugin-slot";
import { Button, Notice, Spinner } from "@/components/ui";
import { Link } from "../router";
import type { BoardSummary } from "@/features/board-ui/types";

export function HomeView() {
  const boards = useApiData(() => api.listBoards(), []);
  const history = historyStore.use();
  const [category, setCategory] = useState<string>("");

  const grouped = useMemo(() => {
    const groups = new Map<string, BoardSummary[]>();
    for (const board of boards.data?.items ?? []) {
      const key = board.category || "その他";
      groups.set(key, [...(groups.get(key) ?? []), board]);
    }
    return Array.from(groups.entries());
  }, [boards.data]);

  const filtered = category ? grouped.filter(([name]) => name === category) : grouped;
  const totalThreads = (boards.data?.items ?? []).reduce((sum, board) => sum + (board.threadCount ?? 0), 0);
  const recentReads = history.reads.slice(0, 5);
  const bookmarks = history.bookmarks.slice(0, 5);

  return (
    <div>
      <section className="oc-hero">
        <img src="/logo.svg" alt="" className="oc-hero-mark" width={72} height={72} />
        <div>
          <h1>おーぷんクローン</h1>
          <p>
            板もスレもレスも、ユーザーの手で。AI が日常管理を支える匿名掲示板です。
            <br />
            誰でも板を作って運営できます。ルール・デザイン・プラグインは板ごとに設定できます。
          </p>
          <div className="oc-row oc-mt">
            <Link href="/boards/new">
              <span className="oc-btn oc-btn-primary">＋ 板を作る</span>
            </Link>
            <a className="oc-btn" href="/plugins">
              プラグイン
            </a>
            <a className="oc-btn" href="/ranking">
              ランキング
            </a>
          </div>
        </div>
      </section>

      <PluginSlot slot="site-top" />

      {/* SP トップの検索帯（open2ch 風の暗色帯。PC はヘッダ検索があるため非表示） */}
      <form className="oc-row oc-mt oc-sp-search oc-home-search" action="/search" method="get" role="search">
        <input
          className="oc-input oc-input-sm"
          type="search"
          name="q"
          placeholder="スレタイ・本文を検索"
          aria-label="サイト内検索"
          maxLength={100}
        />
        <Button size="sm" type="submit">
          検索
        </Button>
      </form>

      {boards.loading && !boards.data ? <Spinner label="板一覧を読み込み中…" /> : null}
      {boards.error ? (
        <Notice kind="error" onRetry={boards.reload}>
          板一覧を読み込めませんでした: {errorMessage(boards.error)}
        </Notice>
      ) : null}

      {boards.data ? (
        <>
          <div className="oc-panel">
            <div className="oc-panel-title">
              <span>掲示板一覧</span>
              <span className="oc-muted oc-small">
                板 {boards.data.items.length} / スレ {totalThreads}
              </span>
              <span className="oc-spacer" />
              <span className="oc-muted oc-small">カテゴリで絞り込み</span>
            </div>
            <div className="oc-panel-inner">
              <div className="oc-cat-bar">
                <button
                  type="button"
                  className={`oc-chip${category === "" ? " oc-chip-active" : ""}`}
                  onClick={() => setCategory("")}
                >
                  すべて
                </button>
                {boards.data.categories.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={`oc-chip${category === name ? " oc-chip-active" : ""}`}
                    onClick={() => setCategory(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>

              {filtered.length === 0 ? (
                <div className="oc-empty">
                  板がまだありません。<Link href="/boards/new">最初の板を作る</Link>
                </div>
              ) : null}

              {filtered.map(([name, items]) => (
                <section key={name} className="oc-mb">
                  <h2 style={{ fontSize: 13, margin: "6px 0 4px", color: "#145022" }}>{name}</h2>
                  <div className="oc-board-list">
                    {items.map((board) => (
                      <Link key={board.slug} href={`/b/${encodeURIComponent(board.slug)}`} className="oc-board-item">
                        <div className="oc-row-between">
                          <span className="oc-board-item-name">{board.name}</span>
                          <span className="oc-muted oc-tiny">
                            {board.threadCount !== undefined ? `${board.threadCount}スレ` : ""}
                          </span>
                        </div>
                        {board.description ? <div className="oc-board-item-desc">{board.description}</div> : null}
                        {board.lastPostAt ? (
                          <div className="oc-muted oc-tiny">最終 {formatRelative(board.lastPostAt)}</div>
                        ) : null}
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>

          {recentReads.length > 0 || bookmarks.length > 0 ? (
            <div className="oc-grid-2">
              <div className="oc-panel">
                <div className="oc-panel-title">
                  <span>最近見たスレ</span>
                  <span className="oc-spacer" />
                  <Link href="/settings" className="oc-small">
                    履歴をすべて見る
                  </Link>
                </div>
                <div className="oc-panel-inner">
                  {recentReads.length === 0 ? <div className="oc-muted oc-small">まだありません</div> : null}
                  {recentReads.map((item) => (
                    <div key={item.key} className="oc-history-item">
                      <span className="oc-history-time">{formatRelative(item.at / 1000)}</span>
                      <Link href={item.path}>{item.title || item.path}</Link>
                    </div>
                  ))}
                </div>
              </div>
              <div className="oc-panel">
                <div className="oc-panel-title">
                  <span>ブクマ</span>
                  <span className="oc-spacer" />
                  <Link href="/settings" className="oc-small">
                    管理
                  </Link>
                </div>
                <div className="oc-panel-inner">
                  {bookmarks.length === 0 ? <div className="oc-muted oc-small">まだありません</div> : null}
                  {bookmarks.map((item) => (
                    <div key={item.key} className="oc-history-item">
                      <span className="oc-history-time">★</span>
                      <Link href={item.path}>{item.title || item.path}</Link>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}