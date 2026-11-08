// アップローダの API クライアント（`/v1/uploads/*`）。
// 送信は XHR を使う（fetch ではアップロード進捗が取れないため）。ファイル本体は Cloudflare に保存されず、
// proxy-stream では Worker が外部サービスへ中継するだけ（DESIGN §9.1）。

import type { AttachmentDto, UploaderAdapterInfo } from "shared";
import type { UploadedAttachment } from "./types";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

/** uploads API のエラー。`details` は連携誘導などの追加情報をそのまま運ぶ。 */
export class UploadApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "UploadApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get linkRequired(): boolean {
    return this.code === "GITHUB_LINK_REQUIRED" || this.status === 403;
  }
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
  details?: unknown;
}

export interface UploadPreparePlan {
  mode: "direct" | "proxy-stream";
  url?: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  formFields?: Record<string, string>;
  fileField?: string;
  resultType?: "json" | "text";
  proxyPath?: string;
}

export interface UploadPrepareResult {
  ticketId: string;
  adapter: string;
  mode: "direct" | "proxy-stream";
  plan: UploadPreparePlan;
  maxBytes: number;
  contentType: string;
  uploadToken?: string;
  expiresAt: number;
}

export interface AdapterListResult {
  items: UploaderAdapterInfo[];
  defaultAdapter: string;
}

export interface UploadHistoryResult {
  items: AttachmentDto[];
  limitReached: boolean;
}

/** API のパスは `/v1/...` で返るが、web は同一オリジンの `/api/v1/...`（rewrites）を使う。 */
function resolveApiPath(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/v1") ? path.slice(3) : path;
  return `${API_BASE}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

function parseEnvelope(text: string, status: number): Envelope {
  let json: Envelope | null = null;
  try {
    json = JSON.parse(text) as Envelope;
  } catch {
    json = null;
  }
  if (!json || typeof json.ok !== "boolean") {
    throw new UploadApiError(status, "INVALID_RESPONSE", `API 応答が不正です（HTTP ${status}）`);
  }
  if (!json.ok) {
    throw new UploadApiError(status, json.code ?? "UNKNOWN", json.message ?? "エラーが発生しました", json.details);
  }
  return json;
}

async function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  let response: Response;
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    response = await fetch(resolveApiPath(path), {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
    });
  } catch (cause) {
    throw new UploadApiError(0, "NETWORK", cause instanceof Error ? cause.message : "ネットワークエラー");
  }
  const text = await response.text();
  return parseEnvelope(text, response.status).data as T;
}

interface XhrOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body: XMLHttpRequestBodyInit;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

/** XHR 送信。進捗イベント付きで、CORS 失敗も 1 つのエラー型に揃える。 */
function xhrSend(options: XhrOptions): Promise<{ status: number; text: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const xhr = new XMLHttpRequest();
  xhr.open(options.method, options.url, true);
  xhr.withCredentials = true;
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    xhr.setRequestHeader(key, value);
  }
  if (options.onProgress) {
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    };
  }
  const onAbort = () => xhr.abort();
  const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
  if (options.signal?.aborted) {
    reject(new UploadApiError(0, "ABORTED", "アップロードを中止しました"));
    return promise;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  xhr.onload = () => {
    cleanup();
    resolve({ status: xhr.status, text: xhr.responseText });
  };
  xhr.onerror = () => {
    cleanup();
    reject(new UploadApiError(0, "NETWORK", "アップロード先に接続できませんでした"));
  };
  xhr.onabort = () => {
    cleanup();
    reject(new UploadApiError(0, "ABORTED", "アップロードを中止しました"));
  };
  xhr.ontimeout = () => {
    cleanup();
    reject(new UploadApiError(0, "TIMEOUT", "アップロードがタイムアウトしました"));
  };
  xhr.send(options.body);
  return promise;
}

/** 利用可能なアダプタ一覧と既定アダプタ。 */
export function listUploaderAdapters(input?: { boardId?: number }): Promise<AdapterListResult> {
  const query = input?.boardId ? `?boardId=${encodeURIComponent(String(input.boardId))}` : "";
  return request<AdapterListResult>("GET", `/uploads/adapters${query}`);
}

export function prepareUpload(input: {
  filename: string;
  contentType: string;
  size: number;
  adapter?: string | null;
  boardId?: number;
  purpose?: string;
  /** 板が Turnstile を要求する場合のトークン（投稿と同じ `x-turnstile-token`）。 */
  turnstileToken?: string;
}): Promise<UploadPrepareResult> {
  return request<UploadPrepareResult>(
    "POST",
    "/uploads/prepare",
    {
      filename: input.filename,
      contentType: input.contentType,
      size: input.size,
      adapter: input.adapter ?? undefined,
      boardId: input.boardId,
      purpose: input.purpose,
    },
    input.turnstileToken ? { "x-turnstile-token": input.turnstileToken } : undefined,
  );
}

export function commitUpload(input: {
  ticketId: string;
  response?: unknown;
  externalUrl?: string;
  deleteUrl?: string;
}): Promise<UploadedAttachment> {
  return request<UploadedAttachment>("POST", "/uploads/commit", input);
}

export function listUploadHistory(input?: {
  limit?: number;
  boardId?: number;
  unattachedOnly?: boolean;
}): Promise<UploadHistoryResult> {
  const params = new URLSearchParams();
  params.set("limit", String(input?.limit ?? 50));
  if (input?.boardId) params.set("boardId", String(input.boardId));
  if (input?.unattachedOnly) params.set("unattached", "true");
  return request<UploadHistoryResult>("GET", `/uploads/history?${params.toString()}`);
}

export function deleteAttachment(id: string): Promise<{ id: string; deleted: boolean }> {
  return request<{ id: string; deleted: boolean }>("DELETE", `/uploads/${encodeURIComponent(id)}`);
}

export function getAttachment(id: string): Promise<AttachmentDto> {
  return request<AttachmentDto>("GET", `/uploads/${encodeURIComponent(id)}`);
}

/** テキスト閲覧用のプロキシ URL（CORS を返さない外部保存先のため Worker 経由）。 */
export function attachmentRawUrl(id: string): string {
  return resolveApiPath(`/uploads/${encodeURIComponent(id)}/raw`);
}

export interface UploadFileInput {
  file: File;
  adapter?: string | null;
  boardId?: number;
  purpose?: string;
  turnstileToken?: string;
  signal?: AbortSignal;
  onProgress?: (phase: "preparing" | "uploading" | "committing", loaded: number, total: number) => void;
}

/** 1 ファイルを prepare → （proxy 中継 | direct 送信）→ commit する。 */
export async function uploadFile(input: UploadFileInput): Promise<UploadedAttachment> {
  const { file } = input;
  const contentType = file.type || "application/octet-stream";
  input.onProgress?.("preparing", 0, file.size);

  const prepared = await prepareUpload({
    filename: file.name || "upload.bin",
    contentType,
    size: file.size,
    adapter: input.adapter ?? undefined,
    boardId: input.boardId,
    purpose: input.purpose,
    turnstileToken: input.turnstileToken,
  });
  if (file.size > prepared.maxBytes) {
    throw new UploadApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      `ファイルが大きすぎます（上限 ${prepared.maxBytes} バイト）`,
    );
  }

  let response: unknown;
  const plan = prepared.plan;
  if (prepared.mode === "proxy-stream") {
    if (!plan.proxyPath) throw new UploadApiError(500, "INVALID_PLAN", "proxy の送信先がありません");
    const sent = await xhrSend({
      method: "POST",
      url: resolveApiPath(plan.proxyPath),
      headers: {
        "content-type": contentType,
        ...(prepared.uploadToken ? { "x-upload-token": prepared.uploadToken } : {}),
      },
      body: file,
      signal: input.signal,
      onProgress: (loaded, total) => input.onProgress?.("uploading", loaded, total),
    });
    const envelope = parseEnvelope(sent.text, sent.status);
    response = envelope.data;
  } else {
    if (!plan.url) throw new UploadApiError(500, "INVALID_PLAN", "direct の送信先がありません");
    const headers: Record<string, string> = { ...(plan.headers ?? {}) };
    let body: XMLHttpRequestBodyInit;
    if (plan.formFields && Object.keys(plan.formFields).length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(plan.formFields)) form.append(key, value);
      form.append(plan.fileField ?? "file", file, file.name || "upload.bin");
      body = form;
    } else {
      body = file;
      headers["content-type"] = contentType;
    }
    const sent = await xhrSend({
      method: plan.method ?? "POST",
      url: plan.url,
      headers,
      body,
      signal: input.signal,
      onProgress: (loaded, total) => input.onProgress?.("uploading", loaded, total),
    });
    if (sent.status < 200 || sent.status >= 300) {
      throw new UploadApiError(
        sent.status,
        "UPLOAD_FAILED",
        `アップロード先が失敗を返しました（HTTP ${sent.status}）`,
      );
    }
    if (plan.resultType === "text") {
      response = sent.text;
    } else {
      try {
        response = JSON.parse(sent.text) as unknown;
      } catch {
        response = sent.text;
      }
    }
  }

  input.onProgress?.("committing", file.size, file.size);
  return commitUpload({ ticketId: prepared.ticketId, response });
}