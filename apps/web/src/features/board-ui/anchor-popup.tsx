"use client";

// 安価（>>n）のポップアップ。読み込み済みレスを即表示し、未取得分はAPIから補完する。
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { expandAnchorSpec, formatDate } from "./format";
import type { Post } from "./types";

export interface AnchorTarget {
  spec: string;
  x: number;
  y: number;
}

export function AnchorPopup({
  target,
  postsByNum,
  threadId,
  onClose,
  onQuote,
}: {
  target: AnchorTarget | null;
  postsByNum: Map<number, Post>;
  threadId: number;
  onClose: () => void;
  onQuote: (num: number) => void;
}) {
  const [extra, setExtra] = useState<Map<number, Post>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) return;
    setError(null);
    const nums = expandAnchorSpec(target.spec);
    const missing = nums.filter((num) => !postsByNum.has(num) && !extra.has(num));
    if (missing.length === 0) return;
    let alive = true;
    setLoading(true);
    api
      .getThread(threadId, { r: target.spec })
      .then((page) => {
        if (!alive) return;
        setExtra((prev) => {
          const next = new Map(prev);
          for (const post of page.posts) {
            next.set(post.num, post);
          }
          return next;
        });
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "安価の取得に失敗しました");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // target.spec が変わったときだけ再取得する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.spec, threadId]);

  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const timer = window.setTimeout(() => document.addEventListener("mousedown", onPointer), 10);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
      window.clearTimeout(timer);
    };
  }, [target, onClose]);

  if (!target) return null;

  const nums = expandAnchorSpec(target.spec);
  const posts = nums.map((num) => postsByNum.get(num) ?? extra.get(num)).filter((post): post is Post => Boolean(post));

  const width = 420;
  const left = Math.max(8, Math.min(target.x, (typeof window === "undefined" ? 800 : window.innerWidth) - width - 12));
  const top = Math.min(target.y + 8, (typeof window === "undefined" ? 600 : window.innerHeight) - 120);

  return (
    <div ref={boxRef} className="oc-anchor-pop" style={{ left, top, width }} role="dialog" aria-label="安価のプレビュー">
      <div className="oc-row-between" style={{ marginBottom: 4 }}>
        <span className="oc-anchor-pop-head">安価 &gt;&gt;{target.spec}</span>
        <button type="button" className="oc-btn oc-btn-sm" onClick={onClose}>
          ✕
        </button>
      </div>
      {loading ? <div className="oc-note">読み込み中…</div> : null}
      {error ? <div className="oc-error">{error}</div> : null}
      {posts.length === 0 && !loading ? <div className="oc-note">該当レスが見つかりません</div> : null}
      {posts.map((post) => (
        <div key={post.num} style={{ borderTop: "1px solid #e0d9b0", paddingTop: 4, marginTop: 4 }}>
          <div>
            <span className="oc-anchor-pop-name">{post.num} ：{post.name}</span>
            <span className="oc-anchor-pop-date">{formatDate(post.createdAt)}</span>
            {post.idHash ? <span className="oc-anchor-pop-date">ID:{post.idHash}</span> : null}
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{post.body.length > 400 ? `${post.body.slice(0, 400)}…` : post.body}</div>
          <button type="button" className="oc-btn oc-btn-sm" onClick={() => onQuote(post.num)}>
            引用
          </button>
        </div>
      ))}
    </div>
  );
}