"use client";

// 全板一覧（横断確認と板管理への導線）。

import Link from "next/link";
import { useEffect, useState } from "react";
import type { BoardSummary } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";

interface BoardsResponse {
  items: BoardSummary[];
  categories: string[];
}

export default function AdminBoardsPage() {
  const { state } = useSession();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state?.authenticated) return;
    api<BoardsResponse>("GET", "/boards?limit=100")
      .then((data) => {
        setBoards(data.items);
        setCategories(data.categories ?? []);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [state]);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;

  const visible = (boards ?? []).filter(
    (board) => !filter || board.category === filter,
  );

  return (
    <div className="oc-stack">
      <h1 style={{ fontSize: 18, margin: 0 }}>板一覧（全板横断）</h1>
      {error ? (
        <div className="oc-warn-box">
          板一覧 API を取得できませんでした: {error}（WP1 の /v1/boards が未提供の可能性があります）
        </div>
      ) : null}
      <div className="oc-row">
        <button type="button" className={`oc-chip ${filter === "" ? "oc-chip-active" : ""}`} onClick={() => setFilter("")}>
          すべて
        </button>
        {categories.map((category) => (
          <button
            key={category}
            type="button"
            className={`oc-chip ${filter === category ? "oc-chip-active" : ""}`}
            onClick={() => setFilter(category)}
          >
            {category}
          </button>
        ))}
      </div>

      {!boards ? (
        <div className="oc-loading">板一覧を取得中…</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {["板", "カテゴリ", "スレ", "レス", "最終投稿", "操作"].map((head) => (
                  <th key={head} style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((board) => (
                <tr key={board.id}>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                    <Link href={`/b/${board.slug}`}>{board.name}</Link>
                    <span className="oc-tiny oc-muted"> /{board.slug}</span>
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{board.category}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{board.threadCount}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{board.postCount}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                    {board.lastPostAt ? new Date(board.lastPostAt * 1000).toLocaleString("ja-JP") : "-"}
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                    <div className="oc-row" style={{ gap: 6 }}>
                      <Link className="oc-btn oc-btn-sm" href={`/b/${board.slug}/manage`}>
                        板管理
                      </Link>
                      <Link className="oc-btn oc-btn-sm" href={`/b/${board.slug}/manage/reports`}>
                        通報
                      </Link>
                      <Link className="oc-btn oc-btn-sm" href={`/plugins/board/?slug=${encodeURIComponent(board.slug)}`}>
                        プラグイン
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="oc-empty">
                    板がありません
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
      <p className="oc-note">
        板単位のアクセス禁止は <Link href="/admin/suspensions">規制</Link>
        から board スコープを選択して作成できます。板のルール・デザイン・スタッフ任免は各板の管理画面で行います。
      </p>
    </div>
  );
}