"use client";

// 実況/新着のリアルタイム購読（WS Hibernation + ticket）。DESIGN §11。
// WS 不可時は指数バックオフののち、可視タブのみのポーリング（15–60秒）へ後退する。

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fetchRealtimeTicket, wsBase } from "./api";
import { normalizePost } from "./api";
import type { Post, RealtimeEvent } from "./types";

export type LiveStatus = "off" | "connecting" | "live" | "polling" | "error";

interface LiveOptions {
  threadId: number;
  enabled: boolean;
  /** 現在の最終レス id（ポーリング差分に使う） */
  getLastPostId: () => number;
  onPost: (post: Post) => void;
  onKome: (post: Post) => void;
  /** 非表示・削除など、一覧の再取得が必要なイベント */
  onInvalidate: () => void;
}

const POLL_INTERVAL = 15_000;
const MAX_RETRIES = 3;

interface PollState {
  disposed: boolean;
  hidden: boolean;
}

/**
 * ポーリング結果を反映してよいかを await の前後で判定する。
 * スレを切り替えた直後（disposed）や背景タブでは、取得中の旧スレ結果を捨てる。
 */
export async function runPollOnce(
  state: () => PollState,
  fetchItems: () => Promise<{ items: Post[] }>,
  apply: (items: Post[]) => void,
): Promise<void> {
  const before = state();
  if (before.disposed || before.hidden) return;
  const result = await fetchItems();
  const after = state();
  if (after.disposed || after.hidden) return;
  apply(result.items);
}

export function useThreadLive({ threadId, enabled, getLastPostId, onPost, onKome, onInvalidate }: LiveOptions) {
  const [status, setStatus] = useState<LiveStatus>("off");
  const seqRef = useRef(0);
  const handlers = useRef({ onPost, onKome, onInvalidate });
  handlers.current = { onPost, onKome, onInvalidate };
  const lastPostId = useRef<number>(getLastPostId());
  lastPostId.current = getLastPostId();

  const handleEvent = useCallback((event: RealtimeEvent) => {
    if (typeof event.seq === "number" && event.seq > seqRef.current) {
      seqRef.current = event.seq;
    }
    const payload = (event.data ?? {}) as Record<string, unknown>;
    const rawPost = payload.post ?? payload.kome ?? event.data;
    switch (event.type) {
      case "post.created":
        if (rawPost) handlers.current.onPost(normalizePost(rawPost));
        break;
      case "kome.created":
        if (rawPost) handlers.current.onKome(normalizePost(rawPost));
        break;
      case "post.hidden":
      case "post.deleted":
      case "thread.updated":
        handlers.current.onInvalidate();
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    let disposed = false;
    let socket: WebSocket | null = null;
    let retries = 0;
    let retryTimer = 0;
    let pollTimer = 0;

    const poll = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      try {
        const since = lastPostId.current;
        await runPollOnce(
          () => ({ disposed, hidden: document.visibilityState === "hidden" }),
          () => api.getPostsSince(threadId, since),
          (items) => {
            for (const post of items) {
              if (post.kind === "kome") {
                handlers.current.onKome(post);
              } else {
                handlers.current.onPost(post);
              }
            }
          },
        );
      } catch {
        // ポーリング失敗は次回に任せる
      }
    };

    const startPolling = () => {
      if (disposed) return;
      setStatus("polling");
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL);
      void poll();
    };

    const connect = async () => {
      if (disposed) return;
      setStatus("connecting");
      try {
        const channel = `thread:${threadId}`;
        const ticket = await fetchRealtimeTicket(channel);
        if (disposed) return;
        const url = `${wsBase()}/rt?ticket=${encodeURIComponent(ticket.ticket)}&channel=${encodeURIComponent(
          channel,
        )}&since=${seqRef.current}`;
        socket = new WebSocket(url);
        socket.onopen = () => {
          retries = 0;
          setStatus("live");
          window.clearInterval(pollTimer);
        };
        socket.onmessage = (message) => {
          try {
            const parsed = JSON.parse(String(message.data)) as RealtimeEvent | { events?: RealtimeEvent[] };
            if ("events" in parsed && Array.isArray(parsed.events)) {
              for (const event of parsed.events) handleEvent(event);
            } else {
              handleEvent(parsed as RealtimeEvent);
            }
          } catch {
            // 壊れたフレームは無視
          }
        };
        socket.onerror = () => {
          // onclose 側で処理
        };
        socket.onclose = () => {
          if (disposed) return;
          retries += 1;
          if (retries > MAX_RETRIES) {
            startPolling();
            return;
          }
          const delay = 1000 * 2 ** (retries - 1);
          setStatus("connecting");
          retryTimer = window.setTimeout(() => void connect(), delay);
        };
      } catch {
        retries += 1;
        if (retries > MAX_RETRIES) {
          startPolling();
          return;
        }
        retryTimer = window.setTimeout(() => void connect(), 1000 * 2 ** (retries - 1));
      }
    };

    void connect();

    const visibility = () => {
      if (document.visibilityState === "visible" && pollTimer !== 0) {
        void poll();
      }
    };
    document.addEventListener("visibilitychange", visibility);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", visibility);
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.close();
      }
      setStatus("off");
    };
    // status は effect 内で閉じ込めない（visibility ハンドラの条件は最新値を ref でも可）
  }, [threadId, enabled, handleEvent]);

  return { status, seq: seqRef.current };
}