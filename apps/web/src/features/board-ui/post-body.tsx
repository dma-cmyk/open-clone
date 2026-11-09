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

const TOKEN = /(>>\d+(?:[-,]\d+)*)|(https?:\/\/[^\s<>"）]+)|(\|\|[^|\n]+\|\|)/g;

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
    const [raw, anchor, url, spoiler] = match;
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
    } else if (url) {
      nodes.push(<InlineUrl key={`${keyPrefix}-u-${index}`} url={url} showImages={showImages} />);
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