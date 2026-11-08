"use client";

// スレ表示。レス範囲・安価・ID抽出・NG・画像/動画・いいね・実況・kome を統合する。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api, ApiError } from "@/features/board-ui/api";
import { AnchorPopup, type AnchorTarget } from "@/features/board-ui/anchor-popup";
import { formatRelative, threadPath, boardPath } from "@/features/board-ui/format";
import { getLastRead, isBookmarked, recordRead, setLastRead, toggleBookmark } from "@/features/board-ui/history";
import { KomeOverlay } from "@/features/board-ui/kome-overlay";
import { PostForm } from "@/features/board-ui/post-form";
import { PostRow } from "@/features/board-ui/post-row";
import { ReportModal } from "@/features/board-ui/report-modal";
import { addNgEntry, matchNg, playNewPostSound, settingsStore, speak } from "@/features/board-ui/settings";
import { useApiData, errorMessage } from "@/features/board-ui/use-api-data";
import { useThreadLive, type LiveStatus } from "@/features/board-ui/use-thread-live";
import { pageLinks, parseRange, rangeLabel, rangeQuery } from "@/features/board-ui/range";
import { quotePost } from "@/features/board-ui/quote-bus";
import type { AttachmentRef, Post } from "@/features/board-ui/types";
import { Button, Notice, Spinner, useToast } from "@/components/ui";
import { PluginSlot } from "@/components/plugin-slot";
import { PluginRenderStyles, usePluginPostRenderRules } from "@/features/plugin-host";
import { Link, navigate, useLocation } from "../router";

function statusLabel(status: LiveStatus): string {
  switch (status) {
    case "live":
      return "実況中";
    case "polling":
      return "ポーリング更新";
    case "connecting":
      return "接続中…";
    case "error":
      return "更新停止";
    default:
      return "更新OFF";
  }
}

export function ThreadView({ slug, threadId }: { slug: string; threadId: number }) {
  const location = useLocation();
  const params = useMemo(() => {
    const search = location.includes("?") ? location.slice(location.indexOf("?")) : "";
    return new URLSearchParams(search);
  }, [location]);
  const rParam = params.get("r") ?? "l50";
  const idFilter = params.get("id") ?? "";
  const qFilter = params.get("q") ?? "";

  const range = useMemo(() => parseRange(rParam), [rParam]);
  const settings = settingsStore.use();
  const toast = useToast();

  const page = useApiData(
    () =>
      api.getThread(threadId, {
        r: rangeQuery(range),
        images: range.kind === "images",
        id: idFilter || undefined,
        q: qFilter || undefined,
      }),
    [threadId, rParam, idFilter, qFilter],
  );

  const [posts, setPosts] = useState<Post[]>([]);
  const [kome, setKome] = useState<Post[]>([]);
  const boardInfo = useApiData(() => api.getBoard(slug), [slug]);
  const canManage = Boolean(boardInfo.data?.canManage);
  const renderRules = usePluginPostRenderRules({
    boardId: Number(boardInfo.data?.board.id) || undefined,
    boardSlug: slug,
    threadId,
  });
  const [live, setLive] = useState(false);
  const [viewers, setViewers] = useState<number | null>(null);
  const [komeOpen, setKomeOpen] = useState(settings.behavior.kome);
  const [anchor, setAnchor] = useState<AnchorTarget | null>(null);
  const [report, setReport] = useState<{ posts: string } | null>(null);
  const [searchDraft, setSearchDraft] = useState(qFilter);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [bookmarked, setBookmarked] = useState(false);
  const initialMaxId = useRef(0);
  const lastIdRef = useRef(0);
  const stickToBottom = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const loadedThreadId = useRef<number | null>(null);

  const thread = page.data?.thread;
  const threadKey = `t:${threadId}`;

  useEffect(() => {
    if (!page.data) return;
    const own = page.data.posts.filter((post) => post.kind !== "kome");
    setPosts(own);
    setKome(page.data.posts.filter((post) => post.kind === "kome"));
    const maxId = own.reduce((max, post) => Math.max(max, post.id), 0);
    if (loadedThreadId.current !== threadId) {
      loadedThreadId.current = threadId;
      initialMaxId.current = maxId;
      lastIdRef.current = maxId;
      stickToBottom.current = true;
      setNewIds(new Set());
    } else {
      lastIdRef.current = Math.max(lastIdRef.current, maxId);
    }
    if (page.data.thread.live) {
      setLive(true);
    }
  }, [page.data, threadId]);

  useEffect(() => {
    setBookmarked(isBookmarked(threadKey));
  }, [threadKey]);

  useEffect(() => {
    if (!thread) return;
    document.title = `${thread.title} ｜ ${thread.boardName ?? slug} ｜ おーぷんクローン`;
    recordRead({
      key: threadKey,
      path: threadPath(slug, threadId),
      slug,
      threadId,
      title: thread.title,
      boardName: thread.boardName,
    });
    const last = posts[posts.length - 1];
    if (last) {
      setLastRead(threadKey, last.num);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.title, thread?.boardName]);

  const postsByNum = useMemo(() => {
    const map = new Map<number, Post>();
    for (const post of posts) {
      map.set(post.num, post);
    }
    return map;
  }, [posts]);

  const appendPost = useCallback(
    (post: Post) => {
      if (post.kind === "kome") {
        setKome((prev) => [...prev, post]);
        return;
      }
      setPosts((prev) => {
        if (prev.some((item) => item.id === post.id || item.num === post.num)) {
          return prev;
        }
        return [...prev, post];
      });
      lastIdRef.current = Math.max(lastIdRef.current, post.id);
      if (post.id > initialMaxId.current) {
        setNewIds((prev) => new Set(prev).add(post.num));
      }
      if (settings.behavior.sound) playNewPostSound();
      if (settings.behavior.readAloud) speak(`${post.name}。${post.body}`);
      if (live && settings.behavior.autoScroll && stickToBottom.current) {
        window.requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
      }
    },
    [live, settings.behavior.autoScroll, settings.behavior.readAloud, settings.behavior.sound],
  );

  const liveState = useThreadLive({
    threadId,
    enabled: live,
    getLastPostId: () => lastIdRef.current,
    onPost: appendPost,
    onKome: (post) => setKome((prev) => [...prev, post]),
    onInvalidate: page.reload,
  });

  // open2ch の閲覧人数ボックス。実況接続中だけ RealtimeHub の接続数を表示する。
  useEffect(() => {
    if (!live) {
      setViewers(null);
      return;
    }
    let alive = true;
    const load = () => {
      api
        .rtStats(`thread:${threadId}`)
        .then((data) => {
          if (alive) setViewers(data.connections);
        })
        .catch(() => {
          /* 表示は任意機能 */
        });
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [live, threadId]);

  const applyQuery = (next: Record<string, string | null>, replace = true) => {
    const search = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") {
        search.delete(key);
      } else {
        search.set(key, value);
      }
    }
    const text = search.toString();
    navigate(`${threadPath(slug, threadId)}${text ? `?${text}` : ""}`, { replace, keepScroll: true });
  };

  const onAnchor = (spec: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setAnchor({ spec, x: rect.left, y: rect.bottom });
  };

  const onQuote = (num: number) => {
    quotePost(num);
    setAnchor(null);
    document.getElementById("post-form-anchor")?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  const onLike = async (post: Post) => {
    const previous = { count: post.likeCount ?? 0, liked: Boolean(post.liked) };
    setPosts((prev) =>
      prev.map((item) =>
        item.id === post.id
          ? { ...item, liked: !previous.liked, likeCount: previous.count + (previous.liked ? -1 : 1) }
          : item,
      ),
    );
    try {
      const result = await api.likePost(post.id);
      setPosts((prev) =>
        prev.map((item) => (item.id === post.id ? { ...item, liked: result.liked, likeCount: result.count } : item)),
      );
    } catch {
      setPosts((prev) =>
        prev.map((item) => (item.id === post.id ? { ...item, liked: previous.liked, likeCount: previous.count } : item)),
      );
      toast.show("いいねに失敗しました");
    }
  };

  const onNgId = (idHash: string) => {
    if (!idHash) return;
    addNgEntry("ids", idHash);
    toast.show(`ID:${idHash} を NG に追加しました`);
  };

  const onDelete = async (post: Post, mode: "hide" | "delete") => {
    const label = mode === "hide" ? "非表示" : "削除";
    if (!window.confirm(`レス ${post.num} を${label}しますか？`)) return;
    try {
      if (mode === "hide") {
        await api.hidePost(post.id);
        setPosts((prev) => prev.filter((item) => item.id !== post.id));
      } else {
        await api.deletePost(post.id);
        setPosts((prev) => prev.filter((item) => item.id !== post.id));
      }
      toast.show(`${label}しました`);
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : `${label}に失敗しました`);
    }
  };

  const jumpTo = (num: number) => {
    const element = document.getElementById(`p${num}`);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      element.classList.add("oc-post-target");
      window.setTimeout(() => element.classList.remove("oc-post-target"), 1700);
      return;
    }
    applyQuery({ r: String(num) }, false);
  };

  const onScroll = () => {
    if (typeof window === "undefined") return;
    const distance = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    stickToBottom.current = distance < 140;
  };

  useEffect(() => {
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const last = posts[posts.length - 1];
    if (last) setLastRead(threadKey, last.num);
  }, [posts, threadKey]);

  if (page.loading && !page.data) {
    return <Spinner label="スレを読み込み中…" />;
  }
  if (page.error) {
    const notFound = page.error instanceof ApiError && page.error.status === 404;
    return (
      <div className="oc-stack">
        <Notice kind="error" onRetry={page.reload}>
          {notFound ? "スレが見つかりません（削除された可能性があります）。" : errorMessage(page.error)}
        </Notice>
        <Link href={boardPath(slug)}>板に戻る</Link>
      </div>
    );
  }
  if (!thread) {
    return <Notice kind="error">スレ情報を取得できませんでした。</Notice>;
  }

  const total = Math.max(thread.postCount, posts[posts.length - 1]?.num ?? 0);
  const maxPosts = thread.maxPosts ?? 1000;
  const canPost = total < maxPosts;
  const lastRead = getLastRead(threadKey);
  const imagesOnly = range.kind === "images";
  const ordered = settings.display.reverse ? [...posts].reverse() : posts;
  const images: AttachmentRef[] = posts.flatMap((post) => post.attachments ?? []);

  const fontStyle = { "--oc-post-font-size": `${settings.display.fontSize}px` } as CSSProperties;

  return (
    <div style={fontStyle}>
      <PluginRenderStyles />
      {live && viewers !== null ? (
        <div className="oc-viewers" title="実況の同時接続数">
          👤 {viewers}人
        </div>
      ) : null}
      <div className="oc-thread-toolbar">
        <div className="oc-tool-group oc-tool-links">
          <Link href={boardPath(slug)}>板に戻る</Link>
          <Link href={`${threadPath(slug, threadId)}?r=1-1000`}>全部</Link>
          <Link href={`${threadPath(slug, threadId)}?r=l50`}>最新50</Link>
          <Link href={`${threadPath(slug, threadId)}?r=l10`}>最新10</Link>
          <Link href={`${threadPath(slug, threadId)}?r=1-100`}>1-100</Link>
          {(() => {
            const pages = pageLinks(total, range);
            const currentIndex = pages.findIndex((page) => page.label.startsWith("["));
            const prev = currentIndex > 0 ? pages[currentIndex - 1] : null;
            const next = currentIndex >= 0 && currentIndex < pages.length - 1 ? pages[currentIndex + 1] : null;
            return (
              <>
                {prev ? <Link href={`${threadPath(slug, threadId)}?r=${prev.r}`}>前</Link> : <span className="oc-muted">前</span>}
                {next ? <Link href={`${threadPath(slug, threadId)}?r=${next.r}`}>次</Link> : <span className="oc-muted">次</span>}
                {pages.map((page) => (
                  <Link key={page.r} href={`${threadPath(slug, threadId)}?r=${page.r}`}>
                    {page.label}
                  </Link>
                ))}
              </>
            );
          })()}
        </div>
        <span className="oc-spacer" />
        <div className="oc-tool-group">
          <button
            type="button"
            className={`oc-icon-btn${live ? " on" : ""}`}
            onClick={() => setLive((value) => !value)}
            title={live ? "実況を停止します" : "新着を自動取得して追尾します"}
            aria-pressed={live}
          >
            ⚡ 実況
          </button>
          <span className={`oc-live-badge${live ? (liveState.status === "live" ? " oc-live-on" : " oc-live-polling") : ""}`}>
            <span className="oc-live-dot" />
            {statusLabel(liveState.status)}
          </span>
          <button
            type="button"
            className={`oc-icon-btn${komeOpen || settings.behavior.kome ? " on" : ""}`}
            onClick={() => setKomeOpen((value) => !value)}
          >
            💬 kome
          </button>
          <button
            type="button"
            className={`oc-icon-btn${bookmarked ? " on" : ""}`}
            onClick={() => {
              const added = toggleBookmark({
                key: threadKey,
                path: threadPath(slug, threadId),
                slug,
                threadId,
                title: thread.title,
                boardName: thread.boardName,
              });
              setBookmarked(added);
              toast.show(added ? "ブクマに追加しました" : "ブクマを解除しました");
            }}
          >
            {bookmarked ? "★" : "☆"} ブクマ
          </button>
          <Link href="/settings">設定</Link>
        </div>
      </div>

      <nav className="oc-sp-threadnav" aria-label="スレ内ナビ">
        <Link href={`${threadPath(slug, threadId)}?r=1-1000`}>全部</Link>
        <Link href={`${threadPath(slug, threadId)}?r=1-100`}>1から</Link>
        <Link href={`${threadPath(slug, threadId)}?r=l30`}>最新30</Link>
        <Link href={`${threadPath(slug, threadId)}?r=images`}>画像一覧</Link>
      </nav>

      <div className="oc-sp-maintitle">
        <Link href={boardPath(slug)}>{thread.boardName ?? slug} 板</Link>
      </div>

      <div className="oc-thread-head">
        <h1>
          {thread.title} <span className="oc-thread-count">({total})</span>
        </h1>
        <div className="oc-thread-sub">
          <Link href={boardPath(slug)}>{thread.boardName ?? slug} 板</Link>
          {thread.live ? <span className="oc-badge oc-badge-green">実況スレ</span> : null}
          {!canPost ? <span className="oc-badge oc-badge-red">レス上限（{maxPosts}）</span> : null}
          {lastRead > 0 ? <span>前回: {lastRead} まで既読</span> : null}
          <span className="oc-spacer" />
          <span>{rangeLabel(range)} 表示</span>
        </div>
        {idFilter ? (
          <div className="oc-row oc-mt">
            <span className="oc-badge oc-badge-yellow">ID 抽出: {idFilter}</span>
            <Button size="sm" onClick={() => applyQuery({ id: null })}>
              解除
            </Button>
          </div>
        ) : null}
        {qFilter ? (
          <div className="oc-row oc-mt">
            <span className="oc-badge oc-badge-yellow">スレ内検索: {qFilter}</span>
            <Button size="sm" onClick={() => applyQuery({ q: null })}>
              解除
            </Button>
          </div>
        ) : null}
        <form
          className="oc-row oc-mt"
          onSubmit={(event) => {
            event.preventDefault();
            applyQuery({ q: searchDraft.trim() || null });
          }}
        >
          <input
            className="oc-input oc-input-sm"
            style={{ width: 180 }}
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="スレ内検索"
            aria-label="スレ内検索"
          />
          <Button size="sm" type="submit">
            検索
          </Button>
        </form>
        <PluginSlot slot="thread-top" boardSlug={slug} threadId={threadId} />
      </div>

      <div className="oc-range-nav">
        {pageLinks(total, range).map((link) => (
          <Link key={link.r} href={`${threadPath(slug, threadId)}?r=${link.r}`} className={link.r === rangeQuery(range) ? "active" : undefined}>
            {link.label}
          </Link>
        ))}
        <Link href={`${threadPath(slug, threadId)}?r=images`} className={imagesOnly ? "active" : undefined}>
          画像一覧
        </Link>
        <span className="oc-spacer" />
        <span className="oc-muted">
          最終 {formatRelative(thread.lastPostAt ?? thread.createdAt)} / 作成 {formatRelative(thread.createdAt)}
        </span>
      </div>

      {imagesOnly ? (
        <div className="oc-panel">
          <div className="oc-panel-title">画像一覧（{images.length}）</div>
          <div className="oc-panel-inner">
            {images.length === 0 ? (
              <div className="oc-empty">この範囲に画像はありません。</div>
            ) : (
              <div className="oc-attachments">
                {images.map((image, index) => (
                  <a
                    key={`${image.url}-${index}`}
                    className="oc-attachment"
                    href={image.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.url} alt={image.name ?? "画像"} loading="lazy" referrerPolicy="no-referrer" />
                  </a>
                ))}
              </div>
            )}
            <div className="oc-mt">
              <Link href={`${threadPath(slug, threadId)}?r=l50`}>レス表示に戻る</Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="oc-panel">
          <div className="oc-panel-title">
            <span>レス一覧</span>
            {page.data?.hasMore ? <span className="oc-muted oc-small">（続きあり）</span> : null}
            <span className="oc-spacer" />
            <button
              type="button"
              className={`oc-icon-btn${settings.display.reverse ? " on" : ""}`}
              onClick={() => settingsStore.update({ display: { ...settings.display, reverse: !settings.display.reverse } })}
            >
              逆順
            </button>
            <button
              type="button"
              className={`oc-icon-btn${settings.behavior.autoScroll ? " on" : ""}`}
              onClick={() =>
                settingsStore.update({ behavior: { ...settings.behavior, autoScroll: !settings.behavior.autoScroll } })
              }
            >
              自動追尾
            </button>
          </div>
          <div className="oc-panel-inner oc-posts">
            {ordered.length === 0 ? <div className="oc-empty">表示できるレスがありません。</div> : null}
            {ordered.map((post) => {
              const verdict = matchNg(post, settings.ng);
              if (verdict.hit) {
                if (settings.ng.mode === "ignore") {
                  return null;
                }
                if (settings.ng.mode === "hide" && !revealed.has(post.id)) {
                  return (
                    <div className="oc-ng-block" key={`ng-${post.id}`}>
                      <span className="oc-ng-badge">NG</span>
                      <span>
                        レス {post.num} を NG（{verdict.reason}）により非表示にしました
                      </span>
                      <button
                        type="button"
                        className="oc-btn oc-btn-sm"
                        onClick={() => setRevealed((prev) => new Set(prev).add(post.id))}
                      >
                        表示
                      </button>
                    </div>
                  );
                }
              }
              return (
                <div key={post.id} className={verdict.hit ? "oc-ng-confirm" : undefined}>
                  {verdict.hit ? (
                    <div className="oc-ng-block">
                      <span className="oc-ng-badge">NG</span> {verdict.reason} に一致（確認モード）
                    </div>
                  ) : null}
                  <PostRow
                    post={post}
                    showImages={settings.display.showImages}
                    aa={settings.display.aa}
                    canManage={canManage}
                    highlight={false}
                    isNew={newIds.has(post.num)}
                    onQuote={onQuote}
                    onAnchor={onAnchor}
                    onLike={onLike}
                    onNgId={onNgId}
                    onFilterId={(idHash) => applyQuery({ r: null, id: idHash })}
                    onReport={(target) => setReport({ posts: String(target.num) })}
                    onDelete={onDelete}
                    onJump={jumpTo}
                    renderRules={renderRules}
                  />
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
          <div className="oc-panel-title oc-mt">
            <span className="oc-muted oc-small">
              {thread.boardName ?? slug} 板 / レス {total} / {canPost ? "投稿できます" : "レス上限に達しました"}
            </span>
            <span className="oc-spacer" />
            <button type="button" className="oc-btn oc-btn-sm" onClick={() => applyQuery({ r: "l50" })}>
              最新50へ
            </button>
            <button type="button" className="oc-btn oc-btn-sm" onClick={() => applyQuery({ r: "1-1000" })}>
              全部表示
            </button>
          </div>
        </div>
      )}

      <div id="post-form-anchor" />
      <PluginSlot slot="thread-bottom" boardSlug={slug} threadId={threadId} />

      {canPost ? (
        <PostForm
          mode="post"
          boardSlug={slug}
          boardId={Number(boardInfo.data?.board.id) || undefined}
          turnstile={boardInfo.data?.board.settings?.turnstile ?? "anonymous"}
          threadId={threadId}
          threadTitle={thread.title}
          onPosted={({ post }) => {
            if (post) {
              appendPost(post);
              toast.show("投稿しました");
            } else {
              page.reload();
              toast.show("投稿しました");
            }
          }}
          onOpenKome={() => setKomeOpen(true)}
        />
      ) : (
        <div className="oc-panel">
          <div className="oc-panel-title">このスレは上限（{maxPosts}レス）に達しました</div>
          <div className="oc-panel-inner">
            新しいスレを立てて続けてください。<Link href={boardPath(slug)}>板に戻ってスレを立てる</Link>
          </div>
        </div>
      )}

      <AnchorPopup
        target={anchor}
        postsByNum={postsByNum}
        threadId={threadId}
        onClose={() => setAnchor(null)}
        onQuote={(num) => {
          onQuote(num);
        }}
      />

      <ReportModal
        open={report !== null}
        onClose={() => setReport(null)}
        boardSlug={slug}
        threadId={threadId}
        defaultPosts={report?.posts ?? "all"}
      />

      <KomeOverlay
        threadId={threadId}
        open={komeOpen}
        onClose={() => setKomeOpen(false)}
        comments={kome}
        initialLoaded={Boolean(page.data)}
        onSent={(post) => {
          if (post) setKome((prev) => [...prev, post]);
        }}
        enabled={canPost}
        turnstile={boardInfo.data?.board.settings?.turnstile ?? "anonymous"}
      />
    </div>
  );
}