"use client";

// 板ページ。スレ一覧（ソート/検索）、スレ立て、板ルール、板デザイン、NG スレ無視。
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/features/board-ui/api";
import { boardBanner, boardDesignStyle } from "@/features/board-ui/board-design";
import { boardPath, formatRelative, threadPath } from "@/features/board-ui/format";
import { matchNgThread, settingsStore } from "@/features/board-ui/settings";
import { useApiData, errorMessage } from "@/features/board-ui/use-api-data";
import { PostForm } from "@/features/board-ui/post-form";
import { PluginSlot } from "@/components/plugin-slot";
import { Button, Notice, Spinner, useToast } from "@/components/ui";
import { Link, navigate, useLocation } from "../router";
import type { Post } from "@/features/board-ui/types";

const SORTS = [
  { value: "speed", label: "勢い" },
  { value: "bump", label: "新レス" },
  { value: "created", label: "新スレ" },
  { value: "posts", label: "レス数" },
];

export function BoardView({ slug }: { slug: string }) {
  const location = useLocation();
  const params = useMemo(() => {
    const search = location.includes("?") ? location.slice(location.indexOf("?")) : "";
    return new URLSearchParams(search);
  }, [location]);
  const sort = params.get("sort") ?? "speed";
  const q = params.get("q") ?? "";
  const [searchDraft, setSearchDraft] = useState(q);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const touch = useRef<{ x: number; y: number; id: number } | null>(null);
  const toast = useToast();
  const settings = settingsStore.use();

  const boardInfo = useApiData(() => api.getBoard(slug), [slug]);
  const threads = useApiData(() => api.listThreads(slug, { sort, q: q || undefined, limit: 100 }), [slug, sort, q]);

  // open2ch の板ページは各スレの最新レスを数件見せる。一覧 API には本文が無いため、
  // 先頭 12 スレだけ最新 3 レスを並列取得してプレビューする（失敗は無視）。
  const [previews, setPreviews] = useState<Map<number, { op?: Post; latest: Post[] }>>(new Map());
  const threadItems = threads.data?.items;
  useEffect(() => {
    if (!threadItems || threadItems.length === 0) return;
    let alive = true;
    const targets = threadItems.slice(0, 12);
    void Promise.allSettled(
      targets.map(async (thread) => {
        const [opPage, latestPage] = await Promise.all([
          api.getThread(thread.id, { r: "1" }),
          api.getThread(thread.id, { r: "l3" }),
        ]);
        return [
          thread.id,
          {
            op: opPage.posts.find((post) => post.num === 1),
            latest: latestPage.posts.filter((post) => post.kind !== "kome"),
          },
        ] as const;
      }),
    ).then((results) => {
      if (!alive) return;
      const next = new Map<number, { op?: Post; latest: Post[] }>();
      for (const result of results) {
        if (result.status === "fulfilled") next.set(result.value[0], result.value[1]);
      }
      setPreviews(next);
    });
    return () => {
      alive = false;
    };
  }, [threadItems]);

  const board = boardInfo.data?.board;
  const designStyle = boardDesignStyle(board?.design);
  const banner = boardBanner(board?.design);
  const canManage = Boolean(boardInfo.data?.canManage);

  if (boardInfo.loading && !boardInfo.data) {
    return <Spinner label="板を読み込み中…" />;
  }
  if (boardInfo.error) {
    return (
      <Notice kind="error" onRetry={boardInfo.reload}>
        板「{slug}」を読み込めませんでした: {errorMessage(boardInfo.error)}
      </Notice>
    );
  }
  if (!board) {
    return <Notice kind="error">板が見つかりません。</Notice>;
  }

  const updateQuery = (next: Record<string, string | null>) => {
    const search = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value) search.delete(key);
      else search.set(key, value);
    }
    const text = search.toString();
    navigate(`${boardPath(slug)}${text ? `?${text}` : ""}`, { replace: true, keepScroll: true });
  };

  return (
    <div style={designStyle}>
      <div className="oc-sp-maintitle">{board.name}</div>
      <div className="oc-board-header">
        {banner ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={banner} alt={`${board.name} バナー`} style={{ maxHeight: 120, marginBottom: 6 }} />
        ) : null}
        <div className="oc-row-between">
          <h1 className="oc-board-title">
            {board.name}
            <small>＠おーぷんクローン</small>
          </h1>
          <div className="oc-row oc-small">
            <a href={`/headline?bbs=${encodeURIComponent(slug)}`}>ヘッドライン</a>
            <a href={`/ranking?bbs=${encodeURIComponent(slug)}`}>ランキング</a>
            <Link href="/settings">履歴</Link>
            <Link href="/settings">全般設定</Link>
            {canManage ? <Link href={`${boardPath(slug)}/manage`}>板管理</Link> : null}
          </div>
        </div>
        {board.description ? <p className="oc-board-desc">{board.description}</p> : null}
        <div className="oc-linkbar">
          <Link href="/">掲示板一覧</Link>
          <a href={`/search?bbs=${encodeURIComponent(slug)}`}>板内検索</a>
          <button type="button" className="oc-post-num" style={{ fontSize: 12 }} onClick={() => setRulesOpen((value) => !value)}>
            板ルール{rulesOpen ? "を閉じる" : "を見る"}
          </button>
          <span className="oc-spacer" />
          <span className="oc-muted oc-small">
            スレ {board.threadCount ?? threads.data?.items.length ?? 0} / レス {board.postCount ?? "-"}
          </span>
        </div>
        {rulesOpen ? (
          <div className="oc-panel" style={{ marginTop: 6 }}>
            <div className="oc-panel-title">板ルール</div>
            <div className="oc-panel-inner" style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
              {board.rulesMd?.trim() || "この板にはまだルールが設定されていません。"}
            </div>
          </div>
        ) : null}
        <form
          className="oc-row oc-mt oc-sp-search"
          onSubmit={(event) => {
            event.preventDefault();
            updateQuery({ q: searchDraft.trim() || null });
          }}
        >
          <input
            className="oc-input oc-input-sm"
            style={{ maxWidth: 260 }}
            placeholder="スレタイ検索"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            aria-label="板内スレタイ検索"
          />
          <Button size="sm" type="submit">
            検索
          </Button>
          {q ? (
            <Button
              size="sm"
              onClick={() => {
                setSearchDraft("");
                updateQuery({ q: null });
              }}
            >
              解除
            </Button>
          ) : null}
        </form>
        <PluginSlot slot="board-top" boardSlug={slug} />
      </div>

      <div className="oc-thread-sort">
        <span className="oc-muted">並び:</span>
        {SORTS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={sort === item.value ? "active" : undefined}
            onClick={() => updateQuery({ sort: item.value })}
          >
            {item.label}
          </button>
        ))}
        <span className="oc-spacer" />
      </div>

      <div className="oc-thread-list">
        {threads.loading && !threads.data ? <div className="oc-loading">スレ一覧を読み込み中…</div> : null}
        {threads.error ? (
          <div className="oc-panel-inner">
            <Notice kind="error" onRetry={threads.reload}>
              {errorMessage(threads.error)}
            </Notice>
          </div>
        ) : null}
        {threads.data && threads.data.items.length === 0 ? (
          <div className="oc-empty">スレがありません。最初のスレを立ててみましょう。</div>
        ) : null}
        {threads.data?.items.map((thread, index) => {
          const ngReason = matchNgThread(thread.title, settings.ng);
          if (ngReason && settings.ng.mode === "ignore") {
            return null;
          }
          if (ngReason && settings.ng.mode !== "confirm" && !revealed.has(thread.id)) {
            return (
              <div className="oc-ng-block" key={thread.id}>
                <span className="oc-ng-badge">NG</span>
                <span>
                  スレ「{thread.title}」は NG（{ngReason}）です
                </span>
                <button type="button" className="oc-btn oc-btn-sm" onClick={() => setRevealed((prev) => new Set(prev).add(thread.id))}>
                  表示
                </button>
              </div>
            );
          }
          return (
            <div
              className="oc-thread-row"
              key={thread.id}
              onTouchStart={(event) => {
                const point = event.touches[0];
                if (point) touch.current = { x: point.clientX, y: point.clientY, id: thread.id };
              }}
              onTouchEnd={(event) => {
                const start = touch.current;
                touch.current = null;
                const point = event.changedTouches[0];
                if (!start || !point || start.id !== thread.id) return;
                const dx = point.clientX - start.x;
                const dy = point.clientY - start.y;
                if (dx < -70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
                  event.preventDefault();
                  settingsStore.set((prev) => ({
                    ...prev,
                    ng: { ...prev.ng, threads: [...new Set([...prev.ng.threads, thread.title])] },
                  }));
                  toast.show("スレを NG（無視）に追加しました");
                }
              }}
            >
              <div className="oc-thread-title">
                <span className="oc-thread-rank">【{index + 1}:{thread.postCount}】</span>
                <Link href={`${threadPath(slug, thread.id)}?r=l50`}>{thread.title}</Link>
                <span className="oc-thread-count">({thread.postCount})</span>
                {ngReason ? <span className="oc-badge oc-badge-red">NG</span> : null}
                {thread.pinned ? <span className="oc-badge oc-badge-yellow">固定</span> : null}
                {thread.live ? <span className="oc-badge oc-badge-green">実況</span> : null}
              </div>
              {thread.excerpt ? <div className="oc-thread-excerpt">{thread.excerpt}</div> : null}
              {previews.get(thread.id)?.op ? (
                <div className="oc-thread-excerpt">
                  <span className="oc-preview-num">1 ：</span>
                  <span className="oc-preview-name">{previews.get(thread.id)?.op?.name || "名無しさん"}：</span>
                  {(() => {
                    const body = previews.get(thread.id)?.op?.body ?? "";
                    return body.length > 200 ? `${body.slice(0, 200)}…` : body;
                  })()}
                </div>
              ) : null}
              {(previews.get(thread.id)?.latest ?? []).length > 0 ? (
                <div className="oc-thread-preview">
                  {(previews.get(thread.id)?.latest ?? []).map((post) => (
                    <div key={post.id} className="oc-preview-post">
                      <span className="oc-preview-num">{post.num} ：</span>
                      <span className="oc-preview-name">{post.name || "名無しさん"}：</span>
                      <span className="oc-preview-body">
                        {post.body.length > 150 ? `${post.body.slice(0, 150)}…` : post.body}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="oc-thread-meta">
                <span>作成 {formatRelative(thread.createdAt)}</span>
                <span>最終 {formatRelative(thread.lastPostAt)}</span>
                {typeof thread.speed === "number" ? <span>勢い {thread.speed.toFixed(1)}</span> : null}
                <span className="oc-spacer" />
                <button
                  type="button"
                  className="oc-post-num"
                  style={{ fontSize: 11 }}
                  onClick={() => {
                    settingsStore.set((prev) => ({
                      ...prev,
                      ng: { ...prev.ng, threads: [...new Set([...prev.ng.threads, thread.title])] },
                    }));
                    toast.show("スレを NG（無視）に追加しました");
                  }}
                >
                  無視
                </button>
              </div>
              <div className="oc-thread-links">
                <Link href={`${threadPath(slug, thread.id)}?r=1-1000`}>全部</Link>
                <Link href={`${threadPath(slug, thread.id)}?r=l50`}>最新50</Link>
                <Link href={`${threadPath(slug, thread.id)}?r=l10`}>最新10</Link>
                <Link href={`${threadPath(slug, thread.id)}?r=1-100`}>1-100</Link>
                <Link href={`${threadPath(slug, thread.id)}?r=images`}>画像一覧</Link>
              </div>
            </div>
          );
        })}
      </div>

      <div className="oc-mt">
        <PostForm
          mode="thread"
          boardSlug={slug}
          boardId={Number(board.id) || undefined}
          turnstile={board.settings?.turnstile ?? "anonymous"}
          onPosted={({ threadId }) => {
            if (threadId) {
              toast.show("スレを立てました");
              navigate(`${threadPath(slug, threadId)}?r=l50`);
            }
          }}
        />
      </div>
    </div>
  );
}