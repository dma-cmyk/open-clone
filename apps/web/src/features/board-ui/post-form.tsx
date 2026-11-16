"use client";

// 投稿フォーム（レス / スレ立て）。Turnstile、アップローダ（WP4）、お絵かきを統合する。
import { useEffect, useMemo, useRef, useState } from "react";
import { POST_BODY_MAX_BYTES } from "shared";
import { api, ApiError } from "./api";
import { Button, Notice, useToast } from "@/components/ui";
import { OekakiEditor } from "./oekaki-editor";
import { TurnstileWidget, useTurnstileToken } from "./turnstile";
import { UploaderMount, type UploaderHandle } from "./uploader-mount";
import { onQuote } from "./quote-bus";
import { settingsStore } from "./settings";
import { getTurnstilePass, setTurnstilePass, useTurnstilePass } from "./turnstile-pass-store";
import { recordWrite } from "./history";
import { THREAD_MODES, type AttachmentRef, type Post } from "./types";

// API の本文上限は UTF-8 バイト数（shared の POST_BODY_MAX_BYTES = 4096。pipeline.ts が
// TextEncoder の長さで判定する）。日本語は 1 文字あたり約 3 バイトなので、文字数ではなく
// バイト数で数えないと送信直前の 413 と食い違う。
const BODY_MAX_BYTES = POST_BODY_MAX_BYTES;

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 文字数と UTF-8 バイト数（API の上限判定と同じ数え方）を表示用に持つ。
  const bodyBytes = useMemo(() => new TextEncoder().encode(body).length, [body]);
  const [showMail, setShowMail] = useState(false);
  const [oekakiOpen, setOekakiOpen] = useState(false);
  const [floating, setFloating] = useState(settingsStore.get().behavior.floatForm);
  // スマホでは投稿欄を「書き込む」バー1行に畳む（タップで展開）。
  const [mobileOpen, setMobileOpen] = useState(true);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploaderRef = useRef<UploaderHandle>(null);
  const toast = useToast();

  // サーバーが「この端末は期限内の確認済み」と答えていれば、ウィジェットもトークンも不要
  // （報告書 81 / A・B。レスだけが対象で、スレ立ては常に確認する）。
  // 板ごとの共有状態（つぶやきで確認済みになった場合も反映される。R82-04）。
  const sharedPass = useTurnstilePass(boardSlug);
  // `always` の板では省略しない（古い共有 pass が残っていても使わない。レビュー 84 / R82-03）。
  const turnstilePassed = turnstile === "anonymous" && sharedPass.passed;
  // 期限（秒）。過ぎたら「確認済み」を捨てて部品を戻す（レビュー 82 / R82-03）。
  const turnstilePassExpiresAt = sharedPass.expiresAt;
  const setTurnstilePassed = (passed: boolean) => {
    setTurnstilePass(boardSlug, { passed, expiresAt: passed ? getTurnstilePass(boardSlug).expiresAt : null });
  };
  const setTurnstilePassExpiresAt = (expiresAt: number | null) => {
    setTurnstilePass(boardSlug, { passed: expiresAt !== null ? true : getTurnstilePass(boardSlug).passed, expiresAt });
  };
  useEffect(() => {
    if (mode !== "post" || turnstile !== "anonymous") return;
    let alive = true;
    api
      .getTurnstileStatus(boardSlug)
      .then((status) => {
        if (!alive) return;
        setTurnstilePassed(status.passed);
        setTurnstilePassExpiresAt(status.passExpiresAt);
      })
      .catch(() => {
        /* 取得できなければ従来どおり確認を出す */
      });
    return () => {
      alive = false;
    };
  }, [boardSlug, mode, turnstile]);

  // 期限が来たら「確認済み」を捨てる（部品が戻る）。
  useEffect(() => {
    if (!turnstilePassed || !turnstilePassExpiresAt) return;
    const remainMs = turnstilePassExpiresAt * 1000 - Date.now();
    if (remainMs <= 0) {
      setTurnstilePassed(false);
      setTurnstilePassExpiresAt(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setTurnstilePassed(false);
      setTurnstilePassExpiresAt(null);
    }, remainMs);
    return () => window.clearTimeout(timer);
  }, [turnstilePassed, turnstilePassExpiresAt]);

  // Turnstile はフォームで 1 個だけ。投稿もアップロードも同じトークン供給元を使う（F-06）。
  const turnstileToken = useTurnstileToken(turnstile, mode === "post" && turnstilePassed);
  const needsTurnstile = turnstileToken.needed;

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

  // 下書きの自動保存。空にした場合も「空」を保存する（旧文が再読み込みで復活しない: F-05）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      const empty = !body && !title && !name && !mail;
      try {
        if (empty) {
          window.localStorage.removeItem(draftKey);
          setDraftSavedAt(null);
          return;
        }
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
    if (bodyBytes > BODY_MAX_BYTES) {
      setError(`本文が長すぎます（${bodyBytes} / 上限 ${BODY_MAX_BYTES} バイト）。約 ${bodyBytes - BODY_MAX_BYTES} バイト減らしてください。`);
      return;
    }
    setSubmitting(true);
    try {
      // Bot 確認が要る板では、ウィジェットの成功を待ってから送る（空トークンで 400 にしない）。
      const token = await turnstileToken.take();
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
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(draftKey);
        setDraftSavedAt(null);
      }
      // 送信できた＝確認済みが記録された（または省略された）。次回のために状態を取り直す。
      if (mode === "post" && turnstile === "anonymous") {
        void api
          .getTurnstileStatus(boardSlug)
          .then((status) => {
            setTurnstilePassed(status.passed);
            setTurnstilePassExpiresAt(status.passExpiresAt);
          })
          .catch(() => undefined);
      }
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(cause.message);
        // サーバー側で取消・期限切れになっていたら、確認済みを捨てて部品を戻す（R82-03）。
        if (cause.code === "TURNSTILE_FAILED" || cause.status === 403) {
          // TURNSTILE_FAILED は「確認が必要」の意味なので、ローカルの省略状態は捨てる
          // （ここで状態を取り直すと、サーバー側の取消が遅れている場合に再び隠れてしまう）。
          setTurnstilePassed(false);
          setTurnstilePassExpiresAt(null);
        } else if (mode === "post" && turnstile === "anonymous") {
          // NG（400 VALIDATION）や 429 でもサーバーは確認済みを取り消している。
          // 画面を追随させるため状態を取り直す（レビュー 84 / R82-03）。
          void api
            .getTurnstileStatus(boardSlug)
            .then((status) => {
              setTurnstilePassed(status.passed);
              setTurnstilePassExpiresAt(status.passExpiresAt);
            })
            .catch(() => undefined);
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
          onChange={(event) => setBody(event.target.value)}
          disabled={disabled}
          aria-label="本文"
        />
        {/* 文字数と上限（API は UTF-8 バイトで 4096 まで）。超過は送信前から赤字で警告する。 */}
        <div className={`oc-form-count${bodyBytes > BODY_MAX_BYTES ? " over" : ""}`} aria-live="polite">
          <span>
            {body.length} 文字 / {bodyBytes} バイト（上限 {BODY_MAX_BYTES} バイト）
          </span>
          {bodyBytes > BODY_MAX_BYTES ? <strong>上限を超えています（送信できません）</strong> : null}
        </div>

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
            turnstile={turnstileToken}
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

        {/* Bot 確認はフォームに 1 個だけ（投稿・添付で同じトークンを使い回さない）。
            投稿が省略されている間も、添付にはトークンが必要なのでウィジェットは描いておく
            （appearance: interaction-only なので普段は見えない。レビュー 82 / R82-05）。 */}
        {needsTurnstile || turnstileToken.uploadWidget ? (
          <div className="oc-turnstile-row">
            <TurnstileWidget
              onToken={turnstileToken.accept}
              onInvalidate={turnstileToken.invalidate}
              resetKey={turnstileToken.resetKey}
            />
          </div>
        ) : null}

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