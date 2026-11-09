"use client";

// 投稿フォーム（レス / スレ立て）。Turnstile、アップローダ（WP4）、お絵かきを統合する。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { Button, Notice, useToast } from "@/components/ui";
import { OekakiEditor } from "./oekaki-editor";
import { TurnstileWidget } from "./turnstile";
import { UploaderMount, type UploaderHandle } from "./uploader-mount";
import { onQuote } from "./quote-bus";
import { settingsStore } from "./settings";
import { recordWrite } from "./history";
import { THREAD_MODES, type AttachmentRef, type Post } from "./types";

interface PostFormProps {
  mode: "post" | "thread";
  boardSlug: string;
  boardId?: number;
  threadId?: number;
  threadTitle?: string;
  onPosted: (result: { post?: Post; threadId?: number }) => void;
  onOpenTsubuyaki?: () => void;
  disabled?: boolean;
  disabledReason?: string;
  /** 板設定の Turnstile 方針。ログイン済みなら anonymous では表示しない。 */
  turnstile?: "off" | "anonymous" | "always";
}

export function PostForm({
  mode,
  boardSlug,
  boardId,
  threadId,
  threadTitle,
  onPosted,
  onOpenTsubuyaki,
  disabled,
  disabledReason,
  turnstile = "anonymous",
}: PostFormProps) {
  const [name, setName] = useState("");
  const [mail, setMail] = useState("");
  const [title, setTitle] = useState("");
  const [threadMode, setThreadMode] = useState("");
  const [body, setBody] = useState("");
  const [sage, setSage] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMail, setShowMail] = useState(false);
  const [oekakiOpen, setOekakiOpen] = useState(false);
  const [floating, setFloating] = useState(settingsStore.get().behavior.floatForm);
  // スマホでは投稿欄を「書き込む」バー1行に畳む（タップで展開）。
  const [mobileOpen, setMobileOpen] = useState(true);
  const [needsTurnstile, setNeedsTurnstile] = useState(true);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploaderRef = useRef<UploaderHandle>(null);
  const toast = useToast();

  const draftKey = useMemo(
    () => `oc.draft.v1.${boardSlug}.${mode === "thread" ? "new" : String(threadId ?? "x")}`,
    [boardSlug, mode, threadId],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw) as { name?: string; mail?: string; body?: string; title?: string; sage?: boolean };
      if (draft.name) setName(draft.name);
      if (draft.mail) setMail(draft.mail);
      if (draft.body) setBody(draft.body);
      if (draft.title) setTitle(draft.title);
      if (typeof draft.sage === "boolean") setSage(draft.sage);
    } catch {
      // 壊れた下書きは無視
    }
  }, [draftKey]);

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      if (!body && !title && !name && !mail) return;
      try {
        window.localStorage.setItem(draftKey, JSON.stringify({ name, mail, body, title, sage }));
        setDraftSavedAt(Date.now());
      } catch {
        // 容量超過等は無視
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [body, draftKey, mail, name, sage, title]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(max-width: 640px)").matches) {
      setMobileOpen(false);
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "post") return;
    return onQuote((num) => {
      setMobileOpen(true);
      setBody((prev) => {
        const prefix = prev.length === 0 || prev.endsWith("\n") ? "" : "\n";
        return `${prev}${prefix}>>${num}\n`;
      });
      textareaRef.current?.focus();
    });
  }, [mode]);

  const onToken = useCallback((value: string) => setToken(value), []);

  const submit = async () => {
    // 新しい送信を始めたら、前回の「投稿しました」トーストを消す。
    // 429 等のエラー Notice と成功トーストが同時に残ると状態が矛盾して見える。
    toast.clear();
    setError(null);
    if (disabled) return;
    if (mode === "thread" && title.trim().length === 0) {
      setError("スレタイを入力してください");
      return;
    }
    if (body.trim().length === 0) {
      setError("本文を入力してください");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "thread") {
        const result = await api.createThread(boardSlug, {
          title: title.trim(),
          body,
          name: name.trim() || undefined,
          mail: mail.trim() || undefined,
          mode: threadMode || undefined,
          turnstileToken: token || undefined,
        });
        recordWrite({
          key: `t:${result.threadId}`,
          path: `/b/${boardSlug}/t/${result.threadId}`,
          slug: boardSlug,
          threadId: result.threadId,
          title: title.trim(),
        });
        onPosted(result);
        setTitle("");
        setBody("");
      } else if (threadId) {
        const result = await api.createPost(threadId, {
          name: name.trim() || undefined,
          mail: mail.trim() || (sage ? "sage" : undefined),
          body,
          sage,
          attachments: attachments.map((item) => item.id).filter((id): id is string => Boolean(id)),
          turnstileToken: token || undefined,
        });
        recordWrite({
          key: `t:${threadId}`,
          path: `/b/${boardSlug}/t/${threadId}`,
          slug: boardSlug,
          threadId,
          title: threadTitle ?? "",
        });
        onPosted({ post: result.post, threadId });
        setBody("");
        setAttachments([]);
      }
      setResetKey((value) => value + 1);
      setToken("");
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(draftKey);
        setDraftSavedAt(null);
      }
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        if (cause.code === "TURNSTILE_FAILED" || cause.status === 403) {
          setResetKey((value) => value + 1);
        }
      } else {
        setError(cause instanceof Error ? cause.message : "投稿に失敗しました");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const form = (
    <form
      className={`oc-form${floating ? " oc-form-floating" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!mobileOpen ? (
        <button type="button" className="oc-form-openbar" onClick={() => setMobileOpen(true)}>
          {mode === "thread" ? "✏ スレッドを作成" : "✏ 書き込む"}
        </button>
      ) : (
      <div className="oc-form-inner">
        {disabled ? <Notice kind="warn">{disabledReason ?? "現在このスレには投稿できません。"}</Notice> : null}
        {mode === "thread" ? (
          <div className="oc-form-row">
            <input
              className="oc-input"
              placeholder="スレタイ（例：雑談スレ part1）"
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              disabled={disabled}
              aria-label="スレタイ"
            />
            <select
              className="oc-select"
              style={{ width: 190 }}
              value={threadMode}
              onChange={(event) => setThreadMode(event.target.value)}
              aria-label="スレモード"
            >
              {THREAD_MODES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="oc-form-row">
          <input
            className="oc-input oc-input-sm oc-form-name"
            placeholder="名前（省略可）"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            disabled={disabled}
            aria-label="名前"
          />
          {showMail ? (
            <input
              className="oc-input oc-input-sm oc-form-mail"
              placeholder="メール（sage 等）"
              value={mail}
              maxLength={60}
              onChange={(event) => setMail(event.target.value)}
              disabled={disabled}
              aria-label="メール"
            />
          ) : (
            <button type="button" className="oc-btn oc-btn-sm" onClick={() => setShowMail(true)} disabled={disabled}>
              メール欄
            </button>
          )}
          <label className="oc-check">
            <input type="checkbox" checked={sage} onChange={(event) => setSage(event.target.checked)} disabled={disabled} />
            sage
          </label>
          {onOpenTsubuyaki ? (
            <button type="button" className="oc-icon-btn" onClick={onOpenTsubuyaki} title="つぶやき（流れるコメント）を開く">
              💬 つぶやき
            </button>
          ) : null}
          {mode === "post" ? (
            <button
              type="button"
              className={`oc-icon-btn${floating ? " on" : ""}`}
              onClick={() => setFloating((value) => !value)}
              title="投稿欄を浮かせる"
            >
              📌 浮き窓
            </button>
          ) : null}
        </div>

        <textarea
          ref={textareaRef}
          className="oc-textarea"
          rows={4}
          placeholder="本文。レス番号クリックで >>n を引用。||ネタバレ|| も使えます。"
          value={body}
          maxLength={4096}
          onChange={(event) => setBody(event.target.value)}
          disabled={disabled}
          aria-label="本文"
        />

        {attachments.length > 0 ? (
          <div className="oc-ng-list">
            {attachments.map((item) => (
              <span key={item.url} className="oc-ng-item">
                📎 {item.name ?? "添付"}
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((other) => other.url !== item.url))}
                  aria-label="添付を削除"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="oc-form-tools" style={{ marginTop: 4 }}>
          <UploaderMount
            ref={uploaderRef}
            boardSlug={boardSlug}
            boardId={boardId}
            disabled={disabled}
            compact
            turnstile={turnstile}
            onUploaded={(refs) => setAttachments((prev) => [...prev, ...refs])}
          />
          <button
            type="button"
            className="oc-icon-btn"
            onClick={() => setOekakiOpen(true)}
            disabled={disabled}
            title="お絵かきエディタ"
          >
            🖌 お絵かき
          </button>
          {draftSavedAt ? <span className="oc-draft-note">下書き保存済み</span> : null}
          <button
            type="button"
            className="oc-icon-btn oc-form-collapse"
            onClick={() => setMobileOpen(false)}
            title="投稿欄を閉じる"
            aria-label="投稿欄を閉じる"
          >
            ▲ 閉じる
          </button>
        </div>

        <Button
          type="submit"
          variant="primary"
          size="block"
          className="oc-form-submit"
          disabled={disabled || submitting}
        >
          {submitting ? "送信中…" : mode === "thread" ? "スレを立てる" : "投稿する"}
        </Button>

        {error ? <Notice kind="error">{error}</Notice> : null}
        {needsTurnstile ? (
          <div className="oc-mt">
            <TurnstileWidget onToken={onToken} resetKey={resetKey} compact />
          </div>
        ) : null}
      </div>
      )}

      <OekakiEditor
        open={oekakiOpen}
        onClose={() => setOekakiOpen(false)}
        uploader={uploaderRef}
        onUploaded={(ref) => setAttachments((prev) => [...prev, ref])}
      />
    </form>
  );

  return form;
}