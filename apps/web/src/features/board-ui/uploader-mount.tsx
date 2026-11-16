"use client";

// アップローダの差し込み点。
// WP4 提供の `components/uploader/*`（`<UploaderButton>`）を投稿フォーム・お絵かきに組み込む。
// ref API は WP4 の `UploaderButtonHandle` と構造互換（`uploadFiles` / `uploadBlob`）。
//
// Turnstile（C-1 / F-06）: ウィジェットはフォーム側に 1 個だけ置き、ここではそのトークンを
// 借りる。以前はアップローダが自前のウィジェットも描いていたため、投稿フォーム 1 つに
// 2 個のウィジェットが並び、片方だけ成功すると送信できない状態になっていた。

import { forwardRef, type Ref } from "react";
import { UploaderButton, type UploadedAttachment, type UploaderButtonHandle } from "@/components/uploader";
import type { TurnstileTokenController } from "./turnstile";
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
  /** フォームが持つ Turnstile コントローラ（トークンの出どころを 1 つに揃える）。 */
  turnstile: TurnstileTokenController;
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

export const UploaderMount = forwardRef<UploaderHandle, UploaderProps>(function UploaderMount(
  { boardSlug, boardId, onUploaded, compact = false, disabled = false, turnstile },
  ref,
) {
  return (
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
      getTurnstileToken={() => turnstile.take({ forUpload: true })}
    />
  );
});