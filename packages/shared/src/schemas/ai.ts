// AI 管理者・政策・承認キュー・監査・緊急停止の共有スキーマ（DESIGN §10）。
// DB 行の snake_case は services/ai 側でこの camelCase 表現に変換する。API/MCP の境界はすべてこの型。

import { z } from "zod";
import { RISK_CAPS, RISK_LEVELS, policyModeSchema } from "./risk";

export const aiOwnerTypeSchema = z.enum(["site", "board", "account"]);
export type AiOwnerType = z.infer<typeof aiOwnerTypeSchema>;

export const aiAgentStatusSchema = z.enum(["active", "suspended", "revoked"]);
export type AiAgentStatus = z.infer<typeof aiAgentStatusSchema>;

export const queueStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
]);
export type QueueStatus = z.infer<typeof queueStatusSchema>;

export const auditResultSchema = z.enum([
  "ok",
  "queued",
  "denied",
  "error",
  "rate_limited",
  "stopped",
]);
export type AuditResult = z.infer<typeof auditResultSchema>;

/** 担当板。site agent は "*"（全板）を指定できる。 */
export const allowedBoardsSchema = z.union([
  z.array(z.number().int().positive()).max(500),
  z.literal("*"),
]);
export type AllowedBoards = z.infer<typeof allowedBoardsSchema>;

/** 外部に公開する AI 管理者の表現（API キー・ハッシュは含めない）。 */
export const aiAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerType: aiOwnerTypeSchema,
  ownerId: z.string(),
  /** owner_type=board のときの板（担当範囲の基準） */
  boardId: z.number().int().nullable(),
  allowedBoards: allowedBoardsSchema,
  riskCap: z.enum(RISK_CAPS),
  status: aiAgentStatusSchema,
  suspendedReason: z.string().nullable(),
  /** 分あたり操作上限 */
  rateLimitPerMin: z.number().int(),
  /** 日次操作上限 */
  dailyLimit: z.number().int(),
  /** 投稿時の名義（AI attribution） */
  displayName: z.string(),
  keyPrefix: z.string(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastUsedAt: z.number().int().nullable(),
});
export type AiAgent = z.infer<typeof aiAgentSchema>;

/** API キー発行・ローテーション時のみ返す（この応答以外で平文キーは出ない）。 */
export const aiAgentWithKeySchema = aiAgentSchema.extend({
  apiKey: z.string(),
  keyWarning: z.string(),
});
export type AiAgentWithKey = z.infer<typeof aiAgentWithKeySchema>;

export const createAiAgentInputSchema = z.strictObject({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  ownerType: aiOwnerTypeSchema,
  /** ownerType=board のとき必須 */
  boardId: z.number().int().positive().optional(),
  allowedBoards: allowedBoardsSchema,
  riskCap: z.enum(RISK_CAPS).default("low"),
  rateLimitPerMin: z.number().int().min(1).max(600).default(30),
  dailyLimit: z.number().int().min(1).max(100_000).default(2000),
  displayName: z.string().min(1).max(50).default("AI運営"),
});
export type CreateAiAgentInput = z.infer<typeof createAiAgentInputSchema>;

export const updateAiAgentInputSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
  allowedBoards: allowedBoardsSchema.optional(),
  rateLimitPerMin: z.number().int().min(1).max(600).optional(),
  dailyLimit: z.number().int().min(1).max(100_000).optional(),
  displayName: z.string().min(1).max(50).optional(),
  /** risk_cap の変更は人間の委譲者が明示的に行う（AI からは不可） */
  riskCap: z.enum(RISK_CAPS).optional(),
});
export type UpdateAiAgentInput = z.infer<typeof updateAiAgentInputSchema>;

// ─────────────────────────── 政策 ───────────────────────────

export const aiPolicySchema = z.object({
  id: z.string(),
  scope: z.enum(["site", "board", "agent"]),
  scopeId: z.string(),
  action: z.string(),
  mode: policyModeSchema,
  updatedBy: z.string(),
  updatedAt: z.number().int(),
});
export type AiPolicy = z.infer<typeof aiPolicySchema>;

export const putAiPolicyInputSchema = z.strictObject({
  scope: z.enum(["site", "board", "agent"]),
  scopeId: z.string().min(1).max(64),
  action: z.string().min(1).max(64),
  mode: policyModeSchema,
});
export type PutAiPolicyInput = z.infer<typeof putAiPolicyInputSchema>;

// ─────────────────────────── 承認キュー ───────────────────────────

export const aiQueueItemSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string().nullable(),
  action: z.string(),
  risk: z.enum(RISK_LEVELS),
  status: queueStatusSchema,
  boardId: z.number().int().nullable(),
  params: z.unknown(),
  /** 人間が読む要約（承認 UI の見出し） */
  summary: z.string(),
  /** 根拠（投稿原文・通報理由など）。AI の要約だけを根拠にさせない。 */
  evidence: z.unknown().nullable(),
  idempotencyKey: z.string().nullable(),
  requestedAt: z.number().int(),
  expiresAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  decidedBy: z.string().nullable(),
  note: z.string().nullable(),
  executedAt: z.number().int().nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
});
export type AiQueueItem = z.infer<typeof aiQueueItemSchema>;

export const queueDecideInputSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});
export type QueueDecideInput = z.infer<typeof queueDecideInputSchema>;

export const QUEUE_TTL_SECONDS = 72 * 3600;
/** 高リスクの一括承認は禁止（DESIGN §10.3） */
export const QUEUE_BULK_APPROVE_MAX = 1;

// ─────────────────────────── 監査 ───────────────────────────

export const aiAuditEntrySchema = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  actorType: z.enum(["agent", "human", "system"]),
  actorId: z.string().nullable(),
  action: z.string(),
  risk: z.enum(RISK_LEVELS),
  mode: z.string(),
  boardId: z.number().int().nullable(),
  paramsDigest: z.string().nullable(),
  paramsSummary: z.string().nullable(),
  queueId: z.string().nullable(),
  result: auditResultSchema,
  errorCode: z.string().nullable(),
  createdAt: z.number().int(),
});
export type AiAuditEntry = z.infer<typeof aiAuditEntrySchema>;

/**
 * 監査ログに残してよいパラメータの要約。本文そのものは params_digest で照合し、
 * 平文の大量保存は避ける（秘密・スパム本文の増殖防止）。値は最大 200 文字に切る。
 */
export function summarizeParams(params: unknown): string {
  if (params === null || params === undefined) return "";
  const json = JSON.stringify(params);
  return json.length > 400 ? `${json.slice(0, 400)}…` : json;
}

// ─────────────────────────── 緊急停止 ───────────────────────────

export const boardStopSchema = z.object({
  boardId: z.number().int(),
  stoppedAt: z.number().int(),
  reason: z.string(),
  actorId: z.string().nullable(),
});
export type BoardStop = z.infer<typeof boardStopSchema>;

export const stopStateSchema = z.object({
  globalStopped: z.boolean(),
  stoppedAt: z.number().int().nullable(),
  reason: z.string().nullable(),
  actorId: z.string().nullable(),
  boards: z.array(boardStopSchema),
  updatedAt: z.number().int(),
});
export type StopState = z.infer<typeof stopStateSchema>;

export const stopRequestSchema = z.strictObject({
  scope: z.enum(["global", "board", "agent"]),
  boardId: z.number().int().positive().optional(),
  agentId: z.string().max(64).optional(),
  reason: z.string().min(1).max(500),
});
export type StopRequest = z.infer<typeof stopRequestSchema>;

export const resumeRequestSchema = z.strictObject({
  scope: z.enum(["global", "board", "agent"]),
  boardId: z.number().int().positive().optional(),
  agentId: z.string().max(64).optional(),
});
export type ResumeRequest = z.infer<typeof resumeRequestSchema>;

export const aiStatusSchema = z.object({
  stop: stopStateSchema,
  counts: z.object({
    agents: z.number().int(),
    activeAgents: z.number().int(),
    suspendedAgents: z.number().int(),
    pendingQueue: z.number().int(),
    executedToday: z.number().int(),
    deniedToday: z.number().int(),
  }),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

export const EMPTY_STOP_STATE: StopState = {
  globalStopped: false,
  stoppedAt: null,
  reason: null,
  actorId: null,
  boards: [],
  updatedAt: 0,
};
