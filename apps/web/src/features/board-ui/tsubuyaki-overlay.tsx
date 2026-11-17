"use client";

// つぶやき（流れるコメント）オーバーレイ。DESIGN §6.2。
// データは WS の tsubuyaki.created と初期取得分。NG はローカル設定を適用する。
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { matchNg, settingsStore } from "./settings";
import { TurnstileWidget } from "./turnstile";
import { getTurnstilePass, setTurnstilePass, useTurnstilePass } from "./turnstile-pass-store";
import type { Post } from "./types";

interface Flowing {
  key: string;
  text: string;
  top: number;
  duration: number;
  size: number;
  color: string;
}

export function TsubuyakiOverlay({
  threadId,
  boardSlug,
  open,
  onClose,
  comments,
  initialLoaded,
  onSent,
  enabled,
  turnstile = "anonymous",
}: {
  threadId: number;
  /** 確認済み（省略）の判定に使う板スラッグ。 */
  boardSlug?: string;
  open: boolean;
  onClose: () => void;
  comments: Post[];
  initialLoaded: boolean;
  onSent?: (post: Post | undefined) => void;
  enabled: boolean;
  /** 板設定の Turnstile 方針（通常投稿と同じ）。 */
  turnstile?: "off" | "anonymous" | "always";
}) {
  const settings = settingsStore.use();
  const [flowing, setFlowing] = useState<Flowing[]>([]);
  const [log, setLog] = useState<Post[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [needsTurnstile, setNeedsTurnstile] = useState(false);
  // サーバーが「期限内の確認済み」と答えていれば、ウィジェットを出さない（報告書 81）。
  const shared = useTurnstilePass(boardSlug ?? "");
  // `always` の板では省略しない（共有 pass が古くても使わない。レビュー 84 / R82-03）。
  const passed = turnstile === "anonymous" && (shared.passed || getTurnstilePass(boardSlug ?? "").passed);
  const seen = useRef(new Set<number>());
  const initialDone = useRef(false);

  // 未ログイン時のみ Turnstile を要求する（板設定 anonymous）。通常投稿と同じ判定。
  // さらに、この端末が期限内の確認済みなら省略する（サーバーが最終判定する）。
  useEffect(() => {
    if (turnstile === "off") {
      setNeedsTurnstile(false);
      return;
    }
    if (turnstile === "always") {
      setNeedsTurnstile(true);
      return;
    }
    let alive = true;
    api.getSession().then((session) => {
      if (!alive) return;
      if (session) {
        setNeedsTurnstile(false);
        return;
      }
      setNeedsTurnstile(true);
      if (!boardSlug) return;
      api
        .getTurnstileStatus(boardSlug)
        .then((status) => {
          if (alive) setTurnstilePass(boardSlug, { passed: status.passed, expiresAt: status.passExpiresAt });
        })
        .catch(() => undefined);
    });
    return () => {
      alive = false;
    };
  }, [turnstile, boardSlug, open]);

  const onToken = useCallback((value: string) => setToken(value), []);

  // 初期取得分はログにだけ載せ、弾幕は流さない（開いた瞬間に画面が埋まるのを防ぐ）。
  useEffect(() => {
    if (!initialLoaded || initialDone.current) return;
    for (const post of comments) {
      seen.current.add(post.id);
    }
    setLog((prev) => [...prev, ...comments].slice(-60));
    initialDone.current = true;
  }, [initialLoaded, comments]);

  useEffect(() => {
    if (!initialDone.current) return;
    const ng = settings.ng;
    const fresh = comments.filter((post) => !seen.current.has(post.id));
    if (fresh.length === 0) return;
    for (const post of fresh) {
      seen.current.add(post.id);
    }
    setLog((prev) => [...prev, ...fresh].slice(-60));
    if (!open) return;
    const now = Date.now();
    const spawn = fresh
      .filter((post) => !matchNg(post, ng).hit)
      .slice(-6)
      .map((post, index) => ({
        key: `${post.id}-${now}-${index}`,
        text: post.body,
        top: 8 + Math.random() * 72,
        duration: Math.max(4, 14 - settings.tsubuyaki.speed) + Math.random() * 2,
        size: settings.tsubuyaki.size,
        color: settings.tsubuyaki.color,
      }));
    setFlowing((prev) => [...prev, ...spawn]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments]);

  if (!open) return null;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (text.length > 100) {
      setError("つぶやきは 100 文字までです");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const post = await api.sendTsubuyaki(threadId, text, passed ? undefined : token || undefined);
      setDraft("");
      setToken("");
      setResetKey((value) => value + 1);
      onSent?.(post);
      // つぶやき自身の初回成功も「確認済み」として共有する（R82-04）。
      // 同じ板のレスフォームにも伝わるよう、サーバーの状態を取り直してストアへ書く。
      if (boardSlug) {
        void api
          .getTurnstileStatus(boardSlug)
          .then((status) => setTurnstilePass(boardSlug, { passed: status.passed, expiresAt: status.passExpiresAt }))
          .catch(() => undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "つぶやきの送信に失敗しました");
      // 失敗した送信でトークンは消費済み。再送に同じ値を送らないよう取り直す。
      setToken("");
      setResetKey((value) => value + 1);
      // NG・429 などでもサーバーは確認済みを取り消している。画面を追随させる（R82-03）。
      if (boardSlug) {
        void api
          .getTurnstileStatus(boardSlug)
          .then((status) => setTurnstilePass(boardSlug, { passed: status.passed, expiresAt: status.passExpiresAt }))
          .catch(() => undefined);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="oc-tsubuyaki-layer" aria-hidden="true">
        {flowing.map((item) => (
          <span
            key={item.key}
            className="oc-tsubuyaki-item"
            style={{
              top: `${item.top}%`,
              fontSize: item.size,
              color: item.color,
              animationDuration: `${item.duration}s`,
              opacity: settings.tsubuyaki.opacity,
            }}
            onAnimationEnd={() => setFlowing((prev) => prev.filter((other) => other.key !== item.key))}
          >
            {item.text}
          </span>
        ))}
      </div>
      <div className="oc-tsubuyaki-panel" role="complementary" aria-label="つぶやき">
        <div className="oc-tsubuyaki-panel-head">
          <strong>つぶやき</strong>
          <span style={{ opacity: 0.75 }}>{enabled ? "100文字まで / Enterで送信" : "実況中は無効です"}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="oc-btn oc-btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <form
          className="oc-row"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            value={draft}
            maxLength={100}
            placeholder="つぶやきを入力…"
            onChange={(event) => setDraft(event.target.value)}
            disabled={!enabled || sending}
            aria-label="つぶやき本文"
          />
          <button type="submit" className="oc-btn oc-btn-sm" disabled={!enabled || sending}>
            送信
          </button>
        </form>
        {error ? <div className="oc-error oc-mt">{error}</div> : null}
        {needsTurnstile && !passed ? (
          <div className="oc-mt">
            <TurnstileWidget onToken={onToken} resetKey={resetKey} />
          </div>
        ) : null}
        <div className="oc-tsubuyaki-log">
          {log.length === 0 ? <div>まだつぶやきはありません</div> : null}
          {log.map((post) => (
            <div key={post.id}>
              <span style={{ color: "#9fdf9f" }}>{post.name || "名無し"}</span>: {post.body}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}