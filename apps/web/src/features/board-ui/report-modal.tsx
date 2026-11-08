"use client";

// 通報（削除依頼）フォーム。理由・レス番・コメント + Turnstile（DESIGN §6.2）。
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Button, Modal, Notice, useToast } from "@/components/ui";
import { TurnstileWidget } from "./turnstile";
import { REASONS, type ReportReason } from "./types";

export function ReportModal({
  open,
  onClose,
  boardSlug,
  threadId,
  defaultPosts,
}: {
  open: boolean;
  onClose: () => void;
  boardSlug: string;
  threadId: number;
  defaultPosts: string;
}) {
  const toast = useToast();
  const [reason, setReason] = useState<ReportReason>("abuse");
  const [posts, setPosts] = useState(defaultPosts);
  const [comment, setComment] = useState("");
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPosts(defaultPosts);
      setError(null);
    }
  }, [open, defaultPosts]);

  const onToken = useCallback((value: string) => setToken(value), []);

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      await api.createReport({
        boardSlug,
        threadId,
        posts: posts.trim() || "all",
        reason,
        comment: comment.trim() || undefined,
        turnstileToken: token || undefined,
      });
      toast.show("通報を受け付けました");
      onClose();
      setComment("");
      setResetKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "通報に失敗しました");
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      title="通報（削除依頼）"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button onClick={onClose} disabled={sending}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit} disabled={sending}>
            {sending ? "送信中…" : "通報する"}
          </Button>
        </>
      }
    >
      <div className="oc-field">
        <label className="oc-label" htmlFor="report-reason">
          理由
        </label>
        <select
          id="report-reason"
          className="oc-select"
          value={reason}
          onChange={(event) => setReason(event.target.value as ReportReason)}
        >
          {REASONS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="oc-field">
        <label className="oc-label" htmlFor="report-posts">
          レス番（例: 1 / 1-3 / 1,3,5 / all）
        </label>
        <input
          id="report-posts"
          className="oc-input"
          value={posts}
          onChange={(event) => setPosts(event.target.value)}
          maxLength={120}
        />
      </div>
      <div className="oc-field">
        <label className="oc-label" htmlFor="report-comment">
          コメント（任意）
        </label>
        <textarea
          id="report-comment"
          className="oc-textarea"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={500}
          rows={3}
        />
      </div>
      <TurnstileWidget onToken={onToken} resetKey={resetKey} compact />
      {error ? <Notice kind="error">{error}</Notice> : null}
      <p className="oc-note">虚偽の通報は利用制限の対象になる場合があります。</p>
    </Modal>
  );
}