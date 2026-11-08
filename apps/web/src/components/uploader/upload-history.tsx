"use client";

// アップロード履歴（自分の添付一覧。未投稿の添付を投稿フォームへ戻せる）。
// 添付の本体は外部サービス側にあり、ここに表示するのは URL とメタデータだけ（D1 は URL のみ保持）。

import type { AttachmentDto } from "shared";
import { useCallback, useEffect, useState } from "react";
import { deleteAttachment, listUploadHistory } from "./api";
import { AttachmentThumb, AttachmentViewerModal } from "./attachment-viewer";
import { attachmentKindOf, attachmentLabel, formatBytes, formatDateTime, kindLabel } from "./format";

export interface UploadHistoryProps {
  boardId?: number;
  limit?: number;
  unattachedOnly?: boolean;
  /** 親がアップロード後に増やすと再取得する */
  refreshKey?: number;
  className?: string;
  emptyText?: string;
  /** 「投稿に挿入」ボタン（未投稿添付のみ） */
  onInsert?: (attachment: AttachmentDto) => void;
}

const STATUS_LABEL: Record<AttachmentDto["status"], string> = {
  active: "",
  dead: "リンク切れ",
  deleted: "削除済み",
};

export function UploadHistory({
  boardId,
  limit = 30,
  unattachedOnly = false,
  refreshKey = 0,
  className,
  emptyText = "まだアップロードしたファイルはありません。",
  onInsert,
}: UploadHistoryProps) {
  const [items, setItems] = useState<AttachmentDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<AttachmentDto | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await listUploadHistory({ limit, boardId, unattachedOnly });
      setItems(result.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "履歴を取得できません");
    }
  }, [boardId, limit, unattachedOnly]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const remove = async (item: AttachmentDto) => {
    setBusyId(item.id);
    setError(null);
    try {
      await deleteAttachment(item.id);
      setItems((current) => (current ? current.filter((row) => row.id !== item.id) : current));
      setConfirmingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "削除できません");
    } finally {
      setBusyId(null);
    }
  };

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      setError("クリップボードにコピーできませんでした（URL を選択してコピーしてください）");
    }
  };

  if (items === null && error === null) {
    return <div className="oc-loading">履歴を読み込み中…</div>;
  }

  return (
    <div className={className ?? "oc-stack"} style={{ gap: 6 }}>
      {error ? (
        <div className="oc-error" role="alert">
          <div className="oc-row-between">
            <span>{error}</span>
            <button type="button" className="oc-btn oc-btn-sm" onClick={() => void load()}>
              再試行
            </button>
          </div>
        </div>
      ) : null}
      {items !== null && items.length === 0 ? <div className="oc-empty">{emptyText}</div> : null}
      {(items ?? []).map((item) => {
        const kind = attachmentKindOf(item.url, item.contentType);
        const label = attachmentLabel(item.filename, item.url);
        return (
          <div key={item.id} className="oc-history-item" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ flex: "0 0 auto" }}>
              <AttachmentThumb item={item} showMedia={kind === "image"} onOpen={() => setViewing(item)} />
            </div>
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <div className="oc-row-between" style={{ gap: 6 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={label}>
                  {label}
                </span>
                <span className="oc-history-time oc-note oc-nowrap">{formatDateTime(item.createdAt)}</span>
              </div>
              <div className="oc-note oc-tiny" style={{ marginTop: 2 }}>
                {kindLabel(kind)}・{formatBytes(item.size)}・保存先 {item.adapter}
                {item.expiresAt ? `・${formatDateTime(item.expiresAt)} に期限切れ` : ""}
                {item.postId ? `・投稿 #${item.postId}` : "・未投稿"}
                {STATUS_LABEL[item.status] ? (
                  <span className={item.status === "dead" ? "oc-badge oc-badge-red" : "oc-badge oc-badge-gray"} style={{ marginLeft: 4 }}>
                    {STATUS_LABEL[item.status]}
                  </span>
                ) : null}
              </div>
              <div className="oc-inline oc-mt" style={{ gap: 4, flexWrap: "wrap" }}>
                <button type="button" className="oc-btn oc-btn-sm" onClick={() => setViewing(item)}>
                  表示
                </button>
                <button type="button" className="oc-btn oc-btn-sm" onClick={() => void copyUrl(item.url)}>
                  URL コピー
                </button>
                {onInsert && !item.postId ? (
                  <button type="button" className="oc-btn oc-btn-sm oc-btn-primary" onClick={() => onInsert(item)}>
                    投稿に挿入
                  </button>
                ) : null}
                {item.canDelete ? (
                  confirmingId === item.id ? (
                    <>
                      <button
                        type="button"
                        className="oc-btn oc-btn-sm oc-btn-danger"
                        onClick={() => void remove(item)}
                        disabled={busyId === item.id}
                      >
                        {busyId === item.id ? "削除中…" : "削除する"}
                      </button>
                      <button type="button" className="oc-btn oc-btn-sm" onClick={() => setConfirmingId(null)}>
                        やめる
                      </button>
                    </>
                  ) : (
                    <button type="button" className="oc-btn oc-btn-sm" onClick={() => setConfirmingId(item.id)}>
                      削除
                    </button>
                  )
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
      {viewing ? (
        <AttachmentViewerModal
          item={viewing}
          onClose={() => setViewing(null)}
          onDelete={
            viewing.canDelete
              ? (target) => {
                  const found = (items ?? []).find((row) => row.id === target.id);
                  if (found) void remove(found);
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

export default UploadHistory;