"use client";

// kome（流れるコメント）オーバーレイ。DESIGN §6.2。
// データは WS の kome.created と初期取得分。NG はローカル設定を適用する。
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { matchNg, settingsStore } from "./settings";
import { TurnstileWidget } from "./turnstile";
import type { Post } from "./types";

interface Flowing {
  key: string;
  text: string;
  top: number;
  duration: number;
  size: number;
  color: string;
}

export function KomeOverlay({
  threadId,
  open,
  onClose,
  comments,
  initialLoaded,
  onSent,
  enabled,
  turnstile = "anonymous",
}: {
  threadId: number;
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
  const seen = useRef(new Set<number>());
  const initialDone = useRef(false);

  // 未ログイン時のみ Turnstile を要求する（板設定 anonymous）。通常投稿と同じ判定。
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
      if (alive) setNeedsTurnstile(!session);
    });
    return () => {
      alive = false;
    };
  }, [turnstile]);

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
        duration: Math.max(4, 14 - settings.kome.speed) + Math.random() * 2,
        size: settings.kome.size,
        color: settings.kome.color,
      }));
    setFlowing((prev) => [...prev, ...spawn]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments]);

  if (!open) return null;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (text.length > 100) {
      setError("kome は 100 文字までです");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const post = await api.sendKome(threadId, text, token || undefined);
      setDraft("");
      setToken("");
      setResetKey((value) => value + 1);
      onSent?.(post);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "kome の送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="oc-kome-layer" aria-hidden="true">
        {flowing.map((item) => (
          <span
            key={item.key}
            className="oc-kome-item"
            style={{
              top: `${item.top}%`,
              fontSize: item.size,
              color: item.color,
              animationDuration: `${item.duration}s`,
              opacity: settings.kome.opacity,
            }}
            onAnimationEnd={() => setFlowing((prev) => prev.filter((other) => other.key !== item.key))}
          >
            {item.text}
          </span>
        ))}
      </div>
      <div className="oc-kome-panel" role="complementary" aria-label="kome">
        <div className="oc-kome-panel-head">
          <strong>kome</strong>
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
            placeholder="kome を入力…"
            onChange={(event) => setDraft(event.target.value)}
            disabled={!enabled || sending}
            aria-label="kome 本文"
          />
          <button type="submit" className="oc-btn oc-btn-sm" disabled={!enabled || sending}>
            送信
          </button>
        </form>
        {error ? <div className="oc-error oc-mt">{error}</div> : null}
        {needsTurnstile ? (
          <div className="oc-mt">
            <TurnstileWidget onToken={onToken} resetKey={resetKey} compact />
          </div>
        ) : null}
        <div className="oc-kome-log">
          {log.length === 0 ? <div>まだ kome はありません</div> : null}
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