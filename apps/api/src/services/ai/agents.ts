// AI 管理者（agent）の永続化・認証・委譲チェック。
// API キーは SHA-256 ハッシュのみで照合し、平文は発行時に一度だけ返す。
// 委譲者（作成した人間）が権限を失った/停止された場合、その agent は即座に拒否される。

import {
  ApiError,
  allowedBoardsSchema,
  type AiAgent,
  type AllowedBoards,
  type CreateAiAgentInput,
  type RiskCap,
  ulid,
  type UpdateAiAgentInput,
} from "shared";
import type { Env } from "../../lib/env";
import { generateApiKey, hashApiKey, apiKeyPrefix } from "./keys";
import type { AiAgentContext, AiPolicyRule } from "./policy-engine";

export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  owner_type: "site" | "board" | "account";
  owner_id: string;
  board_id: number | null;
  allowed_boards: string;
  risk_cap: RiskCap;
  status: "active" | "suspended" | "revoked";
  suspended_reason: string | null;
  rate_limit_per_min: number;
  daily_limit: number;
  display_name: string;
  key_hash: string;
  key_prefix: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

const AGENT_COLUMNS = `id, name, description, owner_type, owner_id, board_id, allowed_boards,
  risk_cap, status, suspended_reason, rate_limit_per_min, daily_limit, display_name,
  key_hash, key_prefix, created_by, created_at, updated_at, last_used_at`;

function parseAllowedBoards(raw: string): AllowedBoards {
  try {
    const parsed = allowedBoardsSchema.safeParse(JSON.parse(raw));
    // 壊れた値は「担当板なし」に倒す（fail-closed）。
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function mapAgentRow(row: AgentRow): AiAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    boardId: row.board_id,
    allowedBoards: parseAllowedBoards(row.allowed_boards),
    riskCap: row.risk_cap,
    status: row.status,
    suspendedReason: row.suspended_reason,
    rateLimitPerMin: row.rate_limit_per_min,
    dailyLimit: row.daily_limit,
    displayName: row.display_name,
    keyPrefix: row.key_prefix,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

/** DB 行から政策判定用コンテキストを作る（政策は別途 `attachPolicies` で付与）。 */
export function agentContextFromRow(row: AgentRow, policies: AiPolicyRule[] = []): AiAgentContext {
  const agent = mapAgentRow(row);
  return {
    id: agent.id,
    name: agent.name,
    ownerType: agent.ownerType,
    ownerId: agent.ownerId,
    boardId: agent.boardId,
    allowedBoards: agent.allowedBoards,
    riskCap: agent.riskCap,
    status: agent.status,
    rateLimitPerMin: agent.rateLimitPerMin,
    dailyLimit: agent.dailyLimit,
    displayName: agent.displayName,
    policies,
  };
}

export interface AgentListFilter {
  /** サイト管理者: 全件 */
  all?: boolean;
  /** 作成者本人の agent */
  createdBy?: string;
  /** 板管理人が管理する板の agent */
  boardIds?: number[];
}

export async function listAgents(env: Env, filter: AgentListFilter): Promise<AiAgent[]> {
  if (filter.all) {
    const rows = await env.DB.prepare(
      `SELECT ${AGENT_COLUMNS} FROM ai_agents ORDER BY created_at DESC LIMIT 200`,
    ).all<AgentRow>();
    return (rows.results ?? []).map(mapAgentRow);
  }

  const clauses: string[] = [];
  const bindings: unknown[] = [];
  if (filter.createdBy) {
    clauses.push("created_by = ?");
    bindings.push(filter.createdBy);
  }
  if (filter.boardIds && filter.boardIds.length > 0) {
    clauses.push(`board_id IN (${filter.boardIds.map(() => "?").join(",")})`);
    bindings.push(...filter.boardIds);
  }
  if (clauses.length === 0) return [];
  const rows = await env.DB.prepare(
    `SELECT ${AGENT_COLUMNS} FROM ai_agents WHERE ${clauses.join(" OR ")} ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(...bindings)
    .all<AgentRow>();
  return (rows.results ?? []).map(mapAgentRow);
}

export async function getAgentRow(env: Env, agentId: string): Promise<AgentRow | null> {
  return env.DB.prepare(`SELECT ${AGENT_COLUMNS} FROM ai_agents WHERE id = ?`)
    .bind(agentId)
    .first<AgentRow>();
}

/** agent に適用される政策を読み込む（site 既定 + 対象板 + agent 固有）。 */
export async function loadPolicies(
  env: Env,
  agentId: string,
  boardId?: number | null,
): Promise<AiPolicyRule[]> {
  const rows = await env.DB.prepare(
    `SELECT scope, scope_id, action, mode FROM ai_policies
     WHERE (scope = 'site' AND scope_id = 'site')
        OR (scope = 'agent' AND scope_id = ?1)
        OR (scope = 'board' AND scope_id = ?2)`,
  )
    .bind(agentId, boardId === null || boardId === undefined ? "" : String(boardId))
    .all<{ scope: AiPolicyRule["scope"]; scope_id: string; action: string; mode: AiPolicyRule["mode"] }>();
  return (rows.results ?? []).map((row) => ({
    scope: row.scope,
    scopeId: row.scope_id,
    action: row.action,
    mode: row.mode,
  }));
}

/** 対象板が決まった後の政策読み込み。 */
export async function attachPolicies(
  env: Env,
  agent: AiAgentContext,
  boardId?: number | null,
): Promise<AiAgentContext> {
  return { ...agent, policies: await loadPolicies(env, agent.id, boardId) };
}

/**
 * 委譲者が今も有効かを検証する。site agent は作成者が owner/special_admin であること、
 * board agent は作成者がその板の admin（またはサイト管理者）であることを毎回確認する。
 */
export async function assertDelegatorActive(env: Env, row: AgentRow): Promise<void> {
  const creator = await env.DB.prepare("SELECT id, role, status FROM accounts WHERE id = ?")
    .bind(row.created_by)
    .first<{ id: string; role: "owner" | "special_admin" | "user"; status: "active" | "suspended" }>();

  if (!creator || creator.status !== "active") {
    throw ApiError.forbidden("委譲者アカウントが無効です");
  }

  if (row.owner_type === "site") {
    if (creator.role !== "owner" && creator.role !== "special_admin") {
      throw ApiError.forbidden("サイト AI の委譲者はサイト管理者である必要があります");
    }
    return;
  }

  if (row.owner_type === "board") {
    if (creator.role === "owner" || creator.role === "special_admin") return;
    if (row.board_id === null) throw ApiError.forbidden("板が指定されていません");
    const staff = await env.DB.prepare(
      "SELECT level FROM board_staff WHERE board_id = ? AND account_id = ? AND level = 'admin'",
    )
      .bind(row.board_id, creator.id)
      .first<{ level: string }>();
    if (!staff) throw ApiError.forbidden("委譲者はこの板の管理人ではありません");
  }
}

/**
 * Bearer キーから agent を認証する。停止フラグ（AiGate）は呼び出し側で先に確認する。
 * 返り値は政策未適用のコンテキスト（対象板確定後に `attachPolicies()` する）。
 */
export async function authenticateAiKey(env: Env, apiKey: string): Promise<AiAgentContext> {
  const keyHash = await hashApiKey(apiKey);
  const row = await env.DB.prepare(`SELECT ${AGENT_COLUMNS} FROM ai_agents WHERE key_hash = ?`)
    .bind(keyHash)
    .first<AgentRow>();
  if (!row) throw ApiError.unauthorized("AI API キーが不正です");
  if (row.status === "revoked") throw ApiError.forbidden("この AI 管理者は削除されています");
  if (row.status === "suspended") {
    throw new ApiError(403, "FORBIDDEN", `AI 管理者は停止中です: ${row.suspended_reason ?? "理由なし"}`);
  }

  await assertDelegatorActive(env, row);

  const now = Math.floor(Date.now() / 1000);
  if (row.last_used_at === null || now - row.last_used_at > 60) {
    await env.DB.prepare("UPDATE ai_agents SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
  }

  return agentContextFromRow(row);
}

// ─────────────────────────── 作成・更新（人間セッション） ───────────────────────────

export interface ActorIdentity {
  accountId: string;
  role: "owner" | "special_admin" | "user";
}

async function assertBoardAdmin(env: Env, accountId: string, boardId: number): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT level FROM board_staff WHERE board_id = ? AND account_id = ? AND level = 'admin'",
  )
    .bind(boardId, accountId)
    .first<{ level: string }>();
  if (!row) throw ApiError.forbidden(`板 ${boardId} の管理人ではありません`);
}

/**
 * agent 作成の権限検査。委譲者の権限 ∩ 担当板の範囲内のみ許可する。
 * - site: owner/special_admin のみ。allowedBoards は "*" または全板リスト。
 * - board: 対象板の admin（またはサイト管理者）。allowedBoards は自分が admin の板のみ。
 * - account: 本人のアカウント AI。risk_cap は medium まで。担当板は指定可能。
 */
export async function assertCanCreateAgent(
  env: Env,
  actor: ActorIdentity,
  input: CreateAiAgentInput,
): Promise<{ ownerId: string; boardId: number | null; allowedBoards: AllowedBoards }> {
  const isSiteAdmin = actor.role === "owner" || actor.role === "special_admin";

  if (input.ownerType === "site") {
    if (!isSiteAdmin) throw ApiError.forbidden("サイト AI を登録できるのはサイト管理者のみです");
    return { ownerId: "site", boardId: null, allowedBoards: input.allowedBoards };
  }

  if (input.ownerType === "board") {
    if (!input.boardId) throw ApiError.validation("boardId が必要です");
    if (!isSiteAdmin) await assertBoardAdmin(env, actor.accountId, input.boardId);
    if (input.allowedBoards === "*") {
      if (!isSiteAdmin) throw ApiError.forbidden("全板担当はサイト管理者のみ許可されます");
    } else if (!isSiteAdmin) {
      for (const boardId of input.allowedBoards) {
        await assertBoardAdmin(env, actor.accountId, boardId);
      }
    }
    return { ownerId: String(input.boardId), boardId: input.boardId, allowedBoards: input.allowedBoards };
  }

  // account
  if (input.allowedBoards === "*") {
    throw ApiError.forbidden("アカウント所有の AI は全板担当にできません");
  }
  if (input.riskCap === "high") {
    throw ApiError.forbidden("アカウント所有の AI の risk_cap は medium までです");
  }
  return { ownerId: actor.accountId, boardId: null, allowedBoards: input.allowedBoards };
}

export interface CreatedAgent {
  agent: AiAgent;
  apiKey: string;
}

export async function createAgent(
  env: Env,
  actor: ActorIdentity,
  input: CreateAiAgentInput,
): Promise<CreatedAgent> {
  const scope = await assertCanCreateAgent(env, actor, input);

  const id = ulid();
  const apiKey = generateApiKey();
  const keyHash = await hashApiKey(apiKey);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO ai_agents
       (id, name, description, owner_type, owner_id, board_id, allowed_boards, risk_cap,
        status, suspended_reason, rate_limit_per_min, daily_limit, display_name,
        key_hash, key_prefix, key_rotated_at, created_by, created_at, updated_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      input.name,
      input.description ?? null,
      input.ownerType,
      scope.ownerId,
      scope.boardId,
      JSON.stringify(scope.allowedBoards),
      input.riskCap,
      input.rateLimitPerMin,
      input.dailyLimit,
      input.displayName,
      keyHash,
      apiKeyPrefix(apiKey),
      now,
      actor.accountId,
      now,
      now,
    )
    .run();

  const row = await getAgentRow(env, id);
  if (!row) throw new ApiError(500, "INTERNAL", "AI 管理者の作成に失敗しました");
  return { agent: mapAgentRow(row), apiKey };
}

/** agent の所有者（委譲者 or サイト管理者/板管理人）であることを確認する。 */
export async function assertCanManageAgent(
  env: Env,
  actor: ActorIdentity,
  row: AgentRow,
): Promise<void> {
  if (actor.role === "owner" || actor.role === "special_admin") return;
  if (row.created_by === actor.accountId) return;
  if (row.owner_type === "board" && row.board_id !== null) {
    await assertBoardAdmin(env, actor.accountId, row.board_id);
    return;
  }
  throw ApiError.forbidden("この AI 管理者を操作する権限がありません");
}

export async function updateAgent(
  env: Env,
  row: AgentRow,
  input: UpdateAiAgentInput,
): Promise<AiAgent> {
  const allowedBoards =
    input.allowedBoards === undefined ? parseAllowedBoards(row.allowed_boards) : input.allowedBoards;
  if (row.owner_type === "account" && allowedBoards === "*") {
    throw ApiError.forbidden("アカウント所有の AI は全板担当にできません");
  }
  if (input.riskCap === "high" && row.owner_type === "account") {
    throw ApiError.forbidden("アカウント所有の AI の risk_cap は medium までです");
  }

  const next = {
    name: input.name ?? row.name,
    description: input.description === undefined ? row.description : input.description,
    allowed_boards: JSON.stringify(allowedBoards),
    risk_cap: input.riskCap ?? row.risk_cap,
    rate_limit_per_min: input.rateLimitPerMin ?? row.rate_limit_per_min,
    daily_limit: input.dailyLimit ?? row.daily_limit,
    display_name: input.displayName ?? row.display_name,
  };

  await env.DB.prepare(
    `UPDATE ai_agents SET name = ?, description = ?, allowed_boards = ?, risk_cap = ?,
       rate_limit_per_min = ?, daily_limit = ?, display_name = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      next.name,
      next.description,
      next.allowed_boards,
      next.risk_cap,
      next.rate_limit_per_min,
      next.daily_limit,
      next.display_name,
      Math.floor(Date.now() / 1000),
      row.id,
    )
    .run();

  const updated = await getAgentRow(env, row.id);
  if (!updated) throw new ApiError(500, "INTERNAL", "AI 管理者の更新に失敗しました");
  return mapAgentRow(updated);
}

/** キーをローテーションし、新しい平文キーを一度だけ返す。 */
export async function rotateAgentKey(env: Env, row: AgentRow): Promise<{ agent: AiAgent; apiKey: string }> {
  const apiKey = generateApiKey();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE ai_agents SET key_hash = ?, key_prefix = ?, key_rotated_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(await hashApiKey(apiKey), apiKeyPrefix(apiKey), now, now, row.id)
    .run();
  const updated = await getAgentRow(env, row.id);
  if (!updated) throw new ApiError(500, "INTERNAL", "キーのローテーションに失敗しました");
  return { agent: mapAgentRow(updated), apiKey };
}

export async function setAgentStatus(
  env: Env,
  agentId: string,
  status: "active" | "suspended" | "revoked",
  reason: string | null,
): Promise<AiAgent> {
  await env.DB.prepare(
    "UPDATE ai_agents SET status = ?, suspended_reason = ?, updated_at = ? WHERE id = ?",
  )
    .bind(status, status === "active" ? null : reason, Math.floor(Date.now() / 1000), agentId)
    .run();
  const updated = await getAgentRow(env, agentId);
  if (!updated) throw ApiError.notFound("AI 管理者が見つかりません");
  return mapAgentRow(updated);
}