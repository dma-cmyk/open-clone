"use client";

// アップローダ本体（ドラッグ&ドロップ / 貼り付け / 進捗 / 保存先選択）。
// ファイル本体は Cloudflare に保存しない。確認できるのは proxy 中継（Catbox 等）か direct（Cloudinary 等）のみ。
// WP2 の投稿フォームは `<UploaderButton ref={...} boardId={...} onUploaded={...} />` で差し込む。

import { isBlockedUploadFilename, type UploaderAdapterInfo } from "shared";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  UploadApiError,
  listUploaderAdapters,
  uploadFile,
  type AdapterListResult,
} from "./api";
import { contentTypeMatches, extensionOfName, formatBytes } from "./format";
import type {
  UploadFailure,
  UploadingFile,
  UploadedAttachment,
  UploaderButtonHandle,
} from "./types";

const ADAPTER_STORAGE_KEY = "oc-uploader-adapter";
const DEFAULT_ACCEPT = "image/*,video/*,audio/*,text/plain,.txt,.md,.csv,.json,.js,.ts,.css,.html";

export interface UploaderButtonProps {
  boardId?: number;
  boardSlug?: string;
  purpose?: string;
  /** 保存先を固定する（省略時は板/サイト既定 + ユーザー選択） */
  adapter?: string | null;
  disabled?: boolean;
  compact?: boolean;
  accept?: string;
  className?: string;
  /** 保存先セレクトを出すか（既定 true） */
  showAdapterSelect?: boolean;
  /** クリップボードへの画像貼り付けで自動アップロード（既定 true） */
  enablePaste?: boolean;
  label?: string;
  /**
   * Turnstile が必要な板で、prepare 直前にトークンを取得する。
   * 省略時はトークンを送らない（板/サイト設定で不要な場合）。
   */
  getTurnstileToken?: () => Promise<string | undefined>;
  /** Turnstile トークンは 1 回限り。prepare 後に呼ばれ、ウィジェットの再取得に使う。 */
  onTurnstileConsumed?: () => void;
  onUploaded?: (attachments: UploadedAttachment[]) => void;
  onError?: (message: string) => void;
  onProgress?: (file: UploadingFile) => void;
}

interface FailureEntry extends UploadFailure {
  linkRequired?: boolean;
}

/** 送信前のローカル検証。サーバ側（`services/uploads/validation.ts`）が最終判定を持つ。 */
function validateLocally(file: File, adapter: UploaderAdapterInfo | null): string | null {
  if (file.size <= 0) return "空のファイルはアップロードできません";
  if (isBlockedUploadFilename(file.name)) {
    return `この拡張子（.${extensionOfName(file.name)}）はアップロードできません`;
  }
  if (!adapter) return null;
  if (file.size > adapter.maxBytes) {
    return `ファイルが大きすぎます（${adapter.label} の上限は ${formatBytes(adapter.maxBytes)}）`;
  }
  const contentType = file.type || "application/octet-stream";
  if (!contentTypeMatches(contentType, adapter.types)) {
    return `${adapter.label} は ${contentType} を受け付けません`;
  }
  return null;
}

function describeError(cause: unknown): FailureEntry {
  if (cause instanceof UploadApiError) {
    if (cause.code === "GITHUB_LINK_REQUIRED" || cause.code === "LINK_REQUIRED") {
      return { name: "", message: cause.message, linkRequired: true };
    }
    return { name: "", message: cause.message };
  }
  if (cause instanceof Error) return { name: "", message: cause.message };
  return { name: "", message: "アップロードに失敗しました" };
}

const PHASE_LABEL: Record<UploadingFile["phase"], string> = {
  preparing: "準備中",
  uploading: "送信中",
  committing: "確定中",
};

export const UploaderButton = forwardRef<UploaderButtonHandle, UploaderButtonProps>(function UploaderButton(
  {
    boardId,
    purpose,
    adapter: forcedAdapter = null,
    disabled = false,
    compact = false,
    accept,
    className,
    showAdapterSelect = true,
    enablePaste = true,
    label,
    getTurnstileToken,
    onTurnstileConsumed,
    onUploaded,
    onError,
    onProgress,
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [adapters, setAdapters] = useState<AdapterListResult | null>(null);
  const [adapterError, setAdapterError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [uploading, setUploading] = useState<UploadingFile | null>(null);
  const [failures, setFailures] = useState<FailureEntry[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const busy = uploading !== null;

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(ADAPTER_STORAGE_KEY);
      if (stored) setSelected(stored);
    } catch {
      // プライベートモード等で localStorage が使えない場合は既定のまま
    }
  }, []);

  useEffect(() => {
    let alive = true;
    listUploaderAdapters({ boardId })
      .then((result) => {
        if (alive) setAdapters(result);
      })
      .catch((cause: unknown) => {
        if (alive) setAdapterError(cause instanceof Error ? cause.message : "保存先一覧を取得できません");
      });
    return () => {
      alive = false;
    };
  }, [boardId]);

  const effectiveAdapter = forcedAdapter ?? (selected.length > 0 ? selected : null);
  const selectedInfo = useMemo(
    () => adapters?.items.find((item) => item.id === effectiveAdapter) ?? null,
    [adapters, effectiveAdapter],
  );

  const uploadFiles = useCallback(
    async (files: File[]): Promise<UploadedAttachment[]> => {
      if (disabled || files.length === 0) return [];
      setFailures([]);
      setDoneCount(0);
      const uploaded: UploadedAttachment[] = [];
      const errors: FailureEntry[] = [];

      for (const file of files) {
        const problem = validateLocally(file, selectedInfo);
        if (problem) {
          errors.push({ name: file.name, message: problem });
          setFailures([...errors]);
          continue;
        }
        const initial: UploadingFile = { name: file.name, size: file.size, phase: "preparing", loaded: 0 };
        setUploading(initial);
        onProgress?.(initial);
        try {
          const turnstileToken = await getTurnstileToken?.();
          const result = await uploadFile({
            file,
            adapter: effectiveAdapter,
            boardId,
            purpose,
            turnstileToken,
            onProgress: (phase, loaded) => {
              const next: UploadingFile = { name: file.name, size: file.size, phase, loaded };
              setUploading(next);
              onProgress?.(next);
            },
          });
          uploaded.push(result);
        } catch (cause) {
          const entry = describeError(cause);
          errors.push({ ...entry, name: file.name });
          setFailures([...errors]);
        } finally {
          // トークンは prepare で消費済み（失敗時も再取得させる）。
          onTurnstileConsumed?.();
        }
      }

      setUploading(null);
      if (uploaded.length > 0) {
        setDoneCount(uploaded.length);
        onUploaded?.(uploaded);
      }
      if (errors.length > 0) {
        const message = errors[0]?.message ?? "アップロードに失敗しました";
        onError?.(message);
      }
      return uploaded;
    },
    [boardId, disabled, effectiveAdapter, getTurnstileToken, onTurnstileConsumed, onError, onProgress, onUploaded, purpose, selectedInfo],
  );

  useImperativeHandle(
    ref,
    () => ({
      uploadFiles,
      async uploadBlob(blob, filename) {
        const file = new File([blob], filename, { type: blob.type || "image/png" });
        const results = await uploadFiles([file]);
        return results[0] ?? null;
      },
    }),
    [uploadFiles],
  );

  useEffect(() => {
    if (!enablePaste || disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      // テキストも同時に入っている場合は本文への貼り付けを優先する（画像だけの貼り付けを拾う）
      if ((event.clipboardData?.getData("text/plain") ?? "").length > 0) return;
      event.preventDefault();
      void uploadFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [disabled, enablePaste, uploadFiles]);

  const pick = () => {
    if (!disabled) inputRef.current?.click();
  };

  const changeAdapter = (value: string) => {
    setSelected(value);
    try {
      if (value) window.localStorage.setItem(ADAPTER_STORAGE_KEY, value);
      else window.localStorage.removeItem(ADAPTER_STORAGE_KEY);
    } catch {
      // 保存できなくても動作に影響しない
    }
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void uploadFiles(files);
  };

  const defaultLabel = uploading ? `${PHASE_LABEL[uploading.phase]}…` : label ?? "画像/ファイル";

  return (
    <div
      className={[className, compact ? "oc-inline" : "oc-stack"].filter(Boolean).join(" ")}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={drop}
      style={dragOver ? { outline: "2px dashed var(--oc-accent)", outlineOffset: 2, background: "var(--oc-panel-soft)" } : undefined}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={accept ?? DEFAULT_ACCEPT}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void uploadFiles(files);
        }}
      />
      <div className="oc-inline" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="oc-icon-btn" onClick={pick} disabled={disabled || busy} title="画像・動画・テキストを添付">
          🖼 {defaultLabel}
        </button>
        {showAdapterSelect && !forcedAdapter ? (
          <select
            className="oc-select"
            aria-label="保存先"
            value={selected}
            disabled={disabled || busy || adapters === null}
            onChange={(event) => changeAdapter(event.target.value)}
            title="ファイルの保存先を選択します（ファイル本体はこのサイトに保存されません）"
          >
            <option value="">自動（既定: {adapters?.defaultAdapter ?? "catbox"}）</option>
            {(adapters?.items ?? []).map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available} title={item.reason ?? item.label}>
                {item.label}
                {item.available ? "" : "（利用不可）"}
                {item.retentionSeconds ? `・${Math.round(item.retentionSeconds / 3600)}時間で消去` : ""}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {!compact ? (
        <span className="oc-note">
          ドラッグ&ドロップ・クリップボード貼り付けも可。
          {selectedInfo ? adapterNoteOf(selectedInfo) : "ファイル本体はこのサイトに保存されません。"}
        </span>
      ) : null}
      {adapterError ? <div className="oc-note">保存先一覧を取得できません: {adapterError}</div> : null}
      {uploading ? (
        <div role="status" className="oc-note">
          <div className="oc-row-between">
            <span>
              {PHASE_LABEL[uploading.phase]}: {uploading.name}（{formatBytes(uploading.size)}）
            </span>
            <span>{Math.round((uploading.loaded / Math.max(1, uploading.size)) * 100)}%</span>
          </div>
          <div style={{ height: 4, background: "var(--oc-border)", marginTop: 3 }} aria-hidden>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.round((uploading.loaded / Math.max(1, uploading.size)) * 100))}%`,
                background: "var(--oc-accent)",
              }}
            />
          </div>
        </div>
      ) : null}
      {!uploading && doneCount > 0 ? <span className="oc-note oc-ok">{doneCount} 件をアップロードしました</span> : null}
      {failures.map((failure, index) => (
        <span key={`${failure.name}-${index}`} className="oc-error" role="alert">
          {failure.name ? `${failure.name}: ` : ""}
          {failure.message}
          {failure.linkRequired ? (
            <>
              {" "}
              <a href="/account/github">GitHub 連携へ</a>
            </>
          ) : null}
        </span>
      ))}
    </div>
  );
});

/** 選択中の保存先の性質を短く示す。 */
function adapterNoteOf(adapter: UploaderAdapterInfo): string {
  if (adapter.retentionSeconds) {
    const hours = Math.round(adapter.retentionSeconds / 3600);
    return `${adapter.label}（約 ${hours} 時間で消去）`;
  }
  if (adapter.requiresGithub) return `${adapter.label}（GitHub 連携が必要）`;
  return `${adapter.label}（上限 ${formatBytes(adapter.maxBytes)}）`;
}