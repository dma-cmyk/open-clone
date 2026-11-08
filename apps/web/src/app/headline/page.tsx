"use client";

// ヘッドライン（新着・勢いのあるスレッド）。`/headline?period=24h&sort=bump`。
import { useEffect, useState } from "react";
import { formatRelative, threadPath } from "@/features/board-ui/format";
import { Notice, Spinner } from "@/components/ui";
import { headline, type HeadlineItem } from "../_wp1/api";
import { Wp1Page } from "../_wp1/frame";

type Period = "1h" | "24h" | "7d" | "all";
type Sort = "bump" | "created" | "posts" | "speed";

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "1h", label: "1時間" },
  { value: "24h", label: "24時間" },
  { value: "7d", label: "1週間" },
  { value: "all", label: "全期間" },
];

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "bump", label: "最終レス" },
  { value: "created", label: "作成" },
  { value: "posts", label: "レス数" },
  { value: "speed", label: "勢い" },
];

export default function HeadlinePage() {
  const [period, setPeriod] = useState<Period>("24h");
  const [sort, setSort] = useState<Sort>("bump");
  const [board, setBoard] = useState("");
  const [minPosts, setMinPosts] = useState(0);
  const [items, setItems] = useState<HeadlineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("period") as Period | null;
    const s = params.get("sort") as Sort | null;
    if (p && PERIODS.some((item) => item.value === p)) setPeriod(p);
    if (s && SORTS.some((item) => item.value === s)) setSort(s);
    setBoard(params.get("board") ?? "");
    setMinPosts(Number(params.get("minPosts") ?? 0) || 0);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    headline({ period, sort, board: board.trim() || undefined, minPosts: minPosts || undefined, limit: 50 })
      .then((result) => {
        if (alive) setItems(result.items);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : "ヘッドラインの取得に失敗しました");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const params = new URLSearchParams({ period, sort });
    if (board.trim()) params.set("board", board.trim());
    if (minPosts > 0) params.set("minPosts", String(minPosts));
    window.history.replaceState(null, "", `/headline?${params.toString()}`);
    return () => {
      alive = false;
    };
  }, [period, sort, board, minPosts]);

  return (
    <Wp1Page
      title="ヘッドライン"
      description="期間・並び順・最低レス数でスレッドを一覧します。板 slug を指定すると板内ヘッドラインになります。"
      actions={<a className="oc-btn oc-btn-sm" href="/ranking">ランキング</a>}
    >
      <div className="oc-panel">
        <div className="oc-panel-inner oc-stack">
          <div className="oc-row" role="tablist" aria-label="期間">
            {PERIODS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={period === item.value}
                className={`oc-chip${period === item.value ? " oc-chip-active" : ""}`}
                onClick={() => setPeriod(item.value)}
              >
                {item.label}
              </button>
            ))}
            <span className="oc-spacer" />
            {SORTS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`oc-chip${sort === item.value ? " oc-chip-active" : ""}`}
                onClick={() => setSort(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="oc-row">
            <input
              className="oc-input"
              style={{ width: 180 }}
              value={board}
              placeholder="板 slug（任意）"
              aria-label="板 slug"
              onChange={(event) => setBoard(event.target.value)}
            />
            <label className="oc-small oc-muted">
              最低レス数{" "}
              <input
                className="oc-input"
                style={{ width: 80 }}
                type="number"
                min={0}
                max={1000}
                value={minPosts}
                onChange={(event) => setMinPosts(Math.max(0, Number(event.target.value) || 0))}
              />
            </label>
            <a className="oc-btn oc-btn-sm" href="/search">
              検索
            </a>
          </div>

          {loading && items.length === 0 ? <Spinner label="ヘッドラインを取得中…" /> : null}
          {error ? <Notice kind="error">{error}</Notice> : null}

          {items.length === 0 && !loading && !error ? (
            <div className="oc-empty">条件に合うスレッドがありません。</div>
          ) : null}

          {items.map((item, index) => (
            <div key={item.threadId} className="oc-surface oc-mb">
              <div className="oc-row-between">
                <span>
                  <span className="oc-muted oc-small">{index + 1}. </span>
                  <a className="oc-thread-title" href={threadPath(item.boardSlug, item.threadId)}>
                    {item.title}
                  </a>
                  {item.live ? <span className="oc-badge oc-badge-green" style={{ marginLeft: 6 }}>実況</span> : null}
                  {item.pinned ? <span className="oc-badge oc-badge-yellow" style={{ marginLeft: 6 }}>固定</span> : null}
                </span>
                <span className="oc-muted oc-tiny">{formatRelative(item.lastPostAt)}</span>
              </div>
              <div className="oc-muted oc-small">
                {item.boardName} / {item.postCount} レス / 勢い {item.speed.toFixed(2)} レス毎時
              </div>
            </div>
          ))}
        </div>
      </div>
    </Wp1Page>
  );
}