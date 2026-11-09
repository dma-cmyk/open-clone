"use client";

// レス 1 行（open2ch の `1 ：名前：日付 ID:xxxx` 書式）。
import { useState } from "react";
import { formatDate, formatSize, mediaKind } from "./format";
import { PostBody } from "./post-body";
import type { PluginPostRenderRule } from "shared";
import { Modal } from "@/components/ui";
import { PluginSlot } from "@/components/plugin-slot";
import type { AttachmentRef, Post } from "./types";

interface PostRowProps {
  post: Post;
  showImages: boolean;
  aa: boolean;
  canManage: boolean;
  highlight?: boolean;
  isNew?: boolean;
  onQuote: (num: number) => void;
  onAnchor: (spec: string, element: HTMLElement) => void;
  onLike: (post: Post) => void;
  onNgId: (idHash: string) => void;
  onFilterId: (idHash: string) => void;
  onReport: (post: Post) => void;
  onDelete: (post: Post, mode: "hide" | "delete") => void;
  onJump: (num: number) => void;
  /** プラグインの宣言的レンダー規則（WP3）。空なら標準レンダラを使う。 */
  renderRules?: readonly PluginPostRenderRule[];
}

function Attachments({ items, showImages }: { items: AttachmentRef[]; showImages: boolean }) {
  const [zoom, setZoom] = useState<AttachmentRef | null>(null);
  const [textOpen, setTextOpen] = useState<AttachmentRef | null>(null);
  return (
    <div className="oc-attachments">
      {items.map((item, index) => {
        const kind = mediaKind(item.url, item.contentType);
        if (kind === "image" && showImages) {
          return (
            <div className="oc-attachment" key={item.url + index}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.url}
                alt={item.name ?? "添付画像"}
                loading="lazy"
                referrerPolicy="no-referrer"
                onClick={() => setZoom(item)}
              />
              <div className="oc-attachment-file oc-muted oc-tiny">{formatSize(item.size)}</div>
            </div>
          );
        }
        if (kind === "video" && showImages) {
          return (
            <div className="oc-attachment" key={item.url + index}>
              <video src={item.url} controls preload="metadata" />
            </div>
          );
        }
        return (
          <div className="oc-attachment" key={item.url + index}>
            <button
              type="button"
              className="oc-attachment-file"
              onClick={() => (kind === "text" ? setTextOpen(item) : window.open(item.url, "_blank", "noopener"))}
            >
              📎 {item.name ?? (kind === "text" ? "テキスト" : "ファイル")} {formatSize(item.size)}
            </button>
          </div>
        );
      })}
      <Modal open={zoom !== null} title="画像" onClose={() => setZoom(null)} width={900}>
        {zoom ? (
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={zoom.url} alt={zoom.name ?? "添付画像"} style={{ maxWidth: "100%" }} />
            <div className="oc-row oc-mt">
              <a href={zoom.url} target="_blank" rel="noopener noreferrer">
                元画像を開く
              </a>
              <span className="oc-muted oc-small">{formatSize(zoom.size)}</span>
            </div>
          </div>
        ) : null}
      </Modal>
      <Modal open={textOpen !== null} title="テキスト" onClose={() => setTextOpen(null)} width={760}>
        {textOpen ? (
          <iframe src={textOpen.url} title="添付テキスト" style={{ width: "100%", height: "55vh", border: "1px solid #bbb" }} />
        ) : null}
      </Modal>
    </div>
  );
}

export function PostRow({
  post,
  showImages,
  aa,
  canManage,
  highlight,
  isNew,
  onQuote,
  onAnchor,
  onLike,
  onNgId,
  onFilterId,
  onReport,
  onDelete,
  onJump,
  renderRules,
}: PostRowProps) {
  const backlinks = post.backlinks ?? [];
  return (
    <article className={`oc-post${post.isOp ? " oc-post-op" : ""}${highlight ? " oc-post-target" : ""}`} id={`p${post.num}`}>
      <div className="oc-post-header">
        <button type="button" className="oc-post-num" onClick={() => onQuote(post.num)} title="クリックで引用">
          {post.num}
        </button>
        <span>：</span>
        <span className="oc-post-name">
          {post.name || "名無しさん"}
          {post.isSub ? <span className="oc-badge oc-badge-yellow" style={{ marginLeft: 3 }}>▼副</span> : null}
        </span>
        {post.trip ? <span className="oc-post-trip">{post.trip}</span> : null}
        {post.cap ? <span className="oc-post-cap">{post.cap}</span> : null}
        <span>：</span>
        <span className="oc-post-date">{formatDate(post.createdAt)}</span>
        {post.idHash ? (
          <>
            <span className="oc-post-id">
              {" "}
              ID:
              <button
                type="button"
                className="oc-post-id"
                onClick={() => onFilterId(post.idHash ?? "")}
                title="ID でレスを抽出"
                style={{ textDecoration: "underline dotted" }}
              >
                {post.idHash}
              </button>
            </span>
            {post.isOp ? <span className="oc-post-op-mark">主</span> : null}
            <button
              type="button"
              className="oc-post-ng"
              title="この ID を NG に追加"
              onClick={() => onNgId(post.idHash ?? "")}
            >
              ×
            </button>
          </>
        ) : (
          <span className="oc-post-id oc-muted">{" "}ID:???</span>
        )}
        {post.aiAgent ? (
          <span className="oc-badge oc-badge-gray" title="AI 管理者による投稿">
            AI{post.aiAgent.name ? `:${post.aiAgent.name}` : ""}
          </span>
        ) : null}
        {isNew ? <span className="oc-new-marker">NEW</span> : null}
        {post.sage ? <span className="oc-badge oc-badge-gray">sage</span> : null}
      </div>

      <PostBody body={post.body} aa={aa} showImages={showImages} onAnchor={onAnchor} renderRules={renderRules} />

      {post.attachments && post.attachments.length > 0 ? (
        <Attachments items={post.attachments} showImages={showImages} />
      ) : null}

      <div className="oc-post-actions">
        <button type="button" className={post.liked ? "oc-like-on" : undefined} onClick={() => onLike(post)}>
          {post.liked ? "♥" : "♡"} いいね{post.likeCount ? ` ${post.likeCount}` : ""}
        </button>
        {backlinks.length > 0 ? (
          <button type="button" className="oc-backlinks" onClick={() => onJump(backlinks[0] ?? post.num)}>
            安価 {backlinks.slice(0, 8).join(", ")}
            {backlinks.length > 8 ? "…" : ""}
          </button>
        ) : null}
        <button type="button" onClick={() => onQuote(post.num)}>
          引用
        </button>
        <button type="button" onClick={() => onReport(post)}>
          通報
        </button>
        {canManage ? (
          <>
            <button type="button" onClick={() => onDelete(post, "hide")}>
              非表示
            </button>
            <button type="button" onClick={() => onDelete(post, "delete")}>
              削除
            </button>
          </>
        ) : null}
        <PluginSlot slot="post-actions" postId={post.id} postBody={post.body} />
      </div>
    </article>
  );
}