"use client";

// 添付ビューア（画像=クリック拡大 / 動画・音声=再生 / テキスト=閲覧 / その他=ダウンロード）。
// 外部保存先（Catbox 等）は CORS を返さないことがあるため、テキストは Worker の `/v1/uploads/:id/raw` 経由で読む。
// 見た目は既存の `oc-attachment*` クラス（globals.css）を使い、WP2 の open2ch 風テーマに追従する。

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui";
import { attachmentRawUrl, UploadApiError } from "./api";
import {
  attachmentKindOf,
  attachmentLabel,
  formatBytes,
  guessedContentType,
  kindLabel,
} from "./format";
import type { UploadedAttachment } from "./types";

const MAX_INLINE_TEXT_CHARS = 200_000;

export interface AttachmentViewerProps {
  items: UploadedAttachment[];
  /** 画像・動画をサムネイル表示するか（NG 設定や「画像非表示」時は false） */
  showMedia?: boolean;
  className?: string;
  /** 添付を削除できる場合のコールバック（未指定なら削除ボタンを出さない） */
  onDelete?: (item: UploadedAttachment) => void;
  /** 生 URL を開く代わりに独自処理する（省略時は別タブ） */
  onOpenExternal?: (item: UploadedAttachment) => void;
}

export function attachmentViewerKind(item: UploadedAttachment) {
  return attachmentKindOf(item.url, item.contentType);
}

/** 画像/動画/音声のサムネイル（クリックでビューアを開く）。 */
export function AttachmentThumb({
  item,
  showMedia = true,
  onOpen,
}: {
  item: UploadedAttachment;
  showMedia?: boolean;
  onOpen: (item: UploadedAttachment) => void;
}) {
  const kind = attachmentViewerKind(item);
  const label = attachmentLabel(item.name ?? item.filename, item.url);

  if (kind === "image" && showMedia) {
    return (
      <div className="oc-attachment">
        <img
          src={item.url}
          alt={label}
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ cursor: "zoom-in" }}
          onClick={() => onOpen(item)}
        />
        <div className="oc-attachment-file oc-muted oc-tiny">
          {formatBytes(item.size)}・{kindLabel(kind)}
        </div>
      </div>
    );
  }
  if (kind === "video" && showMedia) {
    return (
      <div className="oc-attachment">
        <video src={item.url} controls preload="metadata" />
        <div className="oc-attachment-file oc-muted oc-tiny">{formatBytes(item.size)}・動画</div>
      </div>
    );
  }
  if (kind === "audio" && showMedia) {
    return (
      <div className="oc-attachment">
        <audio src={item.url} controls preload="metadata" />
        <div className="oc-attachment-file oc-muted oc-tiny">{formatBytes(item.size)}・音声</div>
      </div>
    );
  }
  return (
    <div className="oc-attachment">
      <button type="button" className="oc-attachment-file" onClick={() => onOpen(item)} title={label}>
        {kind === "text" ? "📄" : "📎"} {label}（{formatBytes(item.size)}）
      </button>
    </div>
  );
}

interface ViewerState {
  item: UploadedAttachment;
}

/** 1 添付の詳細ビューア。テキストは遅延取得して `<pre>` 表示（HTML は描画しない）。 */
export function AttachmentViewerModal({
  item,
  onClose,
  onOpenExternal,
  onDelete,
}: {
  item: UploadedAttachment;
  onClose: () => void;
  onOpenExternal?: (item: UploadedAttachment) => void;
  onDelete?: (item: UploadedAttachment) => void;
}) {
  const kind = attachmentViewerKind(item);
  const label = attachmentLabel(item.name ?? item.filename, item.url);
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [loading, setLoading] = useState(kind === "text");

  useEffect(() => {
    if (kind !== "text") return;
    let alive = true;
    const url = item.id ? attachmentRawUrl(item.id) : item.url;
    setLoading(true);
    setTextError(null);
    fetch(url, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) {
          throw new UploadApiError(response.status, "TEXT_FETCH_FAILED", `テキストを取得できません（HTTP ${response.status}）`);
        }
        const raw = await response.text();
        return raw.length > MAX_INLINE_TEXT_CHARS ? `${raw.slice(0, MAX_INLINE_TEXT_CHARS)}\n…（以下省略）` : raw;
      })
      .then((body) => {
        if (alive) setText(body);
      })
      .catch((cause: unknown) => {
        if (alive) setTextError(cause instanceof Error ? cause.message : "テキストを取得できません");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [item.id, item.url, kind]);

  return (
    <Modal open title={`${kindLabel(kind)}: ${label}`} onClose={onClose} width={kind === "text" ? 820 : 760}>
      <div className="oc-stack" style={{ gap: 8 }}>
        {kind === "image" ? (
            <img
            src={item.url}
            alt={label}
            referrerPolicy="no-referrer"
            style={{ display: "block", maxWidth: "100%", maxHeight: "68vh", margin: "0 auto" }}
          />
        ) : null}
        {kind === "video" ? (
          <video src={item.url} controls autoPlay={false} preload="metadata" style={{ maxWidth: "100%", maxHeight: "68vh" }} />
        ) : null}
        {kind === "audio" ? <audio src={item.url} controls preload="metadata" style={{ width: "100%" }} /> : null}
        {kind === "text" ? (
          <div>
            {loading ? <div className="oc-loading">テキストを取得中…</div> : null}
            {textError ? (
              <div className="oc-error" role="alert">
                {textError}（
                <a href={item.url} target="_blank" rel="noreferrer noopener">
                  別タブで開く
                </a>
                ）
              </div>
            ) : null}
            {text !== null ? (
              <pre
                className="oc-mono"
                style={{
                  margin: 0,
                  maxHeight: "58vh",
                  overflow: "auto",
                  background: "var(--oc-surface-alt)",
                  border: "1px solid var(--oc-border)",
                  padding: 8,
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {text}
              </pre>
            ) : null}
          </div>
        ) : null}
        {kind === "file" ? (
          <div className="oc-note">この形式はページ内表示に対応していません。ダウンロードしてください。</div>
        ) : null}

        <div className="oc-row-between oc-note" style={{ flexWrap: "wrap", gap: 6 }}>
          <span>
            {formatBytes(item.size)}／{guessedContentType(item.url, item.contentType)}
            {item.id ? `／ID: ${item.id}` : ""}
          </span>
          <span className="oc-inline" style={{ gap: 6 }}>
            {onOpenExternal ? (
              <button type="button" className="oc-btn oc-btn-sm" onClick={() => onOpenExternal(item)}>
                ダウンロード
              </button>
            ) : (
              <a className="oc-btn oc-btn-sm" href={item.url} target="_blank" rel="noreferrer noopener" download={label}>
                ダウンロード
              </a>
            )}
            {kind === "text" && item.id ? (
              <a className="oc-btn oc-btn-sm" href={attachmentRawUrl(item.id)} target="_blank" rel="noreferrer noopener">
                生テキスト
              </a>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                className="oc-btn oc-btn-sm oc-btn-danger"
                onClick={() => {
                  onDelete(item);
                  onClose();
                }}
              >
                削除
              </button>
            ) : null}
            <button type="button" className="oc-btn oc-btn-sm" onClick={onClose}>
              閉じる
            </button>
          </span>
        </div>
      </div>
    </Modal>
  );
}

/** 添付一覧 + クリックでビューア。投稿表示やアップロード履歴に埋め込む。 */
export function AttachmentViewer({ items, showMedia = true, className, onDelete, onOpenExternal }: AttachmentViewerProps) {
  const [viewing, setViewing] = useState<ViewerState | null>(null);
  if (items.length === 0) return null;
  return (
    <>
      <div className={className ?? "oc-attachments"}>
        {items.map((item, index) => (
          <AttachmentThumb key={`${item.url}-${index}`} item={item} showMedia={showMedia} onOpen={(next) => setViewing({ item: next })} />
        ))}
      </div>
      {viewing ? (
        <AttachmentViewerModal
          item={viewing.item}
          onClose={() => setViewing(null)}
          onDelete={onDelete}
          onOpenExternal={onOpenExternal}
        />
      ) : null}
    </>
  );
}

export default AttachmentViewer;