// 承認キュー（DESIGN §10.3）。
// high リスク操作は常にここへ積まれ、人間セッションの承認後に「同じ政策チェックを再実行」してから適用する。
// 承認 UI には params だけでなく根拠（対象投稿の原文・通報理由・プラグインコード抜粋）をそのまま返す。

import {
  ApiError,
  QUEUE_TTL_SECONDS,
  isAiActionName,
  ulid,
  type AiQueueItem,
  type QueueStatus,
  type RiskLevel,
} from "shared";
import type { Env } from "../../lib/env";
import { executeAiAction } from "./actions";
import { enforceAiPolicy, type AiAgentContext } from "./policy-engine";
import { agentContextFromRow, attachPolicies, getAgentRow } from "./agents";

interface QueueRow {
  id: string;
  agent_id: string;
  agent_name?: string | null;
  action: string;
  params: string;
  risk: string;
  board_id: number | null;
  summary: string;
  evidence: string | null;
  status: QueueStatus;
  idempotency_key: string | null;
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
  note: string | null;
  executed_at: number | null;
  result: string | null;
  error: string | null;
}

const QUEUE_COLUMNS = `q.id, q.agent_id, q.action, q.params, q.risk, q.board_id, q.summary, q.evidence,
  q.status, q.idempotency_key, q.requested_at, q.expires_at, q.decided_at, q.decided_by, q.note,
  q.executed_at, q.result, q.error`;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function mapQueueRow(row: QueueRow): AiQueueItem {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? null,
    action: row.action,
    risk: row.risk as RiskLevel,
    status: row.status,
    boardId: row.board_id,
    params: parseJson(row.params),
    summary: row.summary,
    evidence: parseJson(row.evidence),
    idempotencyKey: row.idempotency_key,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    note: row.note,
    executedAt: row.executed_at,
    result: parseJson(row.result),
    error: row.error,
  };
}

/** 承認 UI の見出し（AI の要約だけを根拠にさせないため、対象 ID と操作名を必ず含める）。 */
export function summarizeAction(action: string, params: Record<string, unknown>): string {
  const target =
    params.postId !== undefined
      ? `レス #${String(params.postId)}`
      : params.threadId !== undefined
        ? `スレ #${String(params.threadId)}`
        : params.boardId !== undefined
          ? `板 #${String(params.boardId)}`
          : params.pluginId !== undefined
            ? `プラグイン ${String(params.pluginId)}`
            : params.accountId !== undefined
              ? `アカウント ${String(params.accountId)}`
              : params.reportId !== undefined
                ? `通報 ${String(params.reportId)}`
                : "対象未特定";
  const reason = typeof params.reason === "string" ? `（理由: ${params.reason}）` : "";
  return `${action}: ${target}${reason}`;
}

async function collectEvidence(
  env: Env,
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    if (typeof params.postId === "number") {
      const post = await env.DB.prepare(
        `SELECT p.id, p.thread_id, p.board_id, p.num, p.name, p.body, p.post_id_hash, p.created_at,
                t.title AS thread_title
         FROM posts p LEFT JOIN threads t ON t.id = p.thread_id WHERE p.id = ?`,
      )
        .bind(params.postId)
        .first();
      if (post) return { kind: "post", target: post };
    }
    if (typeof params.threadId === "number") {
      const thread = await env.DB.prepare(
        "SELECT id, board_id, title, post_count, status FROM threads WHERE id = ?",
      )
        .bind(params.threadId)
        .first();
      if (thread) return { kind: "thread", target: thread };
    }
    if (typeof params.reportId === "string") {
      const report = await env.DB.prepare("SELECT * FROM reports WHERE id = ?")
        .bind(params.reportId)
        .first();
      if (report) return { kind: "report", target: report };
    }
    if (typeof params.pluginId === "string") {
      const plugin = await env.DB.prepare(
        "SELECT id, name, summary, status, latest_version, disabled_reason FROM plugins WHERE id = ?",
      )
        .bind(params.pluginId)
        .first();
      const version = plugin
        ? await env.DB.prepare(
            "SELECT version, substr(code, 1, 4000) AS code_excerpt FROM plugin_versions WHERE plugin_id = ? ORDER BY created_at DESC LIMIT 1",
          )
            .bind(params.pluginId)
            .first()
        : null;
      if (plugin) return { kind: "plugin", target: plugin, version };
    }
    if (typeof params.boardId === "number") {
      const board = await env.DB.prepare(
        "SELECT id, slug, name, status, substr(rules_md, 1, 2000) AS rules_excerpt FROM boards WHERE id = ?",
      )
        .bind(params.boardId)
        .first();
      if (board) return { kind: "board", target: board };
    }
    if (typeof params.accountId === "string") {
      const account = await env.DB.prepare("SELECT id, name, role, status FROM accounts WHERE id = ?")
        .bind(params.accountId)
        .first();
      if (account) return { kind: "account", target: account };
    }
    void action;
    return { kind: "params", target: params };
  } catch (error) {
    console.error("QUEUE_EVIDENCE_FAILED", error);
    return { kind: "params", target: params, evidenceError: true };
  }
}

export interface EnqueueInput {
  env: Env;
  agent: AiAgentContext;
  action: string;
  params: Record<string, unknown>;
  risk: RiskLevel;
  boardId: number | null;
  idempotencyKey?: string | null;
}

export interface EnqueueResult {
  item: AiQueueItem;
  created: boolean;
}

/** キューに積む。idempotency_key が既存なら新しい行を作らず既存を返す。 */
export async function enqueueAction(input: EnqueueInput): Promise<EnqueueResult> {
  const { env, agent, action, params, risk, boardId } = input;

  if (input.idempotencyKey) {
    const existing = await env.DB.prepare(
      `SELECT ${QUEUE_COLUMNS} FROM ai_queue q WHERE q.agent_id = ? AND q.idempotency_key = ?`,
    )
      .bind(agent.id, input.idempotencyKey)
      .first<QueueRow>();
    if (existing) return { item: mapQueueRow(existing), created: false };
  }

  const id = ulid();
  const requestedAt = now();
  const notes = summarizeAction(action, params);
  const evidence = await collectEvidence(env, action, params);
  const boardIdToStore = boardId ?? (typeof params.boardId === "number" ? params.boardId : null);

  await env.DB.prepare(
    `INSERT INTO ai_queue
       (id, agent_id, action, params, risk, board_id, summary, evidence, status, idempotency_key,
        requested_at, expires_at, decided_at, decided_by, note, executed_at, result, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
  )
    .bind(
      id,
      agent.id,
      action,
      JSON.stringify(params),
      risk,
      boardIdToStore,
      notes,
      JSON.stringify(evidence),
      input.idempotencyKey ?? null,
      requestedAt,
      requestedAt + QUEUE_TTL_SECONDS,
    )
    .run();

  const row = await env.DB.prepare(
    `SELECT ${QUEUE_COLUMNS} FROM ai_queue q WHERE q.id = ?`,
  )
    .bind(id)
    .first<QueueRow>();
  if (!row) throw new ApiError(500, "INTERNAL", "承認キューの作成に失敗しました");
  return { item: mapQueueRow(row), created: true };
}

export interface QueueFilter {
  status?: QueueStatus | "all";
  boardId?: number;
  /** 板管理人の閲覧範囲（複数板） */
  boardIds?: number[];
  agentId?: string;
  limit?: number;
  cursor?: string;
}

export async function listQueue(
  env: Env,
  filter: QueueFilter,
): Promise<{ items: AiQueueItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, filter.limit ?? 20), 100);
  const bindings: unknown[] = [];
  let where = "WHERE 1 = 1";
  if (filter.status && filter.status !== "all") {
    where += " AND q.status = ?";
    bindings.push(filter.status);
  }
  if (filter.boardId !== undefined) {
    where += " AND (q.board_id = ? OR q.board_id IS NULL)";
    bindings.push(filter.boardId);
  }
  if (filter.boardIds && filter.boardIds.length > 0) {
    where += ` AND q.board_id IN (${filter.boardIds.map(() => "?").join(",")})`;
    bindings.push(...filter.boardIds);
  }
  if (filter.agentId) {
    where += " AND q.agent_id = ?";
    bindings.push(filter.agentId);
  }
  if (filter.cursor) {
    const cursorAt = Number(atobSafe(filter.cursor));
    if (Number.isFinite(cursorAt)) {
      where += " AND q.requested_at < ?";
      bindings.push(cursorAt);
    }
  }
  const rows = await env.DB.prepare(
    `SELECT ${QUEUE_COLUMNS}, a.name AS agent_name
     FROM ai_queue q LEFT JOIN ai_agents a ON a.id = q.agent_id
     ${where} ORDER BY q.requested_at DESC LIMIT ?`,
  )
    .bind(...bindings, limit + 1)
    .all<QueueRow>();
  const items = (rows.results ?? []).map(mapQueueRow);
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: items.length > limit && last ? btoa(String(last.requestedAt)) : null,
  };
}

function atobSafe(value: string): string {
  try {
    return atob(value);
  } catch {
    return "";
  }
}

export async function getQueueItem(env: Env, id: string): Promise<AiQueueItem> {
  const row = await env.DB.prepare(
    `SELECT ${QUEUE_COLUMNS}, a.name AS agent_name
     FROM ai_queue q LEFT JOIN ai_agents a ON a.id = q.agent_id WHERE q.id = ?`,
  )
    .bind(id)
    .first<QueueRow>();
  if (!row) throw ApiError.notFound("承認キュー項目が見つかりません");
  return mapQueueRow(row);
}

export interface ReviewerIdentity {
  accountId: string;
  role: "owner" | "special_admin" | "user";
}

/** 承認/却下の権限: サイト操作はサイト管理者、板操作はその板の admin（DESIGN §10.2）。 */
export async function assertCanDecide(
  env: Env,
  reviewer: ReviewerIdentity,
  item: AiQueueItem,
): Promise<void> {
  if (reviewer.role === "owner" || reviewer.role === "special_admin") return;
  if (item.boardId === null) throw ApiError.forbidden("サイト全体の AI 操作を承認できるのはサイト管理者のみです");
  const staff = await env.DB.prepare(
    "SELECT level FROM board_staff WHERE board_id = ? AND account_id = ? AND level = 'admin'",
  )
    .bind(item.boardId, reviewer.accountId)
    .first<{ level: string }>();
  if (!staff) throw ApiError.forbidden("この板の AI 操作を承認する権限がありません");
}

export async function approveQueueItem(
  env: Env,
  item: AiQueueItem,
  reviewer: ReviewerIdentity,
  note: string | null,
): Promise<AiQueueItem> {
  if (item.status !== "pending") throw ApiError.conflict("この項目は既に処理済みです");
  const ts = now();
  if (item.expiresAt < ts) {
    await env.DB.prepare("UPDATE ai_queue SET status = 'expired' WHERE id = ?").bind(item.id).run();
    throw ApiError.conflict("この承認依頼は期限切れ（72h）です");
  }

  // 承認時点で政策を再評価する（停止・権限変更・政策変更を反映）。
  const agentRow = await getAgentRow(env, item.agentId);
  if (!agentRow) {
    await env.DB.prepare(
      "UPDATE ai_queue SET status = 'failed', decided_at = ?, decided_by = ?, error = ? WHERE id = ?",
    )
      .bind(ts, reviewer.accountId, "AI 管理者が存在しません", item.id)
      .run();
    throw ApiError.conflict("AI 管理者が削除されています");
  }
  if (agentRow.status !== "active") {
    await env.DB.prepare(
      "UPDATE ai_queue SET status = 'failed', decided_at = ?, decided_by = ?, error = ? WHERE id = ?",
    )
      .bind(ts, reviewer.accountId, `AI 管理者は停止中です: ${agentRow.suspended_reason ?? ""}`, item.id)
      .run();
    throw ApiError.conflict("AI 管理者が停止中のため実行できません");
  }

  const agent = await attachPolicies(env, agentContextFromRow(agentRow), item.boardId);

  const params = (item.params ?? {}) as Record<string, unknown>;
  const decision = await enforceAiPolicy(agent, item.action, params, { boardId: item.boardId });
  if (decision.mode === "deny") {
    await env.DB.prepare(
      "UPDATE ai_queue SET status = 'failed', decided_at = ?, decided_by = ?, note = ?, error = ? WHERE id = ?",
    )
      .bind(ts, reviewer.accountId, note, `再評価で拒否: ${decision.reason ?? "denied"}`, item.id)
      .run();
    throw ApiError.forbidden(`承認後の再評価で拒否されました: ${decision.reason ?? "denied"}`);
  }

  const claim = await env.DB.prepare(
    "UPDATE ai_queue SET status = 'approved', decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(ts, reviewer.accountId, note, item.id)
    .run();
  // 事前チェックだけでは 2 人の承認が両方通過する（TOCTOU）。条件付き UPDATE に負けた側は
  // 実行せず 409 を返す。これで high リスク操作の二重実行を防ぐ。
  if ((claim.meta.rows_written ?? 0) === 0) {
    throw ApiError.conflict("この項目は既に処理済みです");
  }

  if (!isAiActionName(item.action)) {
    await env.DB.prepare(
      "UPDATE ai_queue SET status = 'failed', decided_at = ?, decided_by = ?, error = ? WHERE id = ?",
    )
      .bind(ts, reviewer.accountId, `未知の action: ${item.action}`, item.id)
      .run();
    throw ApiError.validation("未知の action です");
  }

  try {
    const result = await executeAiAction({
      env,
      agent,
      action: item.action,
      params,
      boardId: item.boardId,
    });
    await env.DB.prepare(
      "UPDATE ai_queue SET status = 'executed', executed_at = ?, result = ?, error = NULL WHERE id = ?",
    )
      .bind(now(), JSON.stringify(result ?? null), item.id)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "実行に失敗しました";
    await env.DB.prepare(
      "UPDATE ai_queue SET status = 'failed', executed_at = ?, error = ? WHERE id = ?",
    )
      .bind(now(), message, item.id)
      .run();
    throw error;
  }

  return getQueueItem(env, item.id);
}

export async function rejectQueueItem(
  env: Env,
  item: AiQueueItem,
  reviewer: ReviewerIdentity,
  note: string | null,
): Promise<AiQueueItem> {
  if (item.status !== "pending") throw ApiError.conflict("この項目は既に処理済みです");
  const claim = await env.DB.prepare(
    "UPDATE ai_queue SET status = 'rejected', decided_at = ?, decided_by = ?, note = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(now(), reviewer.accountId, note, item.id)
    .run();
  if ((claim.meta.rows_written ?? 0) === 0) {
    throw ApiError.conflict("この項目は既に処理済みです");
  }
  return getQueueItem(env, item.id);
}

/** 期限切れの pending を expired にする（cron・キュー一覧取得時に呼ぶ）。 */
export async function expireQueueItems(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    "UPDATE ai_queue SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
  )
    .bind(now())
    .run();
  return result.meta.rows_written ?? 0;
}