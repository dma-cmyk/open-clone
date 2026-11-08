"use client";

// アップローダの差し込み点。
// WP4 提供の `components/uploader/*`（`<UploaderButton>`）を投稿フォーム・お絵かきに組み込む。
// ref API は WP4 の `UploaderButtonHandle` と構造互換（`uploadFiles` / `uploadBlob`）。
//
// Turnstile（C-1）: 投稿フォームと同じく板設定とログイン状態で要否を決め、必要な板では
// アップロード用のウィジェットを表示して prepare にトークンを渡す。トークンは 1 回限りなので
// prepare ごとにリセットし、次のファイル／再試行に備える。

import { forwardRef, useCallback, useEffect, useRef, useState, type Ref } from "react";
import { UploaderButton, type UploadedAttachment, type UploaderButtonHandle } from "@/components/uploader";
import { api } from "./api";
import { TurnstileWidget } from "./turnstile";
import type { AttachmentRef } from "./types";

export interface UploaderHandle {
  uploadFiles: (files: File[]) => Promise<AttachmentRef[]>;
  uploadBlob: (blob: Blob, filename: string) => Promise<AttachmentRef | null>;
}

interface UploaderProps {
  boardSlug?: string;
  boardId?: number;
  onUploaded?: (refs: AttachmentRef[]) => void;
  compact?: boolean;
  disabled?: boolean;
  /** 板設定の Turnstile 方針（通常投稿と同じ）。 */
  turnstile?: "off" | "anonymous" | "always";
}

function toAttachmentRef(uploaded: UploadedAttachment): AttachmentRef {
  return {
    id: uploaded.id,
    url: uploaded.url,
    contentType: uploaded.contentType,
    size: uploaded.size,
    name: uploaded.name ?? uploaded.filename,
  };
}

/** ウィジェット要否の非同期判定（判定中のアップロードを待たせる）。 */
interface TurnstileDecision {
  promise: Promise<boolean>;
  resolve: (needed: boolean) => void;
}

/** ウィジェットの読み込み・解決を待つ上限。超えたら再試行を促す。 */
const TOKEN_TIMEOUT_MS = 20_000;

export const UploaderMount = forwardRef<UploaderHandle, UploaderProps>(function UploaderMount(
  { boardSlug, boardId, onUploaded, compact = false, disabled = false, turnstile = "anonymous" },
  ref,
) {
  const [needsTurnstile, setNeedsTurnstile] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const needsTurnstileRef = useRef(false);
  const decisionRef = useRef<TurnstileDecision | null>(null);
  const tokenRef = useRef("");
  const waitersRef = useRef<Array<{ resolve: (token: string) => void; reject: (cause: Error) => void; timer: number }>>([]);

  // 通常投稿と同じ判定: off は不要、always は常に、anonymous は未ログインのみ。
  // 判定中にアップロードが始まっても undefined を返さないよう、判定は promise で待たせる。
  useEffect(() => {
    const decision = Promise.withResolvers<boolean>();
    decisionRef.current = decision;
    const settle = (needed: boolean) => {
      needsTurnstileRef.current = needed;
      setNeedsTurnstile(needed);
      decision.resolve(needed);
    };
    if (turnstile === "off") {
      settle(false);
      return;
    }
    if (turnstile === "always") {
      settle(true);
      return;
    }
    let alive = true;
    api
      .getSession()
      .then((session) => {
        if (alive) settle(!session);
      })
      .catch(() => {
        if (alive) settle(false);
      });
    return () => {
      alive = false;
      decision.resolve(needsTurnstileRef.current);
      needsTurnstileRef.current = false;
    };
  }, [turnstile]);

  const onToken = useCallback((value: string) => {
    tokenRef.current = value;
    if (!value) return;
    // 同時アップロードでは 1 トークン 1 回。先頭の待ち手だけを解決する。
    const waiter = waitersRef.current.shift();
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    waiter.resolve(value);
  }, []);

  /** prepare 用のトークンを 1 つ取り出す（消費済みならウィジェットの再発行を待つ）。 */
  const takeTurnstileToken = useCallback(async (): Promise<string | undefined> => {
    const needed = decisionRef.current ? await decisionRef.current.promise : needsTurnstileRef.current;
    if (!needed) return undefined;
    const current = tokenRef.current;
    if (current) {
      tokenRef.current = "";
      return current;
    }
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const timer = window.setTimeout(() => {
      waitersRef.current = waitersRef.current.filter((entry) => entry.timer !== timer);
      reject(new Error("Bot 確認（Turnstile）を完了してからアップロードしてください"));
    }, TOKEN_TIMEOUT_MS);
    waitersRef.current.push({ resolve, reject, timer });
    return promise;
  }, []);

  const consumed = useCallback(() => {
    tokenRef.current = "";
    if (needsTurnstileRef.current) setResetKey((value) => value + 1);
  }, []);

  useEffect(
    () => () => {
      for (const waiter of waitersRef.current) window.clearTimeout(waiter.timer);
      waitersRef.current = [];
    },
    [],
  );

  return (
    <>
      <UploaderButton
        ref={ref as Ref<UploaderButtonHandle>}
        boardId={boardId}
        boardSlug={boardSlug}
        purpose="post"
        disabled={disabled}
        compact={compact}
        showAdapterSelect={!compact}
        enablePaste
        onUploaded={(uploaded) => onUploaded?.(uploaded.map(toAttachmentRef))}
        getTurnstileToken={takeTurnstileToken}
        onTurnstileConsumed={consumed}
      />
      {needsTurnstile ? (
        <div className="oc-upload-turnstile">
          <TurnstileWidget onToken={onToken} resetKey={resetKey} compact />
        </div>
      ) : null}
    </>
  );
});