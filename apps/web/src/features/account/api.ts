// アカウント/管理画面の API クライアント。
// 既定は同一オリジン `/api/v1`（next.config.ts dev rewrites / vercel.json rewrites 経由）。

import type { ApiResponse } from "shared";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiCallOptions {
  /** Turnstile トークン（異常検知時の登録・ログインに付与） */
  turnstileToken?: string | null;
}

export async function api<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  options: ApiCallOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.turnstileToken) headers["x-turnstile-token"] = options.turnstileToken;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });

  const json = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json) {
    throw new ApiRequestError(response.status, "INVALID_RESPONSE", `API 応答が不正です（HTTP ${response.status}）`);
  }
  if (!json.ok) {
    throw new ApiRequestError(response.status, json.code, json.message, json.details);
  }
  return json.data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return "不明なエラーが発生しました";
}