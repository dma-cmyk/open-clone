"use client";

// スレ表示。レス範囲・安価・ID抽出・NG・画像/動画・いいね・実況・つぶやきを統合する。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api, ApiError } from "@/features/board-ui/api";
import { AnchorPopup, type AnchorTarget } from "@/features/board-ui/anchor-popup";
import { formatDate, formatRelative, referencedNums, threadPath, boardPath } from "@/features/board-ui/format";
import { getLastRead, isBookmarked, recordRead, setLastRead, toggleBookmark } from "@/features/board-ui/history";
import { PostForm } from "@/features/board-ui/post-form";
import { PostRow } from "@/features/board-ui/post-row";
import { TsubuyakiOverlay } from "@/features/board-ui/tsubuyaki-overlay";
import { ReportModal } from "@/features/board-ui/report-modal";
import { addNgEntry, matchNg, playNewPostSound, settingsStore, speak } from "@/features/board-ui/settings";
import { useApiData, errorMessage } from "@/features/board-ui/use-api-data";
import { useThreadLive, type LiveStatus } from "@/features/board-ui/use-thread-live";
import { pageLinks, parseRange, rangeLabel, rangeQuery } from "@/features/board-ui/range";
import { quotePost } from "@/features/board-ui/quote-bus";
import { TurnstileWidget, useTurnstileToken } from "@/features/board-ui/turnstile";
import { setTurnstilePass, useTurnstilePass } from "@/features/board-ui/turnstile-pass-store";
import type { AttachmentRef, Post, PostEditHistoryItem, ThreadQuoteRef } from "@/features/board-ui/types";
import { Button, Modal, Notice, Spinner, useToast } from "@/components/ui";
import { usePageTitle } from "@/lib/title";
import { PluginSlot } from "@/components/plugin-slot";
import { PluginRenderStyles, usePluginPostRenderRules } from "@/features/plugin-host";
import { resetThreadRenderBudget } from "@/features/plugin-host/render-worker-client";
import { Link, navigate, useLocation } from "../router";

const POST_REMOVAL_DONE_MESSAGES: Record<"hide" | "delete", string> = {
  hide: "非表示にしました",
  delete: "削除しました",
};

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

  // スレ全体の規則適用予算はスレごとにリセットする（描画前に実行）。
  const budgetThreadRef = useRef<number | null>(null);
  if (budgetThreadRef.current !== threadId) {
    budgetThreadRef.current = threadId;
    resetThreadRenderBudget();
  }

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
  const [tsubuyakiComments, setTsubuyakiComments] = useState<Post[]>([]);
  const boardInfo = useApiData(() => api.getBoard(slug), [slug]);
  const canManage = Boolean(boardInfo.data?.canManage);
  // 板設定（本人編集・本人削除・引用スレの許可）。ボタン表示は補助で、最終判定は API 側。
  const boardSettings = boardInfo.data?.board.settings;
  const allowQuoteThread = boardSettings?.allowQuoteThread !== false;
  // 編集の Bot 確認（レスと同じ扱い・設計 80）: 板ごとの「確認済み」状態を共有し、
  // 未確認なら編集モーダルに Turnstile 部品を出してトークンを送る。
  const editTurnstilePolicy = boardSettings?.turnstile ?? "anonymous";
  const editPass = useTurnstilePass(slug);
  const editTurnstilePassed = editTurnstilePolicy === "anonymous" && editPass.passed;
  const editTurnstileToken = useTurnstileToken(editTurnstilePolicy, editTurnstilePassed);
  // スレ主かどうかは >>1 の mine フラグで判定（API が端末・アカウント一致を計算する）。
  const isThreadOwner = useMemo(() => posts.some((post) => post.num === 1 && post.mine === true), [posts]);
  const renderRules = usePluginPostRenderRules({
    boardId: Number(boardInfo.data?.board.id) || undefined,
    boardSlug: slug,
    threadId,
  });
  const [live, setLive] = useState(false);
  const [viewers, setViewers] = useState<number | null>(null);
  const [tsubuyakiOpen, setTsubuyakiOpen] = useState(settings.behavior.tsubuyaki);
  const [anchor, setAnchor] = useState<AnchorTarget | null>(null);
  const [report, setReport] = useState<{ posts: string } | null>(null);
  const [searchDraft, setSearchDraft] = useState(qFilter);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [bookmarked, setBookmarked] = useState(false);
  // 本人編集・本人削除・履歴・引用スレの UI 状態。
  const [editTarget, setEditTarget] = useState<Post | null>(null);
  const [editBody, setEditBody] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [historyTarget, setHistoryTarget] = useState<Post | null>(null);
  const [historyItems, setHistoryItems] = useState<PostEditHistoryItem[] | null>(null);
  const [threadEditOpen, setThreadEditOpen] = useState(false);
  const [threadEditTitle, setThreadEditTitle] = useState("");
  const [threadEditBody, setThreadEditBody] = useState("");
  const [quotesOpen, setQuotesOpen] = useState(false);
  const [quoteRefs, setQuoteRefs] = useState<ThreadQuoteRef[] | null>(null);
  const initialMaxId = useRef(0);
  const lastIdRef = useRef(0);
  const stickToBottom = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const loadedThreadId = useRef<number | null>(null);

  const thread = page.data?.thread;
  const threadKey = `t:${threadId}`;

  // スレ全体の最終投稿時刻（秒）。サーバー応答の `thread.lastPostAt` を基準にし、
  // 受信した新着がより新しいときだけ進める。表示範囲（?r=）・スレ内検索・ID 抽出で
  // 絞られた `posts` の末尾から逆算しない（古い 1 件だけを見ると「1時間前」へ
  // 巻き戻るため: R2）。
  // スレ ID も一緒に持つ: SPA で別スレへ移ると ThreadView は同じコンポーネントのまま
  // props だけ変わるので、前スレの値を新スレの初期値にしない（R2b）。
  const [lastPostAt, setLastPostAt] = useState<{ threadId: number; at: number } | null>(null);

  useEffect(() => {
    if (!page.data) return;
    // 取得中は前スレのデータが残る。別スレの応答を今のスレの値として取り込まない。
    if (page.data.thread.id !== threadId) return;
    const own = page.data.posts.filter((post) => post.kind !== "tsubuyaki");
    setPosts(own);
    const serverLast = page.data.thread.lastPostAt ?? page.data.thread.createdAt ?? 0;
    setLastPostAt((prev) =>
      prev && prev.threadId === threadId
        ? { threadId, at: Math.max(prev.at, serverLast) }
        : { threadId, at: serverLast },
    );
    setTsubuyakiComments(page.data.posts.filter((post) => post.kind === "tsubuyaki"));
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

  // URL の q（適用中の検索語）と入力欄を一致させる。解除・戻る/進む・別リンクで
  // 入力欄だけ古い語が残らないようにする（F-10）。
  useEffect(() => {
    setSearchDraft(qFilter);
  }, [qFilter]);

  // タブ名。スレを離れたら AppShell の RouteTitle が板名・設定などへ戻す（F-12）。
  usePageTitle(thread ? `${thread.title} ｜ ${thread.boardName ?? slug}` : null);

  useEffect(() => {
    if (!thread) return;
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

  // 安価（被参照表示）。サーバーが返した backlinks に、今画面にあるレスの本文を足し合わせる。
  // 実況・自分の投稿で届いたレスは backlinks が未計算のため、そのままだと「安価 2」が
  // 再読み込みするまで出ない（F-09）。引用元レス番号はクライアント側で分かるのでここで補う。
  const postsWithBacklinks = useMemo(() => {
    const extra = new Map<number, Set<number>>();
    for (const post of posts) {
      for (const target of referencedNums(post.body)) {
        if (target === post.num) continue;
        const set = extra.get(target) ?? new Set<number>();
        set.add(post.num);
        extra.set(target, set);
      }
    }
    if (extra.size === 0) return posts;
    return posts.map((post) => {
      const added = extra.get(post.num);
      if (!added) return post;
      const merged = [...new Set([...(post.backlinks ?? []), ...added])].sort((a, b) => a - b);
      return merged.length === (post.backlinks?.length ?? 0) ? post : { ...post, backlinks: merged };
    });
  }, [posts]);

  // 「最終◯分前」は相対表示なので、新しいレスが届いたら時刻側も更新し、さらに一定ごとに
  // 数え直す（放置すると「14分前」がずっと残る: F-09）。
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const appendPost = useCallback(
    (post: Post) => {
      if (post.kind === "tsubuyaki") {
        setTsubuyakiComments((prev) => [...prev, post]);
        return;
      }
      setPosts((prev) => {
        if (prev.some((item) => item.id === post.id || item.num === post.num)) {
          return prev;
        }
        return [...prev, post];
      });
      lastIdRef.current = Math.max(lastIdRef.current, post.id);
      setLastPostAt((prev) =>
        prev && prev.threadId === threadId
          ? { threadId, at: Math.max(prev.at, post.createdAt) }
          : { threadId, at: post.createdAt },
      );
      if (post.id > initialMaxId.current) {
        setNewIds((prev) => new Set(prev).add(post.num));
      }
      if (settings.behavior.sound) playNewPostSound();
      if (settings.behavior.readAloud) speak(`${post.name}。${post.body}`);
      if (live && settings.behavior.autoScroll && stickToBottom.current) {
        window.requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
      }
    },
    [threadId, live, settings.behavior.autoScroll, settings.behavior.readAloud, settings.behavior.sound],
  );

  const liveState = useThreadLive({
    threadId,
    enabled: live,
    getLastPostId: () => lastIdRef.current,
    onPost: appendPost,
    onTsubuyaki: (post) => setTsubuyakiComments((prev) => [...prev, post]),
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
      toast.show(POST_REMOVAL_DONE_MESSAGES[mode]);
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : `${label}に失敗しました`);
    }
  };

  // ---- 本人編集・本人削除・履歴・引用スレ ----

  const onSelfEdit = (post: Post) => {
    setEditTarget(post);
    setEditBody(post.body);
    setEditError(null);
  };

  const submitSelfEdit = async () => {
    if (!editTarget || editBody.trim().length === 0) {
      setEditError("本文を入力してください");
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      // Bot 確認が必要な板ではトークンを添える（レス投稿と同じ条件。確認済みなら take は省略扱い）。
      const token = await editTurnstileToken.take();
      const updated = await api.editPost(editTarget.id, editBody, token || undefined);
      // 成功した＝確認済みが記録された（または省略された）。サーバーから実際の状態と期限を
      // 取り直す（expiresAt: null の代用は期限タイマーが動かず、期限切れ後に抜けられなくなる。R74-04）。
      if (editTurnstilePolicy === "anonymous") {
        void api
          .getTurnstileStatus(slug)
          .then((status) => {
            setTurnstilePass(slug, { passed: status.passed, expiresAt: status.passExpiresAt });
          })
          .catch(() => undefined);
      }
      setPosts((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated, mine: true } : item)));
      setEditTarget(null);
      setEditBody("");
      toast.show("編集しました");
    } catch (cause) {
      // 確認失敗（400 TURNSTILE_FAILED）・取消しに当たったらローカルの省略状態を捨てて部品を戻す
      //（サーバーの状態を取り直すより確実。期限切れ・取消しの両方に効く。R74-04）。
      if (cause instanceof ApiError && (cause.status === 400 || cause.status === 429 || cause.status === 403)) {
        setTurnstilePass(slug, { passed: false, expiresAt: null });
      }
      // NG など他の失敗でもサーバー側は取消している可能性があるため状態を取り直す（R74-03）。
      if (editTurnstilePolicy === "anonymous" && cause instanceof ApiError && cause.status === 400) {
        void api
          .getTurnstileStatus(slug)
          .then((status) => {
            setTurnstilePass(slug, { passed: status.passed, expiresAt: status.passExpiresAt });
          })
          .catch(() => undefined);
      }
      setEditError(cause instanceof Error ? cause.message : "編集に失敗しました");
    } finally {
      setEditSaving(false);
    }
  };

  const onSelfDelete = async (post: Post) => {
    if (!window.confirm(`レス ${post.num} を削除しますか？（「投稿者により削除されました」と残ります）`)) return;
    try {
      await api.deletePostSelf(post.id);
      // レス番号は残る（アンカーを壊さない）。本文表示だけが変わる。
      setPosts((prev) =>
        prev.map((item) => (item.id === post.id ? { ...item, selfDeleted: true, body: "投稿者により削除されました", attachments: [] } : item)),
      );
      toast.show("削除しました");
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : "削除に失敗しました");
    }
  };

  const onHistory = async (post: Post) => {
    setHistoryTarget(post);
    setHistoryItems(null);
    try {
      setHistoryItems(await api.getPostHistory(post.id));
    } catch {
      setHistoryItems([]);
    }
  };

  const openThreadEdit = () => {
    if (!thread) return;
    setThreadEditTitle(thread.title);
    setThreadEditBody(posts.find((post) => post.num === 1)?.body ?? "");
    setThreadEditOpen(true);
    setEditError(null);
  };

  const submitThreadEdit = async () => {
    if (!thread) return;
    if (threadEditTitle.trim().length === 0 || threadEditBody.trim().length === 0) {
      setEditError("スレタイと本文を入力してください");
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      // Bot 確認が必要な板ではトークンを添える（レス編集と同じ条件）。
      const token = await editTurnstileToken.take();
      await api.editThread(thread.id, threadEditTitle, threadEditBody, token || undefined);
      // 成功した＝確認済みが記録された（または省略された）。実際の期限をサーバーから取り直す（R74-04）。
      if (editTurnstilePolicy === "anonymous") {
        void api
          .getTurnstileStatus(slug)
          .then((status) => {
            setTurnstilePass(slug, { passed: status.passed, expiresAt: status.passExpiresAt });
          })
          .catch(() => undefined);
      }
      setThreadEditOpen(false);
      page.reload();
      toast.show("スレを編集しました");
    } catch (cause) {
      // 確認失敗・取消し・期限切れでローカルの省略状態を捨てて部品を戻す（R74-04）。
      if (cause instanceof ApiError && (cause.status === 400 || cause.status === 429 || cause.status === 403)) {
        setTurnstilePass(slug, { passed: false, expiresAt: null });
      }
      // NG でもサーバー側は取消している可能性があるため状態を取り直す（R74-03）。
      if (editTurnstilePolicy === "anonymous" && cause instanceof ApiError && cause.status === 400) {
        void api
          .getTurnstileStatus(slug)
          .then((status) => {
            setTurnstilePass(slug, { passed: status.passed, expiresAt: status.passExpiresAt });
          })
          .catch(() => undefined);
      }
      setEditError(cause instanceof Error ? cause.message : "編集に失敗しました");
    } finally {
      setEditSaving(false);
    }
  };

  const deleteThreadSelf = async () => {
    if (!thread) return;
    if (!window.confirm("スレを削除しますか？（他人のレスがある場合は削除できません）")) return;
    try {
      await api.deleteThread(thread.id);
      toast.show("スレを削除しました");
      navigate(boardPath(slug));
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : "スレの削除に失敗しました");
    }
  };

  const openQuotes = async () => {
    setQuotesOpen(true);
    if (quoteRefs === null) {
      try {
        setQuoteRefs(await api.getThreadQuotes(threadId));
      } catch {
        setQuoteRefs([]);
      }
    }
  };

  /** このスレを引用して新しいスレを立てる（引用先の板で許可されている場合）。 */
  const quoteThisThread = () => {
    navigate(`/b/${encodeURIComponent(slug)}/?quote=${threadId}`);
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
  const ordered = settings.display.reverse ? [...postsWithBacklinks].reverse() : postsWithBacklinks;
  const images: AttachmentRef[] = posts.flatMap((post) => post.attachments ?? []);
  // 「最終◯分前」は画面にある最後のレスの時刻を使う（受信直後に古いままだと F-09 になる）。

  const fontStyle = { "--oc-post-font-size": `${settings.display.fontSize}px` } as CSSProperties;

  return (
    <div style={fontStyle}>
      <PluginRenderStyles />
      {live && viewers !== null ? (
        <div className="oc-viewers" title="実況の同時接続数">
          👤 {viewers}人
        </div>
      ) : null}
      <div className="oc-thread-toolbar" data-tour="thread-tools">
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
            className={`oc-icon-btn${tsubuyakiOpen || settings.behavior.tsubuyaki ? " on" : ""}`}
            onClick={() => setTsubuyakiOpen((value) => !value)}
          >
            💬 つぶやき
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

      <div className="oc-thread-head" data-tour="thread-head">
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

        {page.data?.quoteSource ? (
          <div className="oc-quote-card" data-quote-source={page.data.quoteSource.threadId}>
            <div className="oc-quote-card-head">
              <span className="oc-quote-card-label">引用元</span>
              {page.data.quoteSource.unavailable ? (
                <span className="oc-muted">
                  {page.data.quoteSource.boardName ? `${page.data.quoteSource.boardName} 板 / ` : ""}
                  {page.data.quoteSource.title}
                </span>
              ) : (
                <Link href={`/b/${page.data.quoteSource.boardSlug}/t/${page.data.quoteSource.threadId}`}>
                  {page.data.quoteSource.boardName} 板 / {page.data.quoteSource.title} ({page.data.quoteSource.postCount})
                </Link>
              )}
            </div>
          </div>
        ) : null}

        <div className="oc-row oc-mt oc-thread-owner-actions">
          {(boardSettings?.selfEditWindowMinutes ?? 0) === 0 ||
          thread.createdAt === undefined ||
          thread.createdAt + (boardSettings?.selfEditWindowMinutes ?? 0) * 60 > Date.now() / 1000 ? (
            isThreadOwner ? (
              <Button size="sm" onClick={openThreadEdit} title="スレ主としてタイトルと>>1を編集">
                ✏ スレを編集
              </Button>
            ) : null
          ) : null}
          {isThreadOwner ? (
            <Button size="sm" onClick={deleteThreadSelf} title="スレ主としてスレを削除（他人のレスがある場合は不可）">
              🗑 スレを削除
            </Button>
          ) : null}
          {allowQuoteThread ? (
            <Button size="sm" onClick={quoteThisThread} title="このスレを引用して新しいスレを立てる">
              ↗ 引用して新スレ
            </Button>
          ) : null}
          <Button size="sm" onClick={openQuotes} title="このスレを引用したスレの一覧">
            🔗 引用したスレ
          </Button>
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
            <Button
              size="sm"
              onClick={() => {
                setSearchDraft("");
                applyQuery({ q: null });
              }}
            >
              解除
            </Button>
          </div>
        ) : null}
        <form
          className="oc-row oc-mt"
          data-tour="thread-search"
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

      <div className="oc-range-nav" data-tour="thread-range">
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
          最終{" "}
          {formatRelative(
            lastPostAt && lastPostAt.threadId === threadId ? lastPostAt.at : (thread.lastPostAt ?? thread.createdAt),
            now,
          )}{" "}
          / 作成 {formatRelative(thread.createdAt, now)}
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
        <div className="oc-panel" data-tour="thread-posts">
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
                    onSelfEdit={post.mine && !post.isOp && (boardSettings?.allowPostEdit ?? true) ? onSelfEdit : undefined}
                    onSelfDelete={
                      post.mine && !post.isOp && (boardSettings?.allowPostDelete ?? true) ? onSelfDelete : undefined
                    }
                    onHistory={onHistory}
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
          onOpenTsubuyaki={() => setTsubuyakiOpen(true)}
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

      <TsubuyakiOverlay
        threadId={threadId}
        boardSlug={slug}
        open={tsubuyakiOpen}
        onClose={() => setTsubuyakiOpen(false)}
        comments={tsubuyakiComments}
        initialLoaded={Boolean(page.data)}
        onSent={(post) => {
          if (post) setTsubuyakiComments((prev) => [...prev, post]);
        }}
        enabled={canPost}
        turnstile={boardInfo.data?.board.settings?.turnstile ?? "anonymous"}
      />

      {/* 自分のレスの編集モーダル */}
      <Modal open={editTarget !== null} title={`レス ${editTarget?.num ?? ""} を編集`} onClose={() => setEditTarget(null)} width={640}>
        {editTarget ? (
          <div className="oc-stack">
            <textarea
              className="oc-textarea"
              rows={6}
              value={editBody}
              onChange={(event) => setEditBody(event.target.value)}
              aria-label="編集本文"
            />
            <div className="oc-muted oc-small">編集すると「編集済み」と表示され、編集前の本文は履歴として誰でも見られます。</div>
            {editTurnstileToken.needed ? (
              <div className="oc-turnstile-row">
                <TurnstileWidget
                  onToken={editTurnstileToken.accept}
                  onInvalidate={editTurnstileToken.invalidate}
                  resetKey={editTurnstileToken.resetKey}
                />
              </div>
            ) : null}
            {editError ? <Notice kind="error">{editError}</Notice> : null}
            <div className="oc-row">
              <Button variant="primary" disabled={editSaving} onClick={() => void submitSelfEdit()}>
                {editSaving ? "保存中…" : "編集を保存"}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* 編集履歴モーダル（誰でも見られる） */}
      <Modal open={historyTarget !== null} title={`レス ${historyTarget?.num ?? ""} の編集履歴`} onClose={() => setHistoryTarget(null)} width={640}>
        {historyTarget ? (
          <div className="oc-stack">
            {historyItems === null ? (
              <div className="oc-muted">読み込み中…</div>
            ) : historyItems.length === 0 ? (
              <div className="oc-muted">編集履歴はありません。</div>
            ) : (
              historyItems.map((item) => (
                <div key={item.id} className="oc-post oc-post-history">
                  <div className="oc-muted oc-small">{formatDate(item.editedAt)} 時点の本文</div>
                  <div className="oc-post-main" style={{ whiteSpace: "pre-wrap" }}>
                    {item.previousBody}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}
      </Modal>

      {/* スレ編集モーダル（スレ主: タイトル + >>1 本文） */}
      <Modal open={threadEditOpen} title="スレを編集" onClose={() => setThreadEditOpen(false)} width={640}>
        <div className="oc-stack">
          <label className="oc-field">
            <span className="oc-label">スレタイ</span>
            <input
              className="oc-input"
              value={threadEditTitle}
              maxLength={120}
              onChange={(event) => setThreadEditTitle(event.target.value)}
              aria-label="スレタイ"
            />
          </label>
          <label className="oc-field">
            <span className="oc-label">{"1 の本文（>>1）"}</span>
            <textarea
              className="oc-textarea"
              rows={6}
              value={threadEditBody}
              onChange={(event) => setThreadEditBody(event.target.value)}
              aria-label="1の本文"
            />
          </label>
          {editTurnstileToken.needed ? (
            <div className="oc-turnstile-row">
              <TurnstileWidget
                onToken={editTurnstileToken.accept}
                onInvalidate={editTurnstileToken.invalidate}
                resetKey={editTurnstileToken.resetKey}
              />
            </div>
          ) : null}
          {editError ? <Notice kind="error">{editError}</Notice> : null}
          <div className="oc-row">
            <Button variant="primary" disabled={editSaving} onClick={() => void submitThreadEdit()}>
              {editSaving ? "保存中…" : "編集を保存"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* このスレを引用したスレの一覧 */}
      <Modal open={quotesOpen} title="このスレを引用したスレ" onClose={() => setQuotesOpen(false)} width={640}>
        <div className="oc-stack">
          {quoteRefs === null ? (
            <div className="oc-muted">読み込み中…</div>
          ) : quoteRefs.length === 0 ? (
            <div className="oc-muted">まだ引用したスレはありません。</div>
          ) : (
            quoteRefs.map((ref) => (
              <div key={ref.id} className="oc-quote-ref-row">
                <Link href={`/b/${ref.boardSlug}/t/${ref.id}?r=l50`}>
                  {ref.boardName} 板 / {ref.title} ({ref.postCount})
                </Link>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}