// 異常検知 Cron（DESIGN §10.4）。
// 10 分毎に ai_audit / ai_queue を集計し、閾値超過の agent を自動 suspend して
// Webhook（anomaly.detected / agent.suspended）と監査ログに残す。閾値は site_config の
// `ai_thresholds`（JSON）で運用中に変更できる。

import { ulid } from "shared";
import type { Env } from "../../lib/env";
import { prunePluginAuthorData } from "../plugin-authoring/audit";
import { recordAiAudit } from "./audit";
import { emitAgentSuspended, emitAnomaly } from "./events";
import { setAgentStatus } from "./agents";
import { expireQueueItems } from "./queue";
import { retryPendingDeliveries } from "./webhook";
import { asRecord } from "./json";

export interface AiThresholds {
  /** 10 分あたりの投稿数上限 */
  postRatePer10m: number;
  /** エラー率（0-1）。minCallsForErrorRate 未満は判定しない */
  errorRate: number;
  minCallsForErrorRate: number;
  /** 同一 action の 10 分あたり反復上限 */
  actionRepeat: number;
  /** 24h の却下件数上限 */
  queueRejects24h: number;
}

export const DEFAULT_THRESHOLDS: AiThresholds = {
  postRatePer10m: 60,
  errorRate: 0.5,
  minCallsForErrorRate: 10,
  actionRepeat: 100,
  queueRejects24h: 5,
};

const WINDOW_SECONDS = 600;
const DAY_SECONDS = 86_400;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function loadThresholds(env: Env): Promise<AiThresholds> {
  const row = await env.DB.prepare("SELECT value FROM site_config WHERE key = 'ai_thresholds'")
    .first<{ value: string }>();
  if (!row) return DEFAULT_THRESHOLDS;
  try {
    const parsed = asRecord(JSON.parse(row.value));
    if (!parsed) return DEFAULT_THRESHOLDS;
    const merged: AiThresholds = { ...DEFAULT_THRESHOLDS };
    for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof AiThresholds)[]) {
      if (!(key in parsed)) continue;
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
    }
    return merged;
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

interface AuditAggregateRow {
  agent_id: string;
  action: string;
  result: string;
  count: number;
}

interface AgentStatusRow {
  id: string;
  name: string;
  board_id: number | null;
  status: string;
}

export interface MonitorResult {
  windowStart: number;
  agentsChecked: number;
  suspended: string[];
  expiredQueue: number;
  metrics: number;
}

/** 10 分毎の監視。 */
export async function runAiMonitor(env: Env): Promise<MonitorResult> {
  const ts = now();
  const windowStart = ts - (ts % WINDOW_SECONDS);
  const thresholds = await loadThresholds(env);

  const expiredQueue = await expireQueueItems(env);

  const aggregates = await env.DB.prepare(
    `SELECT agent_id, action, result, COUNT(*) AS count FROM ai_audit
     WHERE created_at >= ? AND agent_id IS NOT NULL
     GROUP BY agent_id, action, result`,
  )
    .bind(windowStart)
    .all<AuditAggregateRow>();

  const rejects = await env.DB.prepare(
    `SELECT agent_id, COUNT(*) AS count FROM ai_queue
     WHERE status = 'rejected' AND decided_at >= ? GROUP BY agent_id`,
  )
    .bind(ts - DAY_SECONDS)
    .all<{ agent_id: string; count: number }>();

  const rejectByAgent = new Map((rejects.results ?? []).map((row) => [row.agent_id, row.count]));

  const byAgent = new Map<
    string,
    { total: number; errors: number; posts: number; actions: Map<string, number> }
  >();
  for (const row of aggregates.results ?? []) {
    const entry = byAgent.get(row.agent_id) ?? {
      total: 0,
      errors: 0,
      posts: 0,
      actions: new Map<string, number>(),
    };
    entry.total += row.count;
    if (row.result === "error") entry.errors += row.count;
    if (row.action === "post.create" || row.action === "post.reply") entry.posts += row.count;
    entry.actions.set(row.action, (entry.actions.get(row.action) ?? 0) + row.count);
    byAgent.set(row.agent_id, entry);
  }

  const suspended: string[] = [];
  let metricRows = 0;

  for (const [agentId, entry] of byAgent) {
    const agent = await env.DB.prepare("SELECT id, name, board_id, status FROM ai_agents WHERE id = ?")
      .bind(agentId)
      .first<AgentStatusRow>();
    if (!agent) continue;

    const maxRepeat = Math.max(0, ...entry.actions.values());
    const errorRate = entry.total > 0 ? entry.errors / entry.total : 0;
    const rejectCount = rejectByAgent.get(agentId) ?? 0;

    const checks: { kind: string; value: number; threshold: number; exceeded: boolean }[] = [
      {
        kind: "post_rate",
        value: entry.posts,
        threshold: thresholds.postRatePer10m,
        exceeded: entry.posts > thresholds.postRatePer10m,
      },
      {
        kind: "error_rate",
        value: Math.round(errorRate * 100),
        threshold: Math.round(thresholds.errorRate * 100),
        exceeded:
          entry.total >= thresholds.minCallsForErrorRate && errorRate > thresholds.errorRate,
      },
      {
        kind: "action_repeat",
        value: maxRepeat,
        threshold: thresholds.actionRepeat,
        exceeded: maxRepeat > thresholds.actionRepeat,
      },
      {
        kind: "queue_reject",
        value: rejectCount,
        threshold: thresholds.queueRejects24h,
        exceeded: rejectCount >= thresholds.queueRejects24h,
      },
    ];

    for (const check of checks) {
      await env.DB.prepare(
        `INSERT INTO ai_metrics (id, window_start, window_seconds, agent_id, kind, value, threshold, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(ulid(), windowStart, WINDOW_SECONDS, agentId, check.kind, check.value, check.threshold, ts)
        .run();
      metricRows++;

      if (!check.exceeded || agent.status !== "active") continue;

      const reason = `自動停止: ${check.kind} が閾値超過（${check.value} > ${check.threshold}）`;
      await setAgentStatus(env, agentId, "suspended", reason);
      await recordAiAudit(env, {
        agentId,
        actorType: "system",
        actorId: "monitor",
        action: "agent.auto_suspend",
        risk: "high",
        mode: "auto",
        boardId: agent.board_id,
        params: { kind: check.kind, value: check.value, threshold: check.threshold },
        result: "ok",
        source: "cron",
      });
      await emitAnomaly(env, {
        agentId,
        kind: check.kind,
        value: check.value,
        threshold: check.threshold,
        detail: reason,
      });
      await emitAgentSuspended(
        env,
        { id: agent.id, name: agent.name, boardId: agent.board_id },
        reason,
        "system:monitor",
      );
      suspended.push(agentId);
      break;
    }
  }

  await env.DB.prepare(
    `INSERT INTO ai_state (key, value, updated_at) VALUES ('monitor_last_run', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify({ windowStart, agentsChecked: byAgent.size, suspended }), ts)
    .run();

  return {
    windowStart,
    agentsChecked: byAgent.size,
    suspended,
    expiredQueue,
    metrics: metricRows,
  };
}

/** 20 分毎（毎時 :20）の Webhook 再送とログ掃除。 */
export async function runWebhookMaintenance(env: Env): Promise<{
  retried: number;
  prunedAudit: number;
  prunedCounters: number;
  prunedDeliveries: number;
  prunedPluginAuthorUsage: number;
  prunedPluginAuthorAudit: number;
}> {
  const retried = await retryPendingDeliveries(env, 20);
  const ts = now();

  const retentionRow = await env.DB.prepare("SELECT value FROM site_config WHERE key = 'audit_retention_days'")
    .first<{ value: string }>();
  const retentionDays = Number(retentionRow?.value ?? 365);
  const cutoff = ts - (Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 365) * DAY_SECONDS;

  const audit = await env.DB.prepare("DELETE FROM ai_audit WHERE created_at < ?").bind(cutoff).run();
  const counters = await env.DB.prepare("DELETE FROM ai_rate_counters WHERE window_start < ?")
    .bind(ts - 2 * DAY_SECONDS)
    .run();
  const deliveries = await env.DB.prepare(
    "DELETE FROM webhook_deliveries WHERE created_at < ? AND status IN ('delivered', 'exhausted')",
  )
    .bind(ts - 30 * DAY_SECONDS)
    .run();

  // WP-A: プラグイン作成トークンの日次カウンタ（8 日）と監査（90 日）を既存ジョブで掃除する。
  // 新規 cron は作らない（Free 枠の節約。報告書28 §5.2）。
  const pluginAuthor = await prunePluginAuthorData(env, ts);

  return {
    retried: retried.processed,
    prunedAudit: audit.meta.rows_written ?? 0,
    prunedCounters: counters.meta.rows_written ?? 0,
    prunedDeliveries: deliveries.meta.rows_written ?? 0,
    prunedPluginAuthorUsage: pluginAuthor.usage,
    prunedPluginAuthorAudit: pluginAuthor.audit,
  };
}

/** 監視メトリクスの直近値（ダッシュボード用）。 */
export async function recentMetrics(
  env: Env,
  limit = 50,
): Promise<
  { agentId: string | null; kind: string; value: number; threshold: number | null; windowStart: number }[]
> {
  const rows = await env.DB.prepare(
    `SELECT agent_id, kind, value, threshold, window_start FROM ai_metrics
     ORDER BY window_start DESC, created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{
      agent_id: string | null;
      kind: string;
      value: number;
      threshold: number | null;
      window_start: number;
    }>();
  return (rows.results ?? []).map((row) => ({
    agentId: row.agent_id,
    kind: row.kind,
    value: row.value,
    threshold: row.threshold,
    windowStart: row.window_start,
  }));
}
