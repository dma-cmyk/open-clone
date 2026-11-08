// Webhook イベントの生成ヘルパ。
// ルート/サービスはここを呼ぶだけにし、ペイロード形（schemas/webhook.ts）を一元管理する。

import { ulid, type AiQueueItem, type WebhookEvent } from "shared";
import type { Env } from "../../lib/env";
import { emitWebhookEvent } from "./webhook";

type Waiter = ((promise: Promise<unknown>) => void) | undefined;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function siteEvent(type: WebhookEvent["type"], data: Record<string, unknown>): WebhookEvent {
  return { id: ulid(), type, createdAt: now(), owner: { type: "site", id: "site" }, data };
}

function boardEvent(
  type: WebhookEvent["type"],
  boardId: number | null,
  data: Record<string, unknown>,
): WebhookEvent {
  return boardId === null
    ? siteEvent(type, data)
    : { id: ulid(), type, createdAt: now(), owner: { type: "board", id: String(boardId) }, data };
}

/**
 * 通報作成イベント（WP1 の POST /v1/reports から呼ぶ）。
 * 通報本文は信頼できない入力のため、そのまま（原文）をデータとして渡す。
 */
export async function emitReportCreated(
  env: Env,
  report: {
    id: string;
    boardId: number;
    threadId: number;
    postIds: number[];
    nums: string;
    reason: string;
    comment?: string;
  },
  waitUntil?: Waiter,
): Promise<void> {
  await emitWebhookEvent(
    env,
    boardEvent("report.created", report.boardId, {
      reportId: report.id,
      boardId: report.boardId,
      threadId: report.threadId,
      postIds: report.postIds,
      nums: report.nums,
      reason: report.reason,
      comment: report.comment ?? "",
    }),
    { waitUntil },
  );
}

export async function emitQueuePending(env: Env, item: AiQueueItem, waitUntil?: Waiter): Promise<void> {
  await emitWebhookEvent(
    env,
    boardEvent("queue.pending", item.boardId, {
      queueId: item.id,
      agentId: item.agentId,
      action: item.action,
      risk: item.risk,
      summary: item.summary,
      expiresAt: item.expiresAt,
    }),
    { waitUntil },
  );
}

export async function emitQueueDecided(
  env: Env,
  item: AiQueueItem,
  decision: "approve" | "reject",
  reviewerId: string,
  waitUntil?: Waiter,
): Promise<void> {
  await emitWebhookEvent(
    env,
    boardEvent("queue.decided", item.boardId, {
      queueId: item.id,
      agentId: item.agentId,
      action: item.action,
      status: item.status,
      decision,
      reviewerId,
    }),
    { waitUntil },
  );
}

export async function emitAgentSuspended(
  env: Env,
  agent: { id: string; name: string; boardId: number | null },
  reason: string,
  suspendedBy: string,
  waitUntil?: Waiter,
): Promise<void> {
  await emitWebhookEvent(
    env,
    boardEvent("agent.suspended", agent.boardId, {
      agentId: agent.id,
      agentName: agent.name,
      reason,
      suspendedBy,
    }),
    { waitUntil },
  );
}

export async function emitAiStopped(
  env: Env,
  input: { scope: "global" | "board"; boardId?: number; reason: string; actorId: string | null },
  waitUntil?: Waiter,
): Promise<void> {
  await emitWebhookEvent(
    env,
    boardEvent("ai.stopped", input.boardId ?? null, {
      scope: input.scope,
      boardId: input.boardId ?? null,
      reason: input.reason,
      actorId: input.actorId,
    }),
    { waitUntil },
  );
}

export async function emitAiResumed(
  env: Env,
  input: { scope: "global" | "board"; boardId?: number; actorId: string | null },
  waitUntil?: Waiter,
): Promise<void> {
  await emitWebhookEvent(
    env,
    boardEvent("ai.resumed", input.boardId ?? null, {
      scope: input.scope,
      boardId: input.boardId ?? null,
      actorId: input.actorId,
    }),
    { waitUntil },
  );
}

export async function emitAnomaly(
  env: Env,
  input: { agentId: string; kind: string; value: number; threshold: number; detail?: string },
  waitUntil?: Waiter,
): Promise<void> {
  await emitWebhookEvent(
    env,
    siteEvent("anomaly.detected", {
      agentId: input.agentId,
      kind: input.kind,
      value: input.value,
      threshold: input.threshold,
      detail: input.detail ?? null,
    }),
    { waitUntil },
  );
}

export async function emitPluginReviewRequested(
  env: Env,
  input: { pluginId: string; pluginName: string; version: string; reviewId: string | null },
  waitUntil?: Waiter,
): Promise<void> {
  await emitWebhookEvent(
    env,
    siteEvent("plugin.review.requested", {
      pluginId: input.pluginId,
      pluginName: input.pluginName,
      version: input.version,
      reviewId: input.reviewId,
    }),
    { waitUntil },
  );
}