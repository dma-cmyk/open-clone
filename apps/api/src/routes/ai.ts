// AI 運営 REST（/v1/ai/*）。
// 2 種類の認証を同居させる:
//   - 人間セッション（Cookie）: agent 管理・政策・承認・監査・緊急停止・Webhook
//   - AI API キー（Bearer ocai_...）: 読み取り・投稿・モデレーション（政策エンジン経由）
// AI キーで人間専用エンドポイントに来た場合は 401/403 になり、権限昇格は成立しない。

import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AI_ACTION_NAMES,
  ApiError,
  aiActionDefinition,
  aiStatusSchema,
  createAiAgentInputSchema,
  createWebhookInputSchema,
  isAiActionName,
  ok,
  putAiPolicyInputSchema,
  queueDecideInputSchema,
  resumeRequestSchema,
  stopRequestSchema,
  ulid,
  updateAiAgentInputSchema,
  updateWebhookInputSchema,
  pluginAiCompleteSchema,
  type AiAgent,
  type AuditResult,
  type QueueStatus,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireAuth } from "../lib/middleware/auth";
import { toErrorResponse } from "../lib/middleware/error";
import { recordAiAudit, queryAudit } from "../services/ai/audit";
import {
  assertCanManageAgent,
  authenticateAiKey,
  createAgent,
  getAgentRow,
  listAgents,
  mapAgentRow,
  rotateAgentKey,
  setAgentStatus,
  updateAgent,
  type AgentRow,
} from "../services/ai/agents";
import type { AiAgentContext } from "../services/ai/policy-engine";
import { emitAgentSuspended, emitAiResumed, emitAiStopped, emitQueueDecided } from "../services/ai/events";
import { readStopState, resumeAi, stopAi } from "../services/ai/gate";
import { parseBearerToken } from "../services/ai/keys";
import { recentMetrics } from "../services/ai/monitor";
import {
  approveQueueItem,
  assertCanDecide,
  getQueueItem,
  listQueue,
  rejectQueueItem,
} from "../services/ai/queue";
import { runAiAction } from "../services/ai/run";
import { completePluginAi } from "../services/plugins/ai";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listAllWebhooks,
  listDeliveries,
  listWebhooks,
  sendTestEvent,
  updateWebhook,
} from "../services/ai/webhook";

const app = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

// ─────────────────────────── 共通ヘルパ ───────────────────────────

function sessionOf(c: Ctx) {
  const session = getReqCtx(c).session;
  if (!session) throw ApiError.unauthorized();
  return session;
}

function isSiteAdmin(role: string): boolean {
  return role === "owner" || role === "special_admin";
}

async function managedBoardIds(c: Ctx, accountId: string): Promise<number[]> {
  const rows = await c.env.DB.prepare(
    "SELECT board_id FROM board_staff WHERE account_id = ? AND level = 'admin'",
  )
    .bind(accountId)
    .all<{ board_id: number }>();
  return (rows.results ?? []).map((row) => row.board_id);
}

async function assertBoardAdmin(c: Ctx, accountId: string, boardId: number): Promise<void> {
  const row = await c.env.DB.prepare(
    "SELECT level FROM board_staff WHERE board_id = ? AND account_id = ? AND level = 'admin'",
  )
    .bind(boardId, accountId)
    .first<{ level: string }>();
  if (!row) throw ApiError.forbidden("この板の管理人ではありません");
}

/** Bearer キーがあれば AI として認証する（なければ null）。 */
async function optionalAiAgent(c: Ctx): Promise<AiAgentContext | null> {
  const token = parseBearerToken(c.req.header("authorization"));
  if (!token) return null;
  return authenticateAiKey(c.env, token);
}

async function requireAiAgent(c: Ctx): Promise<AiAgentContext> {
  const agent = await optionalAiAgent(c);
  if (!agent) throw ApiError.unauthorized("AI API キー（Authorization: Bearer ocai_...）が必要です");
  return agent;
}

async function runFor(
  c: Ctx,
  agent: AiAgentContext,
  action: string,
  params: unknown,
  idempotencyKey?: string | null,
) {
  const ctx = getReqCtx(c);
  const result = await runAiAction({
    env: c.env,
    agent,
    action,
    params,
    source: "rest",
    idempotencyKey: idempotencyKey ?? null,
    ipHash: ctx.device.ipHash,
    requestId: ctx.requestId,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  });
  return c.json(ok(result), result.status === "queued" ? 202 : 200);
}

async function auditHuman(
  c: Ctx,
  input: {
    action: string;
    risk: "low" | "medium" | "high" | "never";
    mode: string;
    boardId?: number | null;
    params?: unknown;
    result: AuditResult;
    errorCode?: string | null;
    agentId?: string | null;
  },
): Promise<void> {
  const session = sessionOf(c);
  await recordAiAudit(c.env, {
    agentId: input.agentId ?? null,
    actorType: "human",
    actorId: session.account.id,
    action: input.action,
    risk: input.risk,
    mode: input.mode,
    boardId: input.boardId ?? null,
    params: input.params,
    result: input.result,
    errorCode: input.errorCode ?? null,
    ipHash: getReqCtx(c).device.ipHash,
    requestId: getReqCtx(c).requestId,
    source: "admin",
  });
}

async function visibleAgent(c: Ctx, agentId: string): Promise<{ row: AgentRow; agent: AiAgent }> {
  const session = sessionOf(c);
  const row = await getAgentRow(c.env, agentId);
  if (!row) throw ApiError.notFound("AI 管理者が見つかりません");
  if (isSiteAdmin(session.account.role)) return { row, agent: mapAgentRow(row) };
  if (row.created_by === session.account.id) return { row, agent: mapAgentRow(row) };
  if (row.owner_type === "board" && row.board_id !== null) {
    const staff = await c.env.DB.prepare(
      "SELECT level FROM board_staff WHERE board_id = ? AND account_id = ? AND level = 'admin'",
    )
      .bind(row.board_id, session.account.id)
      .first<{ level: string }>();
    if (staff) return { row, agent: mapAgentRow(row) };
  }
  throw ApiError.forbidden("この AI 管理者を閲覧する権限がありません");
}

// ─────────────────────────── プラグイン AI 連携（session/anon） ───────────────────────────

/**
 * プラグインの `ai.complete` RPC の受け口。AI 管理者キーではなく、閲覧者のセッション/端末で呼ぶ。
 * manifest の ai:complete 権限・導入スコープ・レート/日次上限を検証してから接続先へ中継する。
 */
app.post("/complete", async (c) => {
  const ctx = getReqCtx(c);
  const input = pluginAiCompleteSchema.parse(await c.req.json());
  const result = await completePluginAi(c.env, input, {
    accountId: ctx.session?.account.id ?? null,
    deviceHash: ctx.device.deviceHash,
    ipHash: ctx.device.ipHash,
    requestId: ctx.requestId,
  });
  return c.json(ok(result));
});

// ─────────────────────────── AI（Bearer） ───────────────────────────

app.get("/me", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "agent.self", {});
});

const actSchema = z.strictObject({
  action: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

app.post("/act", async (c) => {
  const agent = await requireAiAgent(c);
  const body = actSchema.parse(await c.req.json());
  return runFor(c, agent, body.action, body.params, body.idempotencyKey);
});

app.get("/boards", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "board.list", {
    category: c.req.query("category"),
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
});

app.get("/boards/:id", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "board.get", { boardId: Number(c.req.param("id")) });
});

app.get("/threads", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "thread.list", {
    boardId: Number(c.req.query("boardId")),
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
});

app.get("/threads/:id", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "thread.get", { threadId: Number(c.req.param("id")) });
});

app.get("/threads/:id/posts", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "post.list", {
    threadId: Number(c.req.param("id")),
    afterPostId: c.req.query("after") ? Number(c.req.query("after")) : undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
});

app.get("/posts/:id", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "post.get", { postId: Number(c.req.param("id")) });
});

app.get("/search", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "search", {
    q: c.req.query("q") ?? "",
    boardId: c.req.query("boardId") ? Number(c.req.query("boardId")) : undefined,
    threadId: c.req.query("threadId") ? Number(c.req.query("threadId")) : undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    cursor: c.req.query("cursor"),
  });
});

app.get("/feed", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "monitor.feed", {
    boardId: c.req.query("boardId") ? Number(c.req.query("boardId")) : undefined,
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
});

app.get("/reports", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "report.list", {
    boardId: c.req.query("boardId") ? Number(c.req.query("boardId")) : undefined,
    status: c.req.query("status"),
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
});

app.get("/reports/:id", async (c) => {
  const agent = await requireAiAgent(c);
  return runFor(c, agent, "report.get", { reportId: c.req.param("id") });
});

const triageSchema = z.strictObject({
  priority: z.enum(["low", "normal", "high", "urgent"]),
  verdict: z.enum(["actionable", "invalid", "duplicate"]).optional(),
  note: z.string().max(2000).optional(),
});

app.post("/reports/:id/triage", async (c) => {
  const agent = await requireAiAgent(c);
  const body = triageSchema.parse(await c.req.json());
  return runFor(c, agent, "report.triage", { reportId: c.req.param("id"), ...body });
});

const createPostSchema = z.strictObject({
  boardId: z.number().int().positive(),
  threadId: z.number().int().positive().optional(),
  title: z.string().min(1).max(200).optional(),
  name: z.string().max(100).optional(),
  mail: z.string().max(100).optional(),
  body: z.string().min(1).max(8192),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

app.post("/posts", async (c) => {
  const agent = await requireAiAgent(c);
  const body = createPostSchema.parse(await c.req.json());
  const { idempotencyKey, ...params } = body;
  return runFor(c, agent, "post.create", params, idempotencyKey);
});

app.post("/posts/:id/hide", async (c) => {
  const agent = await requireAiAgent(c);
  const body = z.strictObject({ reason: z.string().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
  return runFor(c, agent, "post.hide", { postId: Number(c.req.param("id")), ...body });
});

app.post("/posts/:id/spam", async (c) => {
  const agent = await requireAiAgent(c);
  const body = z.strictObject({ reason: z.string().max(500).optional() }).parse(await c.req.json().catch(() => ({})));
  return runFor(c, agent, "post.mark_spam", { postId: Number(c.req.param("id")), ...body });
});

app.post("/posts/:id/delete", async (c) => {
  const agent = await requireAiAgent(c);
  const body = z.strictObject({ reason: z.string().min(1).max(500) }).parse(await c.req.json());
  return runFor(c, agent, "post.delete", { postId: Number(c.req.param("id")), reason: body.reason });
});

const boardSettingsSchema = z.strictObject({
  settings: z.strictObject({
    cooldown_seconds: z.number().int().min(0).max(600).optional(),
    turnstile_required: z.boolean().optional(),
    live: z.boolean().optional(),
    wordfilter: z.array(z.string().max(100)).max(200).optional(),
  }),
});

app.patch("/boards/:id/settings", async (c) => {
  const agent = await requireAiAgent(c);
  const body = boardSettingsSchema.parse(await c.req.json());
  return runFor(c, agent, "board.settings_update", {
    boardId: Number(c.req.param("id")),
    settings: body.settings,
  });
});

app.post("/plugins/:id/review", async (c) => {
  const agent = await requireAiAgent(c);
  const body = z
    .strictObject({
      decision: z.enum(["approve", "reject"]),
      note: z.string().max(2000).optional(),
    })
    .parse(await c.req.json());
  const action = body.decision === "approve" ? "plugin.review_approve" : "plugin.review_reject";
  return runFor(c, agent, action, {
    pluginId: c.req.param("id"),
    note: body.note ?? (body.decision === "reject" ? "AI 審査により却下" : undefined),
  });
});

app.post("/suspend-self", async (c) => {
  const agent = await requireAiAgent(c);
  const body = z.strictObject({ reason: z.string().min(1).max(500) }).parse(await c.req.json());
  return runFor(c, agent, "agent.suspend_self", body);
});

// ─────────────────────────── 共有（AI / 人間） ───────────────────────────

app.get("/queue", async (c) => {
  const agent = await optionalAiAgent(c);
  if (agent) {
    return runFor(c, agent, "queue.list", {
      status: c.req.query("status"),
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
  }

  const session = sessionOf(c);
  const status = c.req.query("status") as QueueStatus | "all" | undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const cursor = c.req.query("cursor");

  if (isSiteAdmin(session.account.role)) {
    const page = await listQueue(c.env, { status, limit, cursor });
    return c.json(ok(page));
  }

  const boardIds = await managedBoardIds(c, session.account.id);
  if (boardIds.length === 0) throw ApiError.forbidden("承認キューを閲覧する権限がありません");
  const page = await listQueue(c.env, { status, limit, cursor, boardIds });
  return c.json(ok(page));
});

app.post("/queue/:id/decide", requireAuth, async (c) => {
  const session = sessionOf(c);
  const body = queueDecideInputSchema.parse(await c.req.json());
  const item = await getQueueItem(c.env, c.req.param("id"));
  await assertCanDecide(c.env, { accountId: session.account.id, role: session.account.role }, item);

  const reviewer = { accountId: session.account.id, role: session.account.role };
  const decided =
    body.decision === "approve"
      ? await approveQueueItem(c.env, item, reviewer, body.note ?? null)
      : await rejectQueueItem(c.env, item, reviewer, body.note ?? null);

  await auditHuman(c, {
    action: `queue.${body.decision}`,
    risk: "high",
    mode: "human",
    boardId: item.boardId,
    params: { queueId: item.id, action: item.action, note: body.note ?? null },
    result: decided.status === "failed" ? "error" : "ok",
    agentId: item.agentId,
  });
  await emitQueueDecided(c.env, decided, body.decision, session.account.id, (promise) =>
    c.executionCtx.waitUntil(promise),
  );
  return c.json(ok(decided));
});

app.get("/audit", async (c) => {
  const agent = await optionalAiAgent(c);
  if (agent) {
    return runFor(c, agent, "audit.read", {
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      cursor: c.req.query("cursor"),
    });
  }

  const session = sessionOf(c);
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const cursor = c.req.query("cursor");
  const action = c.req.query("action");
  const result = c.req.query("result") as AuditResult | undefined;

  if (isSiteAdmin(session.account.role)) {
    const page = await queryAudit(c.env, {
      agentId: c.req.query("agentId"),
      action,
      result,
      limit,
      cursor,
    });
    return c.json(ok(page));
  }

  const boardIds = await managedBoardIds(c, session.account.id);
  if (boardIds.length === 0) throw ApiError.forbidden("監査ログを閲覧する権限がありません");
  const page = await queryAudit(c.env, { action, result, limit, cursor, boardIds });
  return c.json(ok(page));
});

// ─────────────────────────── 人間: agent 管理 ───────────────────────────

app.post("/agents", requireAuth, async (c) => {
  const session = sessionOf(c);
  const input = createAiAgentInputSchema.parse(await c.req.json());
  const created = await createAgent(c.env, { accountId: session.account.id, role: session.account.role }, input);
  await auditHuman(c, {
    action: "agent.create",
    risk: "high",
    mode: "human",
    boardId: created.agent.boardId,
    params: { agentId: created.agent.id, name: created.agent.name, riskCap: created.agent.riskCap },
    result: "ok",
    agentId: created.agent.id,
  });
  return c.json(
    ok({
      ...created.agent,
      apiKey: created.apiKey,
      keyWarning: "この API キーは再表示できません。安全な場所に保管してください。",
    }),
    201,
  );
});

app.get("/agents", requireAuth, async (c) => {
  const session = sessionOf(c);
  if (isSiteAdmin(session.account.role)) {
    return c.json(ok({ items: await listAgents(c.env, { all: true }) }));
  }
  const boardIds = await managedBoardIds(c, session.account.id);
  const items = await listAgents(c.env, { createdBy: session.account.id, boardIds });
  return c.json(ok({ items }));
});

app.get("/agents/:id", requireAuth, async (c) => {
  const { agent } = await visibleAgent(c, c.req.param("id"));
  return c.json(ok(agent));
});

app.patch("/agents/:id", requireAuth, async (c) => {
  const session = sessionOf(c);
  const { row } = await visibleAgent(c, c.req.param("id"));
  await assertCanManageAgent(c.env, { accountId: session.account.id, role: session.account.role }, row);
  const input = updateAiAgentInputSchema.parse(await c.req.json());

  if (!isSiteAdmin(session.account.role)) {
    if (row.owner_type === "site") throw ApiError.forbidden("サイト AI を変更できるのはサイト管理者のみです");
    if (input.riskCap === "high" && row.owner_type === "account") {
      throw ApiError.forbidden("アカウント所有の AI の risk_cap は medium までです");
    }
    if (input.allowedBoards && input.allowedBoards !== "*") {
      for (const boardId of input.allowedBoards) {
        await assertBoardAdmin(c, session.account.id, boardId);
      }
    }
    if (input.allowedBoards === "*") throw ApiError.forbidden("全板担当はサイト管理者のみ許可されます");
  }

  const updated = await updateAgent(c.env, row, input);
  await auditHuman(c, {
    action: "agent.update",
    risk: "high",
    mode: "human",
    boardId: updated.boardId,
    params: { agentId: updated.id, changes: input },
    result: "ok",
    agentId: updated.id,
  });
  return c.json(ok(updated));
});

app.post("/agents/:id/rotate-key", requireAuth, async (c) => {
  const session = sessionOf(c);
  const { row } = await visibleAgent(c, c.req.param("id"));
  await assertCanManageAgent(c.env, { accountId: session.account.id, role: session.account.role }, row);
  const rotated = await rotateAgentKey(c.env, row);
  await auditHuman(c, {
    action: "agent.rotate_key",
    risk: "high",
    mode: "human",
    boardId: rotated.agent.boardId,
    params: { agentId: rotated.agent.id },
    result: "ok",
    agentId: rotated.agent.id,
  });
  return c.json(
    ok({
      ...rotated.agent,
      apiKey: rotated.apiKey,
      keyWarning: "旧キーは即時無効になりました。新しいキーは再表示できません。",
    }),
  );
});

app.post("/agents/:id/suspend", requireAuth, async (c) => {
  const session = sessionOf(c);
  const { row } = await visibleAgent(c, c.req.param("id"));
  await assertCanManageAgent(c.env, { accountId: session.account.id, role: session.account.role }, row);
  const body = z.strictObject({ reason: z.string().min(1).max(500) }).parse(await c.req.json());
  const agent = await setAgentStatus(c.env, row.id, "suspended", body.reason);
  await auditHuman(c, {
    action: "agent.suspend",
    risk: "high",
    mode: "human",
    boardId: agent.boardId,
    params: { agentId: agent.id, reason: body.reason },
    result: "ok",
    agentId: agent.id,
  });
  await emitAgentSuspended(
    c.env,
    { id: agent.id, name: agent.name, boardId: agent.boardId },
    body.reason,
    session.account.id,
    (promise) => c.executionCtx.waitUntil(promise),
  );
  return c.json(ok(agent));
});

app.post("/agents/:id/resume", requireAuth, async (c) => {
  const session = sessionOf(c);
  const { row } = await visibleAgent(c, c.req.param("id"));
  if (!isSiteAdmin(session.account.role) && row.created_by !== session.account.id) {
    throw ApiError.forbidden("停止を解除できるのはサイト管理者または作成者のみです");
  }
  const agent = await setAgentStatus(c.env, row.id, "active", null);
  await auditHuman(c, {
    action: "agent.resume",
    risk: "high",
    mode: "human",
    boardId: agent.boardId,
    params: { agentId: agent.id },
    result: "ok",
    agentId: agent.id,
  });
  return c.json(ok(agent));
});

app.delete("/agents/:id", requireAuth, async (c) => {
  const session = sessionOf(c);
  const { row } = await visibleAgent(c, c.req.param("id"));
  if (!isSiteAdmin(session.account.role) && row.created_by !== session.account.id) {
    throw ApiError.forbidden("削除できるのはサイト管理者または作成者のみです");
  }
  const agent = await setAgentStatus(c.env, row.id, "revoked", "削除されました");
  await auditHuman(c, {
    action: "agent.revoke",
    risk: "high",
    mode: "human",
    boardId: agent.boardId,
    params: { agentId: agent.id },
    result: "ok",
    agentId: agent.id,
  });
  return c.json(ok({ id: agent.id, status: agent.status }));
});

// ─────────────────────────── 人間: 政策 ───────────────────────────

app.get("/policies", requireAuth, async (c) => {
  const session = sessionOf(c);
  const scope = c.req.query("scope");
  const scopeId = c.req.query("scopeId");

  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (scope) {
    clauses.push("scope = ?");
    bindings.push(scope);
  }
  if (scopeId) {
    clauses.push("scope_id = ?");
    bindings.push(scopeId);
  }

  if (!isSiteAdmin(session.account.role)) {
    const boardIds = await managedBoardIds(c, session.account.id);
    const ownAgents = await listAgents(c.env, { createdBy: session.account.id });
    const agentIds = ownAgents.map((agent) => agent.id);
    const allowed: string[] = [];
    if (boardIds.length > 0) {
      allowed.push(`(scope = 'board' AND scope_id IN (${boardIds.map(() => "?").join(",")}))`);
      bindings.push(...boardIds.map(String));
    }
    if (agentIds.length > 0) {
      allowed.push(`(scope = 'agent' AND scope_id IN (${agentIds.map(() => "?").join(",")}))`);
      bindings.push(...agentIds);
    }
    if (allowed.length === 0) return c.json(ok({ items: [] }));
    clauses.push(`(${allowed.join(" OR ")})`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, scope, scope_id, action, mode, updated_by, updated_at FROM ai_policies ${where}
     ORDER BY scope, scope_id, action LIMIT 500`,
  )
    .bind(...bindings)
    .all<{
      id: string;
      scope: "site" | "board" | "agent";
      scope_id: string;
      action: string;
      mode: "auto" | "queue" | "deny";
      updated_by: string;
      updated_at: number;
    }>();
  return c.json(
    ok({
      items: (rows.results ?? []).map((row) => ({
        id: row.id,
        scope: row.scope,
        scopeId: row.scope_id,
        action: row.action,
        mode: row.mode,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      })),
    }),
  );
});

app.put("/policies", requireAuth, async (c) => {
  const session = sessionOf(c);
  const input = putAiPolicyInputSchema.parse(await c.req.json());

  if (input.action !== "*" && !isAiActionName(input.action)) {
    throw ApiError.validation("未知の action です");
  }
  if (input.action !== "*") {
    const definition = aiActionDefinition(input.action)!;
    if (definition.risk === "never" || definition.humanOnly) {
      throw ApiError.validation("この action は政策で変更できません");
    }
    if (definition.risk === "high" && input.mode === "auto") {
      throw ApiError.validation("high リスクは auto にできません（常に人間承認が必要です）");
    }
  }

  if (input.scope === "site") {
    if (!isSiteAdmin(session.account.role)) throw ApiError.forbidden("サイト政策を変更できるのはサイト管理者のみです");
  } else if (input.scope === "board") {
    if (!isSiteAdmin(session.account.role)) {
      await assertBoardAdmin(c, session.account.id, Number(input.scopeId));
    }
  } else {
    const row = await getAgentRow(c.env, input.scopeId);
    if (!row) throw ApiError.notFound("AI 管理者が見つかりません");
    await assertCanManageAgent(c.env, { accountId: session.account.id, role: session.account.role }, row);
  }

  const id = ulid();
  const ts = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO ai_policies (id, scope, scope_id, action, mode, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, scope_id, action) DO UPDATE SET mode = excluded.mode,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(id, input.scope, input.scopeId, input.action, input.mode, session.account.id, ts)
    .run();

  await auditHuman(c, {
    action: "policy.update",
    risk: "high",
    mode: "human",
    boardId: input.scope === "board" ? Number(input.scopeId) : null,
    params: input,
    result: "ok",
  });

  const row = await c.env.DB.prepare(
    "SELECT id, scope, scope_id, action, mode, updated_by, updated_at FROM ai_policies WHERE scope = ? AND scope_id = ? AND action = ?",
  )
    .bind(input.scope, input.scopeId, input.action)
    .first<{
      id: string;
      scope: "site" | "board" | "agent";
      scope_id: string;
      action: string;
      mode: "auto" | "queue" | "deny";
      updated_by: string;
      updated_at: number;
    }>();
  return c.json(
    ok({
      id: row?.id ?? id,
      scope: input.scope,
      scopeId: input.scopeId,
      action: input.action,
      mode: input.mode,
      updatedBy: session.account.id,
      updatedAt: ts,
    }),
  );
});

app.delete("/policies/:id", requireAuth, async (c) => {
  const session = sessionOf(c);
  const row = await c.env.DB.prepare("SELECT id, scope, scope_id FROM ai_policies WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ id: string; scope: "site" | "board" | "agent"; scope_id: string }>();
  if (!row) throw ApiError.notFound("政策が見つかりません");

  if (row.scope === "site") {
    if (!isSiteAdmin(session.account.role)) throw ApiError.forbidden();
  } else if (row.scope === "board") {
    if (!isSiteAdmin(session.account.role)) await assertBoardAdmin(c, session.account.id, Number(row.scope_id));
  } else {
    const agentRow = await getAgentRow(c.env, row.scope_id);
    if (!agentRow) throw ApiError.notFound("AI 管理者が見つかりません");
    await assertCanManageAgent(c.env, { accountId: session.account.id, role: session.account.role }, agentRow);
  }

  await c.env.DB.prepare("DELETE FROM ai_policies WHERE id = ?").bind(row.id).run();
  await auditHuman(c, {
    action: "policy.delete",
    risk: "high",
    mode: "human",
    boardId: row.scope === "board" ? Number(row.scope_id) : null,
    params: { policyId: row.id },
    result: "ok",
  });
  return c.json(ok({ id: row.id, deleted: true }));
});

// ─────────────────────────── 人間: 状態・緊急停止 ───────────────────────────

app.get("/status", requireAuth, async (c) => {
  const session = sessionOf(c);
  const stop = await readStopState(c.env);
  const ts = Math.floor(Date.now() / 1000);
  const dayStart = ts - (ts % 86_400);

  const boardIds = isSiteAdmin(session.account.role)
    ? null
    : await managedBoardIds(c, session.account.id);
  if (boardIds !== null && boardIds.length === 0) {
    throw ApiError.forbidden("AI 運営状況を閲覧する権限がありません");
  }

  const agentScope = boardIds === null ? "" : `WHERE board_id IN (${boardIds.map(() => "?").join(",")})`;
  const agentBindings = boardIds ?? [];
  const agents = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
     FROM ai_agents ${agentScope}`,
  )
    .bind(...agentBindings)
    .first<{ total: number; active: number | null; suspended: number | null }>();

  const queueScope = boardIds === null ? "" : `AND board_id IN (${boardIds.map(() => "?").join(",")})`;
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ai_queue WHERE status = 'pending' ${queueScope}`,
  )
    .bind(...agentBindings)
    .first<{ count: number }>();

  const executed = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ai_audit WHERE result = 'ok' AND created_at >= ? ${boardIds === null ? "" : `AND board_id IN (${boardIds.map(() => "?").join(",")})`}`,
  )
    .bind(dayStart, ...agentBindings)
    .first<{ count: number }>();

  const denied = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ai_audit WHERE result = 'denied' AND created_at >= ? ${boardIds === null ? "" : `AND board_id IN (${boardIds.map(() => "?").join(",")})`}`,
  )
    .bind(dayStart, ...agentBindings)
    .first<{ count: number }>();

  return c.json(
    ok(
      aiStatusSchema.parse({
        stop,
        counts: {
          agents: agents?.total ?? 0,
          activeAgents: agents?.active ?? 0,
          suspendedAgents: agents?.suspended ?? 0,
          pendingQueue: pending?.count ?? 0,
          executedToday: executed?.count ?? 0,
          deniedToday: denied?.count ?? 0,
        },
      }),
    ),
  );
});

app.post("/stop", requireAuth, async (c) => {
  const session = sessionOf(c);
  const input = stopRequestSchema.parse(await c.req.json());

  if (input.scope === "global") {
    if (!isSiteAdmin(session.account.role)) throw ApiError.forbidden("全体停止はサイト管理者のみ可能です");
    const state = await stopAi(c.env, {
      scope: "global",
      reason: input.reason,
      actorId: session.account.id,
    });
    await auditHuman(c, {
      action: "ai.stop",
      risk: "high",
      mode: "human",
      params: { scope: "global", reason: input.reason },
      result: "ok",
    });
    await emitAiStopped(
      c.env,
      { scope: "global", reason: input.reason, actorId: session.account.id },
      (promise) => c.executionCtx.waitUntil(promise),
    );
    return c.json(ok(state));
  }

  if (input.scope === "board") {
    if (!input.boardId) throw ApiError.validation("boardId が必要です");
    if (!isSiteAdmin(session.account.role)) {
      await assertBoardAdmin(c, session.account.id, input.boardId);
    }
    const state = await stopAi(c.env, {
      scope: "board",
      boardId: input.boardId,
      reason: input.reason,
      actorId: session.account.id,
    });
    await auditHuman(c, {
      action: "ai.stop",
      risk: "high",
      mode: "human",
      boardId: input.boardId,
      params: { scope: "board", boardId: input.boardId, reason: input.reason },
      result: "ok",
    });
    await emitAiStopped(
      c.env,
      { scope: "board", boardId: input.boardId, reason: input.reason, actorId: session.account.id },
      (promise) => c.executionCtx.waitUntil(promise),
    );
    return c.json(ok(state));
  }

  // agent 単位
  if (!input.agentId) throw ApiError.validation("agentId が必要です");
  const { row } = await visibleAgent(c, input.agentId);
  await assertCanManageAgent(c.env, { accountId: session.account.id, role: session.account.role }, row);
  const agent = await setAgentStatus(c.env, row.id, "suspended", input.reason);
  await auditHuman(c, {
    action: "agent.suspend",
    risk: "high",
    mode: "human",
    boardId: agent.boardId,
    params: { agentId: agent.id, reason: input.reason },
    result: "ok",
    agentId: agent.id,
  });
  await emitAgentSuspended(
    c.env,
    { id: agent.id, name: agent.name, boardId: agent.boardId },
    input.reason,
    session.account.id,
    (promise) => c.executionCtx.waitUntil(promise),
  );
  return c.json(ok(agent));
});

app.post("/resume", requireAuth, async (c) => {
  const session = sessionOf(c);
  const input = resumeRequestSchema.parse(await c.req.json());

  if (input.scope === "agent") {
    if (!input.agentId) throw ApiError.validation("agentId が必要です");
    const { row } = await visibleAgent(c, input.agentId);
    if (!isSiteAdmin(session.account.role) && row.created_by !== session.account.id) {
      throw ApiError.forbidden("停止を解除できるのはサイト管理者または作成者のみです");
    }
    const agent = await setAgentStatus(c.env, row.id, "active", null);
    await auditHuman(c, {
      action: "agent.resume",
      risk: "high",
      mode: "human",
      boardId: agent.boardId,
      params: { agentId: agent.id },
      result: "ok",
      agentId: agent.id,
    });
    return c.json(ok(agent));
  }

  if (!isSiteAdmin(session.account.role)) {
    throw ApiError.forbidden("緊急停止の解除はサイト管理者のみ可能です");
  }
  const state = await resumeAi(c.env, {
    scope: input.scope,
    boardId: input.boardId,
    actorId: session.account.id,
  });
  await auditHuman(c, {
    action: "ai.resume",
    risk: "high",
    mode: "human",
    boardId: input.boardId ?? null,
    params: { scope: input.scope, boardId: input.boardId ?? null },
    result: "ok",
  });
  await emitAiResumed(
    c.env,
    { scope: input.scope, boardId: input.boardId, actorId: session.account.id },
    (promise) => c.executionCtx.waitUntil(promise),
  );
  return c.json(ok(state));
});

// ─────────────────────────── 人間: Webhook ───────────────────────────

async function assertWebhookOwner(
  c: Ctx,
  ownerType: "site" | "board" | "account",
  ownerId: string,
): Promise<void> {
  const session = sessionOf(c);
  if (ownerType === "site") {
    if (!isSiteAdmin(session.account.role)) throw ApiError.forbidden("サイト Webhook はサイト管理者のみです");
    return;
  }
  if (ownerType === "board") {
    if (!isSiteAdmin(session.account.role)) await assertBoardAdmin(c, session.account.id, Number(ownerId));
    return;
  }
  if (ownerId !== session.account.id) throw ApiError.forbidden("他アカウントの Webhook は操作できません");
}

app.get("/webhooks", requireAuth, async (c) => {
  const session = sessionOf(c);
  if (isSiteAdmin(session.account.role)) {
    return c.json(ok({ items: await listAllWebhooks(c.env) }));
  }
  const boardIds = await managedBoardIds(c, session.account.id);
  const items = await listWebhooks(c.env, "account", session.account.id);
  for (const boardId of boardIds) {
    items.push(...(await listWebhooks(c.env, "board", String(boardId))));
  }
  return c.json(ok({ items }));
});

app.post("/webhooks", requireAuth, async (c) => {
  const session = sessionOf(c);
  const input = createWebhookInputSchema.parse(await c.req.json());
  const ownerType = input.ownerType ?? (isSiteAdmin(session.account.role) ? "site" : "account");
  const ownerId =
    input.ownerId ?? (ownerType === "site" ? "site" : ownerType === "account" ? session.account.id : "");
  if (!ownerId) throw ApiError.validation("ownerId が必要です");
  await assertWebhookOwner(c, ownerType, ownerId);

  const webhook = await createWebhook(c.env, {
    ownerType,
    ownerId,
    url: input.url,
    events: input.events,
    description: input.description,
    createdBy: session.account.id,
  });
  await auditHuman(c, {
    action: "webhook.create",
    risk: "high",
    mode: "human",
    boardId: ownerType === "board" ? Number(ownerId) : null,
    params: { webhookId: webhook.id, url: webhook.url, events: webhook.events },
    result: "ok",
  });
  return c.json(ok(webhook), 201);
});

app.patch("/webhooks/:id", requireAuth, async (c) => {
  const webhook = await getWebhook(c.env, c.req.param("id"));
  await assertWebhookOwner(c, webhook.ownerType, webhook.ownerId);
  const input = updateWebhookInputSchema.parse(await c.req.json());
  const updated = await updateWebhook(c.env, webhook.id, input);
  await auditHuman(c, {
    action: "webhook.update",
    risk: "high",
    mode: "human",
    boardId: updated.ownerType === "board" ? Number(updated.ownerId) : null,
    params: { webhookId: updated.id, changes: input },
    result: "ok",
  });
  return c.json(ok(updated));
});

app.delete("/webhooks/:id", requireAuth, async (c) => {
  const webhook = await getWebhook(c.env, c.req.param("id"));
  await assertWebhookOwner(c, webhook.ownerType, webhook.ownerId);
  await deleteWebhook(c.env, webhook.id);
  await auditHuman(c, {
    action: "webhook.delete",
    risk: "high",
    mode: "human",
    boardId: webhook.ownerType === "board" ? Number(webhook.ownerId) : null,
    params: { webhookId: webhook.id },
    result: "ok",
  });
  return c.json(ok({ id: webhook.id, deleted: true }));
});

app.post("/webhooks/:id/test", requireAuth, async (c) => {
  const webhook = await getWebhook(c.env, c.req.param("id"));
  await assertWebhookOwner(c, webhook.ownerType, webhook.ownerId);
  const result = await sendTestEvent(c.env, webhook.id);
  return c.json(ok(result));
});

app.get("/webhooks/:id/deliveries", requireAuth, async (c) => {
  const webhook = await getWebhook(c.env, c.req.param("id"));
  await assertWebhookOwner(c, webhook.ownerType, webhook.ownerId);
  return c.json(ok({ items: await listDeliveries(c.env, webhook.id) }));
});

// ─────────────────────────── 人間: メトリクス・カタログ ───────────────────────────

app.get("/metrics", requireAuth, async (c) => {
  const session = sessionOf(c);
  if (!isSiteAdmin(session.account.role)) throw ApiError.forbidden("メトリクスはサイト管理者のみ閲覧できます");
  return c.json(ok({ items: await recentMetrics(c.env) }));
});

app.get("/actions", requireAuth, async (c) => {
  return c.json(
    ok({
      items: AI_ACTION_NAMES.map((name) => {
        const definition = aiActionDefinition(name)!;
        return {
          name,
          risk: definition.risk,
          description: definition.description,
          humanOnly: definition.humanOnly ?? false,
          approvalScope: definition.approvalScope ?? null,
        };
      }),
    }),
  );
});

// サブアプリは親の errorHandler を経由しないため、同じ envelope 変換をここでも適用する。
app.onError((error) => {
  const { status, body } = toErrorResponse(error);
  return Response.json(body, { status });
});

export default app;