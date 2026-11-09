// トークン経路の監査（`plugin_author_audit`）。報告書28 §5.5。
// コード全文・投稿本文は保存しない。`params_digest`（SHA-256）と先頭 200 文字の要約のみ。
// 要約では `code` を `<N bytes>` に置換し、コードの断片すら残さない（正本は plugin_versions）。

import { sha256Hex, ulid } from "shared";
import type { Env } from "../../lib/env";

const DAY_SECONDS = 86_400;
const PARAMS_SUMMARY_MAX_CHARS = 200;
/** usage は 8 日、監査は 90 日保持（報告書28 §5.2）。 */
const USAGE_RETENTION_DAYS = 8;
const AUDIT_RETENTION_DAYS = 90;

export type AuthorAuditResult = "ok" | "denied" | "error" | "rate_limited";

export interface AuthorAuditEntry {
  tokenId: string;
  accountId: string;
  tool: string;
  pluginId?: string | null;
  version?: string | null;
  params?: unknown;
  result: AuthorAuditResult;
  errorCode?: string | null;
  ipHash?: string | null;
  requestId?: string | null;
}

/** トークン・コード本文を落とした要約（保存用）。 */
function summarizeParams(params: unknown): string {
  if (params === undefined) return "";
  let sanitized: unknown = params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const copy: Record<string, unknown> = { ...(params as Record<string, unknown>) };
    if (typeof copy.code === "string") {
      const bytes = new TextEncoder().encode(copy.code).byteLength;
      copy.code = `<${bytes} bytes>`;
    }
    sanitized = copy;
  }
  const json = JSON.stringify(sanitized) ?? "";
  return json.length <= PARAMS_SUMMARY_MAX_CHARS ? json : `${json.slice(0, PARAMS_SUMMARY_MAX_CHARS)}…`;
}

export async function writeAuthorAudit(env: Env, entry: AuthorAuditEntry): Promise<void> {
  const paramsJson = entry.params === undefined ? "" : JSON.stringify(entry.params);
  await env.DB.prepare(
    `INSERT INTO plugin_author_audit
       (id, token_id, account_id, tool, plugin_id, version, params_digest, params_summary,
        result, error_code, ip_hash, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ulid(),
      entry.tokenId,
      entry.accountId,
      entry.tool,
      entry.pluginId ?? null,
      entry.version ?? null,
      paramsJson ? await sha256Hex(paramsJson) : null,
      summarizeParams(entry.params),
      entry.result,
      entry.errorCode ?? null,
      entry.ipHash ?? null,
      entry.requestId ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

/**
 * 既存の毎時 :20 cron（webhook 再送/ログ掃除）から呼ぶ保持期限の掃除。
 * 新規 cron は作らない（報告書28 §5.2）。
 */
export async function prunePluginAuthorData(
  env: Env,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ usage: number; audit: number }> {
  const usage = await env.DB.prepare("DELETE FROM plugin_author_usage WHERE day_start < ?")
    .bind(nowSeconds - USAGE_RETENTION_DAYS * DAY_SECONDS)
    .run();
  const audit = await env.DB.prepare("DELETE FROM plugin_author_audit WHERE created_at < ?")
    .bind(nowSeconds - AUDIT_RETENTION_DAYS * DAY_SECONDS)
    .run();
  return {
    usage: usage.meta.rows_written ?? 0,
    audit: audit.meta.rows_written ?? 0,
  };
}