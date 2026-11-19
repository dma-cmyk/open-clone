// 事業者との HTTP やり取り（chat と models で共通）。
//
// - 応答は `PET_LIMITS.providerResponseMaxBytes` まで読む。
// - 3xx は追わない（`redirect: "manual"`）。追うと SSRF 検査を迂回できる。
// - 失敗は設計 §5 の表に従って `PET_PROVIDER_*` へ対応付ける。
// - 事業者のエラー文は伏せて 300 文字まで（`redact.ts`）。
// - `cause` は付けない（要求ヘッダーに API キーが入っている）。

import { ApiError, ErrorCode, PET_LIMITS } from "shared";
import { extractProviderErrorText, summarizeProviderMessage } from "./redact";

/** 事業者応答を上限バイト数まで読む。超えたら読むのをやめて 502 にする。 */
export async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(502, ErrorCode.PET_PROVIDER_ERROR, "AI 事業者の応答が大きすぎます");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** 事業者の HTTP 状態を契約のエラーへ対応付ける（設計 §5 の表）。 */
export function mapProviderStatus(status: number, raw: string, apiKey: string): ApiError {
  const summary = summarizeProviderMessage(extractProviderErrorText(raw), apiKey);
  const details = { status, ...(summary.length > 0 ? { providerMessage: summary } : {}) };
  if (status === 401 || status === 403) {
    return new ApiError(
      502,
      ErrorCode.PET_PROVIDER_AUTH,
      "AI 事業者が API キーを受け付けませんでした",
      details,
    );
  }
  if (status === 429) {
    return new ApiError(
      429,
      ErrorCode.PET_PROVIDER_RATE_LIMITED,
      "AI 事業者の回数制限にかかりました。しばらく待ってください",
      details,
    );
  }
  const suffix = summary.length > 0 ? `: ${summary}` : "";
  return new ApiError(
    502,
    ErrorCode.PET_PROVIDER_ERROR,
    `AI 事業者がエラーを返しました（HTTP ${status}）${suffix}`,
    details,
  );
}

export function mapNetworkError(error: unknown, controller: AbortController): ApiError {
  if (error instanceof ApiError) return error;
  if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new ApiError(504, ErrorCode.PET_PROVIDER_TIMEOUT, "AI 事業者が時間内に応答しませんでした");
  }
  return new ApiError(502, ErrorCode.PET_PROVIDER_ERROR, "AI 事業者への通信に失敗しました");
}

export interface ProviderJsonRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** POST のときだけ。 */
  body?: unknown;
  apiKey: string;
  /** この要求だけの待ち上限（全体期限の残りを渡す）。未指定なら `providerTimeoutMs`。 */
  timeoutMs?: number;
}

/** 事業者へ 1 回要求を送り、成功時の JSON を返す。 */
export async function fetchProviderJson(input: ProviderJsonRequest): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = Math.min(
    PET_LIMITS.providerTimeoutMs,
    Math.max(1, Math.floor(input.timeoutMs ?? PET_LIMITS.providerTimeoutMs)),
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(
        502,
        ErrorCode.PET_PROVIDER_ERROR,
        `AI 事業者がリダイレクトを返しました（HTTP ${response.status}）`,
      );
    }
    const raw = await readLimitedBody(response, PET_LIMITS.providerResponseMaxBytes);
    if (!response.ok) throw mapProviderStatus(response.status, raw, input.apiKey);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ApiError(502, ErrorCode.PET_PROVIDER_ERROR, "AI 事業者の応答を解釈できませんでした");
    }
  } catch (error) {
    throw mapNetworkError(error, controller);
  } finally {
    clearTimeout(timer);
  }
}