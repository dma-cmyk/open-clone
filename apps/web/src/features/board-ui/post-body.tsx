"use client";

// レス本文のレンダラ。生 HTML は使わず、React のテキストノード＋限定要素のみで描画する（XSS 対策 / DESIGN §13）。
// 対応: 安価 `>>n` / 飛び番 `>>3,4,8` / URL / ネタバレ `||...||` / 画像・動画 URL のインライン展開 /
//       プラグインの宣言的レンダー規則（規則の適用範囲も同じトークン描画を通す）。

import { Fragment, useEffect, useState } from "react";
import type { PluginPostRenderRule } from "shared";
import {
  MAX_RENDER_TEXT_CHARS,
  type PostRenderSegment,
} from "@/features/plugin-host/render-rules";
import { requestRenderSegments } from "@/features/plugin-host/render-worker-client";
import { mediaKind } from "./format";
import { api } from "./api";

// 自サイトのスレ相対パス（/b/<slug>/t/<id>）も URL トークンとして捕まえる（引用スレカード用）。
const TOKEN = /(>>\d+(?:[-,]\d+)*)|(https?:\/\/[^\s<>"）]+)|(\/b\/[a-z0-9_-]+\/t\/\d+(?:[^\s<>"）]*))|(\|\|[^|\n]+\|\|)/g;
/** このサイトのスレ URL（/b/<slug>/t/<id>）。レス内の引用スレカードに使う。 */
const THREAD_URL = /\/b\/([a-z0-9_-]+)\/t\/(\d+)/i;

function Spoiler({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`oc-spoiler${open ? " open" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpen((value) => !value);
        }
      }}
      title={open ? "クリックで隠す" : "クリックで表示"}
    >
      {text}
    </span>
  );
}

function InlineUrl({ url, showImages }: { url: string; showImages: boolean }) {
  const kind = mediaKind(url);
  if (showImages && kind === "image") {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="oc-inline-media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="添付画像" loading="lazy" referrerPolicy="no-referrer" style={{ maxHeight: 220 }} />
      </a>
    );
  }
  if (showImages && kind === "video") {
    return <video src={url} controls preload="metadata" style={{ maxHeight: 260, maxWidth: "100%" }} />;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {url.length > 90 ? `${url.slice(0, 90)}…` : url}
    </a>
  );
}

/**
 * レス内のこのサイトのスレ URL をスレカードとして表示する（引用スレ機能 (2)）。
 * カード情報は GET /v1/threads/:id/card（タイトル・件数などの最小限）から取得する。
 * スレ本体を取得すると、削除板のスレのタイトル・本文が表示しなくてもブラウザへ届くため使わない（R74-05）。
 */
function ThreadLinkCard({ url, boardSlug, threadId }: { url: string; boardSlug: string; threadId: number }) {
  const [card, setCard] = useState<{ title: string; postCount: number; unavailable: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .getThreadCard(threadId)
      .then((data) => {
        if (cancelled) return;
        setCard(
          data && !data.unavailable
            ? { title: data.title, postCount: data.postCount, unavailable: false }
            : { title: "削除されたスレ", postCount: 0, unavailable: true },
        );
      })
      .catch(() => {
        if (!cancelled) setCard({ title: "削除されたスレ", postCount: 0, unavailable: true });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  return (
    <a
      href={url}
      className="oc-thread-link-card"
      data-quote-thread-card={threadId}
      title={card ? `${boardSlug} 板 / ${card.title} (${card.postCount})` : `${boardSlug} 板のスレ`}
    >
      <span className="oc-thread-link-card-board">{boardSlug} 板</span>
      <span className="oc-thread-link-card-title">
        {card ? (card.unavailable ? "削除されたスレ" : card.title) : "スレを読み込み中…"}
      </span>
      {card && !card.unavailable ? <span className="oc-thread-link-card-count">({card.postCount})</span> : null}
    </a>
  );
}

/** 本文断片を安価・URL・ネタバレのトークンへ分解する（テキストは React のテキストノード）。 */
function renderTokens(
  text: string,
  keyPrefix: string,
  showImages: boolean,
  onAnchor: (spec: string, element: HTMLElement) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(<Fragment key={`${keyPrefix}-t-${cursor}`}>{text.slice(cursor, index)}</Fragment>);
    }
    const [raw, anchor, url, localPath, spoiler] = match;
    const urlToken = url ?? localPath;
    if (anchor) {
      nodes.push(
        <button
          key={`${keyPrefix}-a-${index}`}
          type="button"
          className="oc-anchor"
          onClick={(event) => onAnchor(anchor.slice(2), event.currentTarget)}
        >
          {anchor}
        </button>,
      );
    } else if (urlToken) {
      // このサイトのスレ URL（自オリジン or 相対パスを含む /b/<slug>/t/<id>）は引用スレカード。
      // 判定は URL を解析して origin を完全一致で比較する（前方一致は userinfo 付き外部 URL
      // （例: https://origin@evil.example/…）を内部と誤認する。R74-06）。
      const threadMatch = THREAD_URL.exec(urlToken);
      let isLocalThread = false;
      if (threadMatch !== null) {
        if (urlToken.startsWith("/")) {
          isLocalThread = true;
        } else if (typeof location !== "undefined") {
          try {
            const parsed = new URL(urlToken, location.origin);
            isLocalThread = parsed.origin === location.origin;
          } catch {
            isLocalThread = false;
          }
        }
      }
      if (isLocalThread && threadMatch) {
        nodes.push(
          <ThreadLinkCard
            key={`${keyPrefix}-u-${index}`}
            url={urlToken}
            boardSlug={threadMatch[1] ?? ""}
            threadId={Number(threadMatch[2] ?? 0)}
          />,
        );
      } else {
        nodes.push(<InlineUrl key={`${keyPrefix}-u-${index}`} url={urlToken} showImages={showImages} />);
      }
    } else if (spoiler) {
      nodes.push(<Spoiler key={`${keyPrefix}-s-${index}`} text={spoiler.slice(2, -2)} />);
    } else {
      nodes.push(<Fragment key={`${keyPrefix}-r-${index}`}>{raw}</Fragment>);
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-t-${cursor}`}>{text.slice(cursor)}</Fragment>);
  }
  return nodes;
}

export function PostBody({
  body,
  aa,
  showImages,
  onAnchor,
  renderRules,
}: {
  body: string;
  aa: boolean;
  showImages: boolean;
  onAnchor: (spec: string, element: HTMLElement) => void;
  /** 有効なプラグインの宣言的変換規則。適用範囲もテキストとして描画する（HTML は解釈しない）。 */
  renderRules?: readonly PluginPostRenderRule[];
}) {
  // 規則の実行は Worker に任せる（M-4）。結果が来るまでは通常表示し、
  // 時間切れ・規則なしなら通常表示のままにする。メインスレッドは止まらない。
  const [rendered, setRendered] = useState<{ body: string; segments: PostRenderSegment[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRendered(null);
    if (!renderRules || renderRules.length === 0 || body.length > MAX_RENDER_TEXT_CHARS) {
      return () => {
        cancelled = true;
      };
    }
    void requestRenderSegments(body, renderRules).then((result) => {
      if (!cancelled && result) setRendered({ body, segments: result });
    });
    return () => {
      cancelled = true;
    };
  }, [body, renderRules]);

  // 本文が替わった直後に前の本文の変換結果を出さない（常に現在の本文と組で扱う）。
  const displaySegments =
    rendered && rendered.body === body ? rendered.segments : [{ type: "text" as const, text: body }];

  const nodes = displaySegments.map((segment, index) =>
    segment.type === "rule" ? (
      <span
        key={`seg-${index}`}
        className={`oc-plugin-render oc-plugin-render-${segment.kind}`}
        data-plugin-rule="1"
      >
        {renderTokens(segment.text, `r${index}`, showImages, onAnchor)}
      </span>
    ) : (
      <Fragment key={`seg-${index}`}>
        {renderTokens(segment.text, `t${index}`, showImages, onAnchor)}
      </Fragment>
    ),
  );

  return <div className={`oc-post-main${aa ? " oc-aa" : ""}`}>{nodes}</div>;
}