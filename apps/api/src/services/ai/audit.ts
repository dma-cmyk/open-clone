// AI 監査ログ（ai_audit）。全 AI 呼び出し・人間の承認/却下/停止を記録する。
// params は canonical JSON の SHA-256（照合用）と 400 文字の要約のみ保存し、本文の大量複製を避ける。

import {
  sha256Hex,
  summarizeParams,
  ulid,
  type AiAuditEntry,
  type AuditResult,
  type RiskLevel,
} from "shared";
import type { Env } from "../../lib/env";

/** キー順を固定した JSON（digest の安定化）。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export interface AuditInput {
  agentId?: string | null;
  actorType: "agent" | "human" | "system";
  actorId?: string | null;
  action: string;
  risk: RiskLevel;
  mode: string;
  boardId?: number | null;
  params?: unknown;
  queueId?: string | null;
  result: AuditResult;
  errorCode?: string | null;
  ipHash?: string | null;
  requestId?: string | null;
  source?: "rest" | "mcp" | "cron" | "admin" | null;
}

/** 監査行を 1 行追加し、その ID を返す。 */
export async function recordAiAudit(env: Env, input: AuditInput): Promise<string> {
  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
  const digest =
    input.params === undefined ? null : await sha256Hex(canonicalJson(input.params));
  await env.DB.prepare(
    `INSERT INTO ai_audit
       (id, agent_id, actor_type, actor_id, action, risk, mode, board_id,
        params_digest, params_summary, queue_id, result, error_code, ip_hash, request_id, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.agentId ?? null,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.risk,
      input.mode,
      input.boardId ?? null,
      digest,
      input.params === undefined ? null : summarizeParams(input.params),
      input.queueId ?? null,
      input.result,
      input.errorCode ?? null,
      input.ipHash ?? null,
      input.requestId ?? null,
      input.source ?? null,
      now,
    )
    .run();
  return id;
}

interface AuditRow {
  id: string;
  agent_id: string | null;
  actor_type: "agent" | "human" | "system";
  actor_id: string | null;
  action: string;
  risk: string;
  mode: string;
  board_id: number | null;
  params_digest: string | null;
  params_summary: string | null;
  queue_id: string | null;
  result: AuditResult;
  error_code: string | null;
  created_at: number;
}

export interface AuditFilter {
  agentId?: string;
  action?: string;
  result?: AuditResult;
  boardIds?: number[];
  limit?: number;
  cursor?: string;
}

/** 監査ログの検索（ダッシュボード・AI の audit.read）。 */
export async function queryAudit(
  env: Env,
  filter: AuditFilter,
): Promise<{ items: AiAuditEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 200);
  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (filter.agentId) {
    clauses.push("agent_id = ?");
    bindings.push(filter.agentId);
  }
  if (filter.action) {
    clauses.push("action = ?");
    bindings.push(filter.action);
  }
  if (filter.result) {
    clauses.push("result = ?");
    bindings.push(filter.result);
  }
  if (filter.boardIds && filter.boardIds.length > 0) {
    clauses.push(`board_id IN (${filter.boardIds.map(() => "?").join(",")})`);
    bindings.push(...filter.boardIds);
  }
  if (filter.cursor) {
    const before = Number(filter.cursor);
    if (Number.isFinite(before)) {
      clauses.push("created_at < ?");
      bindings.push(before);
    }
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await env.DB.prepare(
    `SELECT id, agent_id, actor_type, actor_id, action, risk, mode, board_id, params_digest,
            params_summary, queue_id, result, error_code, created_at
     FROM ai_audit ${where} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...bindings, limit + 1)
    .all<AuditRow>();

  const items = (rows.results ?? []).map<AiAuditEntry>((row) => ({
    id: row.id,
    agentId: row.agent_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    risk: row.risk as RiskLevel,
    mode: row.mode,
    boardId: row.board_id,
    paramsDigest: row.params_digest,
    paramsSummary: row.params_summary,
    queueId: row.queue_id,
    result: row.result,
    errorCode: row.error_code,
    createdAt: row.created_at,
  }));
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: items.length > limit && last ? String(last.createdAt) : null,
  };
}
