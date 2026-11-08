// API クライアント。
// 既定は同一オリジン `/api/v1`（vercel.json / next.config.ts の rewrites 経由で Worker に届く）。
// 直接モードは `NEXT_PUBLIC_API_BASE` で Worker オリジンを指定する。

import type { ApiResponse } from "shared";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include", // oc_did / oc_sess Cookie（同一オリジン時はファーストパーティ）
  });

  const json = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json) {
    throw new ApiRequestError(response.status, "INVALID_RESPONSE", `API 応答が不正です（HTTP ${response.status}）`);
  }
  if (!json.ok) {
    throw new ApiRequestError(response.status, json.code, json.message);
  }
  return json.data;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body ?? {});
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>("DELETE", path);
}

/** 疎通確認用（/v1/health） */
export function healthCheck(): Promise<{ status: string }> {
  return apiGet<{ status: string }>("/health");
}
