"use client";

// ランキングページ（勢い / レス数 / 同時接続）。`/ranking?period=day&metric=speed`。
import { useEffect, useState } from "react";
import { formatRelative, threadPath } from "@/features/board-ui/format";
import { Notice, Spinner } from "@/components/ui";
import { ranking, type RankingItem } from "../_wp1/api";
import { Wp1Page } from "../_wp1/frame";

type Period = "hour" | "day" | "all";
type Metric = "speed" | "posts" | "connections";

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "hour", label: "1時間" },
  { value: "day", label: "24時間" },
  { value: "all", label: "総合" },
];

const METRICS: Array<{ value: Metric; label: string }> = [
  { value: "speed", label: "勢い" },
  { value: "posts", label: "レス数" },
  { value: "connections", label: "同時接続" },
];

export default function RankingPage() {
  const [period, setPeriod] = useState<Period>("day");
  const [metric, setMetric] = useState<Metric>("speed");
  const [board, setBoard] = useState("");
  const [items, setItems] = useState<RankingItem[]>([]);
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("period") as Period | null;
    const m = params.get("metric") as Metric | null;
    if (p && PERIODS.some((item) => item.value === p)) setPeriod(p);
    if (m && METRICS.some((item) => item.value === m)) setMetric(m);
    setBoard(params.get("board") ?? "");
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    ranking({ period, metric, board: board.trim() || undefined, limit: 50 })
      .then((result) => {
        if (!alive) return;
        setItems(result.items);
        setCapturedAt(result.capturedAt || null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : "ランキングの取得に失敗しました");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const params = new URLSearchParams();
    params.set("period", period);
    params.set("metric", metric);
    if (board.trim()) params.set("board", board.trim());
    window.history.replaceState(null, "", `/ranking?${params.toString()}`);
    return () => {
      alive = false;
    };
  }, [period, metric, board]);

  return (
    <Wp1Page
      title="ランキング"
      description="期間ごとの勢い・レス数・同時接続でスレッドを並べます。勢い = 期間内のレス数を経過時間で割った毎時換算です。"
      actions={<a className="oc-btn oc-btn-sm" href="/headline">ヘッドライン</a>}
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
            {METRICS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`oc-chip${metric === item.value ? " oc-chip-active" : ""}`}
                onClick={() => setMetric(item.value)}
              >
                {item.label}
              </button>
            ))}
            <input
              className="oc-input"
              style={{ width: 150 }}
              value={board}
              placeholder="板 slug（任意）"
              aria-label="板 slug"
              onChange={(event) => setBoard(event.target.value)}
            />
          </div>

          {loading && items.length === 0 ? <Spinner label="ランキングを集計中…" /> : null}
          {error ? <Notice kind="error">{error}</Notice> : null}

          {items.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ width: 48 }}>順位</th>
                  <th>スレッド</th>
                  <th style={{ width: 72 }}>レス</th>
                  <th style={{ width: 72 }}>勢い</th>
                  <th style={{ width: 88 }}>同時接続</th>
                  <th style={{ width: 110 }}>最終投稿</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.threadId}>
                    <td className="oc-muted">{item.rank}</td>
                    <td>
                      <a className="oc-thread-title" href={threadPath(item.boardSlug, item.threadId)}>
                        {item.title}
                      </a>
                      <div className="oc-muted oc-tiny">{item.boardName}</div>
                    </td>
                    <td>{item.postCount}</td>
                    <td>{item.speed.toFixed(2)}</td>
                    <td>{item.connections}</td>
                    <td className="oc-muted oc-tiny">{formatRelative(item.lastPostAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!loading && !error && items.length === 0 ? (
            <div className="oc-empty">まだランキング対象のスレッドがありません。</div>
          ) : null}
          {capturedAt ? (
            <div className="oc-muted oc-tiny">同時接続の集計: {formatRelative(capturedAt)}（1 時間ごとのスナップショット）</div>
          ) : null}
        </div>
      </div>
    </Wp1Page>
  );
}