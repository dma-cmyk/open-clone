"use client";

// 全員から非表示にしたレスの一覧（板の管理画面「非表示のレス」タブと
// サイト管理画面「/admin/hidden-posts」で共通に使う）。
// 行ごとに「再表示」と、スレのそのレスへのリンクを出す。

import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Spinner, useToast } from "@/components/ui";
import { api } from "./api";
import { formatDate, threadPath } from "./format";
import type { HiddenPostItem } from "./types";

export function HiddenPostsPanel({
  scope,
  board,
  showBoard = false,
}: {
  /** board = その板の一覧（board はスラッグ）、site = 全板（board は任意の絞り込み）。 */
  scope: "board" | "site";
  board?: string;
  showBoard?: boolean;
}) {
  const toast = useToast();
  const [items, setItems] = useState<HiddenPostItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(
    async (nextCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.listHiddenPosts({ scope, board, cursor: nextCursor });
        setItems((prev) => (nextCursor ? [...prev, ...result.items] : result.items));
        setCursor(result.nextCursor);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "非表示のレスを読み込めませんでした");
      } finally {
        setLoading(false);
      }
    },
    [scope, board],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (item: HiddenPostItem) => {
    if (
      !window.confirm(
        `レス ${item.num} を再表示しますか？\n全員に見えるようになります。あとから「全員から非表示」で戻せます。`,
      )
    ) {
      return;
    }
    setBusyId(item.postId);
    setError(null);
    try {
      await api.restorePost(item.postId);
      setItems((prev) => prev.filter((entry) => entry.postId !== item.postId));
      toast.show(`レス ${item.num} を再表示しました`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "再表示に失敗しました");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="oc-stack">
      <Notice kind="ok">
        ここには「全員から非表示」にしたレスが残ります。再表示すると、また全員に見えるようになります。
        非表示・再表示の操作は監査ログにも残ります。
      </Notice>
      {error ? (
        <Notice kind="error" onRetry={() => void load()}>
          {error}
        </Notice>
      ) : null}
      {loading && items.length === 0 ? <Spinner label="非表示のレスを読み込み中…" /> : null}
      {!loading && !error && items.length === 0 ? (
        <div className="oc-empty">非表示にしたレスはありません。</div>
      ) : null}

      {items.map((item) => (
        <div key={item.postId} className="oc-surface">
          <div className="oc-row-between">
            <span className="oc-row">
              {showBoard ? (
                <span className={`oc-badge ${item.boardStatus === "deleted" ? "oc-badge-red" : "oc-badge-gray"}`}>
                  {item.boardName}（{item.boardSlug}）
                  {item.boardStatus === "deleted" ? "・板は削除済み" : ""}
                </span>
              ) : null}
              <a className="oc-thread-title" href={`${threadPath(item.boardSlug, item.threadId)}#p${item.num}`}>
                {item.threadTitle}
              </a>
              <span className="oc-muted oc-small">レス {item.num}</span>
            </span>
            <span className="oc-muted oc-tiny">{formatDate(item.createdAt)}</span>
          </div>

          <div className="oc-small oc-mt">名前: {item.name || "名無しさん"}</div>
          <div className="oc-post-main oc-small oc-mt" style={{ whiteSpace: "pre-wrap" }}>
            {item.excerpt}
          </div>

          <div className="oc-row-between oc-mt">
            <span className="oc-muted oc-small">
              非表示にした人: {item.hiddenByName ?? "不明"} /{" "}
              {item.hiddenAt ? formatDate(item.hiddenAt) : "日時不明"}
            </span>
            <span className="oc-row">
              <a className="oc-btn oc-btn-sm" href={`${threadPath(item.boardSlug, item.threadId)}#p${item.num}`}>
                スレで見る
              </a>
              <Button
                size="sm"
                variant="primary"
                disabled={busyId === item.postId}
                onClick={() => void restore(item)}
              >
                再表示
              </Button>
            </span>
          </div>
        </div>
      ))}

      {cursor ? (
        <div className="oc-row" style={{ justifyContent: "center" }}>
          <Button size="sm" disabled={loading} onClick={() => void load(cursor)}>
            さらに読み込む
          </Button>
        </div>
      ) : null}
    </div>
  );
}