// AI 操作の実行オーケストレータ（REST と MCP の共通経路）。
// ここが唯一の強制点: 認証済み agent の全操作は validate → 停止確認 → 政策 → レート → 実行/キュー
// の順で処理され、必ず ai_audit に 1 行残る。

import {
  AI_ACTION_PARAM_SCHEMAS,
  AI_SYSTEM_PROMPT_TEMPLATE,
  ApiError,
  aiActionDefinition,
  isAiActionName,
  ulid,
  type AiActionName,
  type PolicyMode,
  type RiskLevel,
} from "shared";
import type { Env } from "../../lib/env";
import { recordAiAudit } from "./audit";
import { executeAiAction } from "./actions";
import { checkStopped } from "./gate";
import { enforceAiPolicy, type AiAgentContext } from "./policy-engine";
import { attachPolicies } from "./agents";
import { consumeAiRate } from "./rate";
import { enqueueAction } from "./queue";
import { emitQueuePending } from "./events";
import { resolveTargetBoard } from "./readers";

export interface RunAiActionInput {
  env: Env;
  agent: AiAgentContext;
  action: string;
  params: unknown;
  source: "rest" | "mcp";
  idempotencyKey?: string | null;
  ipHash?: string | null;
  requestId?: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface RunAiActionResult {
  action: string;
  risk: RiskLevel;
  mode: PolicyMode;
  status: "executed" | "queued" | "denied";
  reason?: string;
  result?: unknown;
  queueId?: string;
}

function deny(action: string, risk: RiskLevel, reason: string): never {
  void action;
  void risk;
  throw ApiError.forbidden(denyMessage(reason));
}

const DENY_MESSAGES: Record<string, string> = {
  UNKNOWN_ACTION: "未知の action です",
  NEVER_ACTION: "この操作は AI には許可されていません",
  HUMAN_ONLY: "この操作は人間セッションでのみ実行できます",
  AGENT_INACTIVE: "AI 管理者は停止中です",
  INVALID_PARAMS: "パラメータが不正です",
  BOARD_SCOPE: "担当外の板への操作は許可されていません",
  POLICY_DENY: "政策により拒否されました",
  RISK_CAP_EXCEEDED: "risk_cap を超える操作です",
  DELEGATION_SCOPE: "委譲元の権限を超える操作です",
  AGENT_SELF_MANAGEMENT: "AI は自身・他 AI の権限や政策を変更できません",
};

function denyMessage(reason: string): string {
  return DENY_MESSAGES[reason] ?? "この操作は許可されていません";
}

/**
 * AI 操作を 1 回実行する。denied の場合は ApiError(403) を投げる（envelope は error middleware）。
 * executed / queued は結果を返す。
 */
export async function runAiAction(input: RunAiActionInput): Promise<RunAiActionResult> {
  const { env, agent, source } = input;

  if (!isAiActionName(input.action)) {
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action: input.action.slice(0, 64),
      risk: "never",
      mode: "deny",
      result: "denied",
      errorCode: "UNKNOWN_ACTION",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    throw ApiError.validation(`未知の action です: ${input.action}`);
  }
  const action: AiActionName = input.action;
  const definition = aiActionDefinition(action)!;

  // never / humanOnly はパラメータ検証より先に拒否する（存在する action 名で 403 を返す）。
  if (definition.risk === "never" || definition.humanOnly) {
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: definition.risk,
      mode: "deny",
      params: input.params,
      result: "denied",
      errorCode: definition.humanOnly ? "HUMAN_ONLY" : "NEVER_ACTION",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    throw ApiError.forbidden(denyMessage(definition.humanOnly ? "HUMAN_ONLY" : "NEVER_ACTION"));
  }

  const parsed = AI_ACTION_PARAM_SCHEMAS[action].safeParse(input.params ?? {});
  if (!parsed.success) {
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: definition.risk,
      mode: "deny",
      params: input.params,
      result: "denied",
      errorCode: "INVALID_PARAMS",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    throw ApiError.validation("パラメータが不正です", parsed.error.issues);
  }
  const params = parsed.data as Record<string, unknown>;

  const boardId = await resolveTargetBoard(env, action, params);

  const stop = await checkStopped(env, boardId);
  if (stop.stopped) {
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: definition.risk,
      mode: "deny",
      boardId,
      params,
      result: "stopped",
      errorCode: "AI_STOPPED",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    throw new ApiError(503, "AI_STOPPED", "AI 運営は緊急停止中です");
  }

  const agentWithPolicies = await attachPolicies(env, agent, boardId);
  const decision = await enforceAiPolicy(agentWithPolicies, action, params, { boardId });

  if (decision.mode === "deny") {
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: decision.risk,
      mode: decision.mode,
      boardId,
      params,
      result: "denied",
      errorCode: decision.reason ?? "DENIED",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    deny(action, decision.risk, decision.reason ?? "DENIED");
  }

  const rate = await consumeAiRate(env, agentWithPolicies);
  if (!rate.allowed) {
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: decision.risk,
      mode: decision.mode,
      boardId,
      params,
      result: "rate_limited",
      errorCode: rate.limit === "day" ? "DAILY_LIMIT" : "RATE_LIMITED",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    throw ApiError.rateLimited(
      rate.limit === "day"
        ? `1日の操作上限（${agentWithPolicies.dailyLimit} 回）に達しました`
        : `分あたりの操作上限（${agentWithPolicies.rateLimitPerMin} 回）に達しました`,
    );
  }

  if (decision.mode === "queue") {
    const enqueued = await enqueueAction({
      env,
      agent: agentWithPolicies,
      action,
      params,
      risk: decision.risk,
      boardId,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: decision.risk,
      mode: decision.mode,
      boardId,
      params,
      queueId: enqueued.item.id,
      result: "queued",
      errorCode: decision.reason ?? null,
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    if (enqueued.created) {
      await emitQueuePending(env, enqueued.item, input.waitUntil);
    }
    return {
      action,
      risk: decision.risk,
      mode: decision.mode,
      status: "queued",
      queueId: enqueued.item.id,
      reason: decision.reason,
    };
  }

  try {
    const result = await executeAiAction({ env, agent: agentWithPolicies, boardId, action, params });
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: decision.risk,
      mode: decision.mode,
      boardId,
      params,
      result: "ok",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    return { action, risk: decision.risk, mode: decision.mode, status: "executed", result };
  } catch (error) {
    await recordAiAudit(env, {
      agentId: agent.id,
      actorType: "agent",
      actorId: agent.id,
      action,
      risk: decision.risk,
      mode: decision.mode,
      boardId,
      params,
      result: "error",
      errorCode: error instanceof ApiError ? error.code : "EXECUTION_ERROR",
      ipHash: input.ipHash,
      requestId: input.requestId,
      source,
    });
    throw error;
  }
}

/** 監査 ID を採番する必要なし。呼び出し側の requestId に使う ULID を公開しておく。 */
export function newRequestId(): string {
  return ulid();
}

/** MCP の instructions として返す固定文（injection 対策）。 */
export const MCP_INSTRUCTIONS = AI_SYSTEM_PROMPT_TEMPLATE;