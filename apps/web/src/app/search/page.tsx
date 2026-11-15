"use client";

// 検索ページ（スレタイ / 全文 / ID / 画像）。`/search?q=...&type=...`。
import { useEffect, useMemo, useRef, useState } from "react";
import { formatRelative, threadPath } from "@/features/board-ui/format";
import { Button, Empty, Notice, Spinner } from "@/components/ui";
import { Wp1ApiError, search, suggest, type SearchItem, type SearchResponse } from "../_wp1/api";
import { Wp1Page } from "../_wp1/frame";

type SearchType = "thread" | "full" | "id" | "image";

const TYPES: Array<{ value: SearchType; label: string; hint: string }> = [
  { value: "thread", label: "スレタイ", hint: "スレッドタイトルの部分一致" },
  { value: "full", label: "全文", hint: "3 文字以上は FTS5、2 文字以下は部分一致" },
  { value: "id", label: "ID", hint: "表示 ID（4 文字）でレスを抽出" },
  { value: "image", label: "画像", hint: "画像付きレス・本文/スレタイの一致" },
];

interface Submitted {
  q: string;
  type: SearchType;
  board: string;
}

/**
 * 検索スニペットの描画（C1 / museAI #9）。
 * API は装飾記法 `[sp]...[/sp]` の中身を伏せ字（█）へマスクして返すため、
 * ここでは連続する伏せ字を「クリックで中身は出せない伏せ字」として枠表示し、
 * 生タグがそのまま読者に見えることを防ぐ。
 */
function SnippetBody({ body }: { body: string }) {
  const parts = body.split(/(█{2,})/g);
  return (
    <div className="oc-post-main" style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((part, index) =>
        /^█{2,}$/.test(part) ? (
          <span
            key={index}
            title="伏せ字（検索結果では中身を表示しません）"
            style={{ background: "#333", color: "#fff", borderRadius: 2, padding: "0 4px" }}
          >
            伏せ字
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </div>
  );
}

/** 検索条件が同一か（C3: 取得中・取得済みの結果がどの条件のものかを判別する） */
function sameSubmitted(a: Submitted | null, b: Submitted | null): boolean {
  if (a === null || b === null) return a === b;
  return a.q === b.q && a.type === b.type && a.board === b.board;
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SearchType>("thread");
  const [board, setBoard] = useState("");
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  /** `data` がどの検索条件で取得されたか（C3: 種別切替中に古い結果を新種別と組にしない） */
  const [dataFor, setDataFor] = useState<Submitted | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ term: string; count: number }>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  /**
   * 検索の世代（UX-R2 / C3）。検索開始・追加読込開始のたびに進め、応答処理は開始時の世代と
   * 現在が一致するときだけ data / cursor / error / loading を更新する。
   * 条件切替・再検索・追加読込のいずれよりも古い応答はすべて破棄される。
   */
  const generationRef = useRef(0);

  // 初回は URL のクエリを復元する（静的エクスポートのため useSearchParams は使わない）。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial: Submitted = {
      q: params.get("q") ?? "",
      type: (params.get("type") as SearchType) ?? "thread",
      board: params.get("board") ?? "",
    };
    setQuery(initial.q);
    setType(TYPES.some((item) => item.value === initial.type) ? initial.type : "thread");
    setBoard(initial.board);
    if (initial.q) setSubmitted(initial);
    suggest()
      .then((result) => setSuggestions(result.items))
      .catch(() => setSuggestions([]));
  }, []);

  useEffect(() => {
    if (!submitted || submitted.q.trim().length === 0) {
      generationRef.current += 1; // 進行中の応答を無効化
      setData(null);
      setDataFor(null);
      setCursor(null);
      setError(null);
      setLoading(false);
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    search({
      q: submitted.q.trim(),
      type: submitted.type,
      board: submitted.board.trim() || undefined,
      limit: 30,
    })
      .then((result) => {
        if (generation !== generationRef.current) return;
        setData(result);
        setDataFor(submitted);
        setCursor(result.nextCursor);
      })
      .catch((cause: unknown) => {
        if (generation !== generationRef.current) return;
        setError(cause instanceof Wp1ApiError ? cause.message : cause instanceof Error ? cause.message : "検索に失敗しました");
      })
      .finally(() => {
        if (generation === generationRef.current) setLoading(false);
      });
  }, [submitted]);

  const runSearch = (next: Submitted, replaceUrl = true) => {
    if (replaceUrl) {
      const params = new URLSearchParams();
      if (next.q) params.set("q", next.q);
      if (next.type !== "thread") params.set("type", next.type);
      if (next.board) params.set("board", next.board);
      const suffix = params.toString();
      window.history.replaceState(null, "", `/search${suffix ? `?${suffix}` : ""}`);
    }
    setSubmitted(next);
  };

  const loadMore = async () => {
    if (!submitted || !cursor) return;
    const generation = ++generationRef.current;
    const requested = { submitted, cursor };
    setLoading(true);
    try {
      const next = await search({
        q: requested.submitted.q.trim(),
        type: requested.submitted.type,
        board: requested.submitted.board.trim() || undefined,
        limit: 30,
        cursor: requested.cursor,
      });
      if (generation !== generationRef.current) return;
      setData((current) =>
        current ? { ...next, items: [...current.items, ...next.items] } : next,
      );
      setCursor(next.nextCursor);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setError(cause instanceof Error ? cause.message : "追加読み込みに失敗しました");
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  };

  const items: SearchItem[] = useMemo(() => data?.items ?? [], [data]);
  const active = TYPES.find((item) => item.value === type) ?? TYPES[0]!;

  return (
    <Wp1Page
      title="検索"
      description="スレタイ・レス本文・表示 ID・画像から探せます。全文検索は 3 文字以上で高速（FTS5）、2 文字以下は部分一致にフォールバックします。"
      actions={<a className="oc-btn oc-btn-sm" href="/ranking">ランキング</a>}
    >
      <form
        className="oc-panel oc-mb"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch({ q: query, type, board });
        }}
      >
        <div className="oc-panel-inner oc-stack">
          <div className="oc-row">
            <input
              className="oc-input"
              style={{ flex: 1, minWidth: 200 }}
              type="search"
              name="q"
              value={query}
              maxLength={100}
              placeholder="検索語（例: プロ野球）"
              aria-label="検索語"
              onChange={(event) => setQuery(event.target.value)}
            />
            <input
              className="oc-input"
              style={{ width: 160 }}
              type="text"
              name="board"
              value={board}
              placeholder="板 slug（任意）"
              aria-label="板 slug"
              onChange={(event) => setBoard(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={loading || query.trim().length === 0}>
              検索
            </Button>
          </div>
          <div className="oc-row" role="tablist" aria-label="検索種別">
            {TYPES.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={type === item.value}
                className={`oc-chip${type === item.value ? " oc-chip-active" : ""}`}
                onClick={() => {
                  setType(item.value);
                  if (submitted) runSearch({ ...submitted, type: item.value });
                }}
              >
                {item.label}
              </button>
            ))}
            <span className="oc-muted oc-tiny">{active.hint}</span>
          </div>
        </div>
      </form>

      {!submitted && suggestions.length > 0 ? (
        <div className="oc-panel oc-mb">
          <div className="oc-panel-title"><span>よく検索されている語</span></div>
          <div className="oc-panel-inner oc-row">
            {suggestions.map((item) => (
              <button
                key={item.term}
                type="button"
                className="oc-chip"
                onClick={() => {
                  setQuery(item.term);
                  runSearch({ q: item.term, type, board });
                }}
              >
                {item.term} <span className="oc-muted oc-tiny">{item.count}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {submitted === null && query.trim().length === 0 ? (
        <Notice kind="warn">
          検索語を入力してください。上の欄に語を入れて「検索」を押すと、スレタイ・レス本文・表示 ID・画像から探せます。
        </Notice>
      ) : null}
      {submitted !== null && submitted.q.trim().length === 0 ? (
        <Notice kind="warn">検索語が空のまま実行されました。検索語を入力してください。</Notice>
      ) : null}
      {loading && !data ? <Spinner label="検索中…" /> : null}
      {loading && data ? <Spinner label={`検索中…（種別: ${active.label}）`} /> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      {data && sameSubmitted(dataFor, submitted) ? (
        <div className="oc-panel">
          <div className="oc-panel-title">
            <span>
              {submitted?.q} の検索結果
              <span className="oc-muted oc-small">（{items.length} 件）</span>
            </span>
            <span className="oc-muted oc-tiny">種別: {active.label}</span>
          </div>
          <div className="oc-panel-inner">
            {items.length === 0 ? (
              <Empty>該当する結果がありません。語を短くする・別の種別を試してください。</Empty>
            ) : null}
            {items.map((item) =>
              item.type === "thread" ? (
                <div key={`thread-${item.thread.id}`} className="oc-surface oc-mb">
                  <a className="oc-thread-title" href={threadPath(item.thread.boardSlug, item.thread.id)}>
                    {item.thread.title}
                  </a>
                  <div className="oc-muted oc-small">
                    {item.thread.boardName}（{item.thread.boardSlug}） / {item.thread.postCount} レス / 最終{" "}
                    {formatRelative(item.thread.lastPostAt)}
                  </div>
                </div>
              ) : (
                <div key={`post-${item.post.id}`} className="oc-surface oc-mb">
                  <div className="oc-small">
                    <span className="oc-post-name">{item.post.name}</span>{" "}
                    <span className="oc-muted">{item.post.idHash}</span>{" "}
                    <a href={`${threadPath(item.thread.boardSlug, item.thread.id)}?r=${item.post.num}`}>
                      {item.thread.title} &gt;&gt;{item.post.num}
                    </a>
                  </div>
                  <SnippetBody body={item.post.body.length > 280 ? `${item.post.body.slice(0, 280)}…` : item.post.body} />
                  <div className="oc-muted oc-tiny">投稿 {formatRelative(item.post.createdAt)}</div>
                </div>
              ),
            )}
            {cursor ? (
              <div className="oc-row" style={{ justifyContent: "center" }}>
                <Button size="sm" onClick={() => void loadMore()} disabled={loading}>
                  {loading ? "読み込み中…" : "さらに読み込む"}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </Wp1Page>
  );
}