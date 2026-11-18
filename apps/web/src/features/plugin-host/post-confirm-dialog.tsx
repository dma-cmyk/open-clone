"use client";

// プラグイン RPC `data.post.create` のホスト確認 UI。
//
// プラグインは何を書き込むかを自由に決められるため、ホストが「プラグイン『名前』が
// 次の内容で書き込みます」と名前欄・本文を見せてから書き込む（黙って書き込ませない）。
// 板が Turnstile を必要とするときは、このモーダルの中に既存の TurnstileWidget を置き、
// 得られたトークンをホストが投稿に添える。トークンはプラグインには渡さない。
// 取得済みのトークンは 1 回限りなので、失敗時は resetKey を進めて取り直す。

import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Notice } from "@/components/ui";
import { TurnstileWidget } from "@/features/account/turnstile";
import { pluginApi } from "./api";

export interface PluginPostConfirmRequest {
  pluginName: string;
  name: string;
  body: string;
  boardSlug?: string;
  boardId?: number;
  /** Turnstile で失敗した後の再確認のとき、直前のエラーを表示する */
  errorMessage?: string;
}

export interface PluginPostConfirmDecision {
  confirmed: boolean;
  turnstileToken?: string;
}

export function PluginPostConfirmDialog({
  request,
  onDone,
}: {
  request: PluginPostConfirmRequest;
  onDone: (decision: PluginPostConfirmDecision) => void;
}) {
  const [required, setRequired] = useState<boolean | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  // 板が Bot 確認を必要とするか（off ならウィジェットを出さない）。
  // 判定できないときは安全側（必要）に倒さず、サーバーの 400 をそのまま見せる。
  useEffect(() => {
    let alive = true;
    if (request.boardSlug === undefined && request.boardId === undefined) {
      setRequired(false);
      return;
    }
    pluginApi
      .turnstileStatus({ slug: request.boardSlug, boardId: request.boardId })
      .then((status) => {
        if (alive) setRequired(status.required);
      })
      .catch(() => {
        if (alive) setRequired(false);
      });
    return () => {
      alive = false;
    };
  }, [request.boardSlug, request.boardId]);

  const acceptToken = useCallback((value: string | null) => {
    setToken(value);
    if (value) setUnavailable(false);
  }, []);
  const onUnavailable = useCallback(() => {
    // ウィジェットを用意できないときはボタンを閉じたままにしない（送信してサーバーの
    // エラーを見せる）。次の試行では resetKey を進めて取り直す。
    setUnavailable(true);
  }, []);

  const needsToken = required === true;
  const canSubmit = required !== null && !busy && (!needsToken || token !== null || unavailable);

  const confirm = () => {
    if (!canSubmit) return;
    setBusy(true);
    onDone({ confirmed: true, turnstileToken: needsToken ? token ?? undefined : undefined });
  };

  return (
    <Modal
      open
      title="プラグインからの書き込み"
      onClose={() => {
        if (!busy) onDone({ confirmed: false });
      }}
      width={440}
      footer={
        <>
          <Button onClick={() => onDone({ confirmed: false })} disabled={busy}>
            やめる
          </Button>
          <Button variant="primary" onClick={confirm} disabled={!canSubmit}>
            {busy ? "書き込み中…" : "書き込む"}
          </Button>
        </>
      }
    >
      <p className="oc-small" style={{ marginTop: 0 }}>
        プラグイン「{request.pluginName}」が次の内容で書き込みます。
      </p>
      {request.errorMessage ? <Notice kind="error">{request.errorMessage}</Notice> : null}
      <dl className="oc-plugin-confirm-fields">
        <dt>名前欄</dt>
        <dd data-testid="plugin-confirm-name">{request.name.length > 0 ? request.name : "（なし）"}</dd>
        <dt>本文</dt>
        <dd data-testid="plugin-confirm-body">{request.body}</dd>
      </dl>
      {needsToken ? (
        <div style={{ marginTop: 8 }}>
          <p className="oc-tiny oc-muted" style={{ margin: "0 0 4px" }}>
            この板では書き込みに Bot 確認が必要です。
          </p>
          <TurnstileWidget onToken={acceptToken} onUnavailable={onUnavailable} resetKey={resetKey} />
          {unavailable ? (
            <Notice kind="error">
              Bot 確認を読み込めませんでした。「書き込む」で再試行するか、時間をおいてやり直してください。
            </Notice>
          ) : null}
          <Button
            size="sm"
            onClick={() => {
              setToken(null);
              setUnavailable(false);
              setResetKey((value) => value + 1);
            }}
            disabled={busy}
          >
            確認をやり直す
          </Button>
        </div>
      ) : null}
      <style>{`
        .oc-plugin-confirm-fields { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 0; }
        .oc-plugin-confirm-fields dt { font-size: 12px; color: var(--oc-muted, #666); }
        .oc-plugin-confirm-fields dd { margin: 0; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
      `}</style>
    </Modal>
  );
}