"use client";

// `/admin/ai/*` の共通部品と API 呼び出し。
// 権限判定はサーバー側（この画面はサイト管理者/特別管理人専用の admin レイアウト配下）。

import type { ReactNode } from "react";
import type { ApiResponse } from "shared";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

export class AiApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AiApiError";
    this.status = status;
    this.code = code;
  }
}

/** `/v1/ai/*` を叩いて envelope を剥がす。AI API キーではなく人間セッション Cookie を使う。 */
export async function aiFetch<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });
  const json = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!json) {
    throw new AiApiError(response.status, "INVALID_RESPONSE", `API 応答が不正です（HTTP ${response.status}）`);
  }
  if (!json.ok) {
    throw new AiApiError(response.status, json.code, json.message);
  }
  return json.data;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "不明なエラーが発生しました";
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString("ja-JP");
}

export function RiskBadge({ risk }: { risk: string }) {
  const className =
    risk === "high" || risk === "never"
      ? "oc-badge oc-badge-red"
      : risk === "medium"
        ? "oc-badge oc-badge-yellow"
        : "oc-badge oc-badge-gray";
  return <span className={className}>{risk}</span>;
}

export function QueueStatusBadge({ status }: { status: string }) {
  const className =
    status === "pending"
      ? "oc-badge oc-badge-yellow"
      : status === "executed"
        ? "oc-badge oc-badge-green"
        : status === "failed"
          ? "oc-badge oc-badge-red"
          : "oc-badge oc-badge-gray";
  return <span className={className}>{status}</span>;
}

export function ResultBadge({ result }: { result: string }) {
  const className =
    result === "ok"
      ? "oc-badge oc-badge-green"
      : result === "queued"
        ? "oc-badge oc-badge-yellow"
        : result === "denied" || result === "error" || result === "stopped"
          ? "oc-badge oc-badge-red"
          : "oc-badge oc-badge-gray";
  return <span className={className}>{result}</span>;
}

export function StatCard({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="oc-card oc-row-between">
      <span className="oc-small oc-muted">
        {label}
        {note ? <span className="oc-tiny oc-muted"> / {note}</span> : null}
      </span>
      <strong style={{ fontSize: 18 }}>{value}</strong>
    </div>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <div className="oc-row-between">
      <h1 style={{ fontSize: 18, margin: 0 }}>{children}</h1>
    </div>
  );
}