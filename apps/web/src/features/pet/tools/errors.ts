// ツール共通の失敗の扱い。
//
// 既存の画面の API クライアント（`board-ui/api.ts`・`plugin-host/api.ts`・`account/api.ts`・
// `_wp1/api.ts`）はどれも `status` と `code` を持つ Error を投げる。ツールはその code をそのまま返し、
// ペット側で権限や可否を判断し直さない（サーバーの拒否をそのまま利用者に見せる）。

import type { PetConfirmRequest, PetToolResult } from "../contract";

/** メッセージの最大長（AI に渡すので長すぎる文は切る）。 */
const MESSAGE_MAX_CHARS = 300;

/** 制御文字を落とし、長さを切る（API の文面に改行が混ざっても 1 行にそろえる）。 */
export function sanitizeMessage(message: string): string {
  const flat = message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_MAX_CHARS ? `${flat.slice(0, MESSAGE_MAX_CHARS)}…` : flat;
}

/** API クライアントが投げる Error の形（status と code を持つ）。 */
interface CodedError {
  name?: unknown;
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

function isCodedError(cause: unknown): cause is CodedError {
  return typeof cause === "object" && cause !== null && "status" in cause && typeof cause.status === "number";
}

/**
 * 例外を `{ok:false, code, error}` にする。API の code（`FORBIDDEN`・`UNAUTHENTICATED` など）を保つ。
 * 呼び出し側（ペット）は code を見て案内を変えるだけで、権限を広げる判断には使わない。
 */
export function toFailure(cause: unknown): PetToolResult {
  if (isCodedError(cause)) {
    const code = typeof cause.code === "string" && cause.code.length > 0 ? cause.code : "API_ERROR";
    const message = typeof cause.message === "string" && cause.message.length > 0 ? cause.message : "API エラー";
    return { ok: false, code, error: sanitizeMessage(message) };
  }
  if (cause instanceof Error) {
    return { ok: false, code: "ERROR", error: sanitizeMessage(cause.message || "エラーが発生しました") };
  }
  return { ok: false, code: "ERROR", error: "エラーが発生しました" };
}

/** 引数が不正なときの結果（AI が直せるように、どの項目が悪いかを文で返す）。 */
export function invalidArgs(error: string): PetToolResult {
  return { ok: false, code: "INVALID_ARGS", error };
}

/** 権限が足りないと分かっているとき（通信せずに返す）。 */
export function notAllowed(error: string): PetToolResult {
  return { ok: false, code: "FORBIDDEN", error };
}

/** ログインが要る操作で未ログインのとき。 */
export function notLoggedIn(action: string): PetToolResult {
  return { ok: false, code: "UNAUTHENTICATED", error: `${action}にはログインが必要です。` };
}

/** 対象が無いとき。 */
export function notFound(error: string): PetToolResult {
  return { ok: false, code: "NOT_FOUND", error };
}

/** 中止（AbortSignal）を結果にする。 */
export function aborted(): PetToolResult {
  return { ok: false, code: "ABORTED", error: "操作を中止しました。" };
}

/** `{ok:false}` かどうか（PetConfirmRequest と PetToolResult の判別）。 */
export function isFailure(value: PetConfirmRequest | PetToolResult): value is PetToolResult & { ok: false } {
  return "ok" in value && value.ok === false;
}