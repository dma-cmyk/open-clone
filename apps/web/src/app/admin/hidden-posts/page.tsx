"use client";

// サイト管理画面「非表示のレス」（全板）。
// 板の管理画面と同じ表示部品（HiddenPostsPanel）を使い、板スラッグで絞り込める。
// API: GET /v1/admin/hidden-posts / POST /v1/posts/:id/restore

import { useState } from "react";
import { Button } from "@/components/ui";
import { HiddenPostsPanel } from "@/features/board-ui/hidden-posts-panel";

export default function AdminHiddenPostsPage() {
  const [board, setBoard] = useState("");
  const [filter, setFilter] = useState("");

  return (
    <div className="oc-stack">
      <div className="oc-row-between">
        <h1 style={{ fontSize: 18, margin: 0 }}>非表示のレス</h1>
        <span className="oc-row">
          <input
            className="oc-input"
            style={{ width: 180 }}
            value={board}
            placeholder="板 slug（任意）"
            aria-label="板 slug"
            onChange={(event) => setBoard(event.target.value)}
          />
          <Button size="sm" onClick={() => setFilter(board.trim())}>
            絞り込む
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setBoard("");
              setFilter("");
            }}
          >
            解除
          </Button>
        </span>
      </div>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        全板の「全員から非表示」にしたレスです。板の管理画面の「非表示のレス」タブと同じ内容で、
        ここでは板をまたいで確認・再表示できます。
      </p>
      <HiddenPostsPanel key={filter} scope="site" board={filter || undefined} showBoard />
    </div>
  );
}