// REST/MCP 共通の唯一の政策強制点（DESIGN §10.2）。
// `enforceAiPolicy` は純粋な判定関数（DB アクセスなし）。呼び出し側は `loadAgentContext()` で
// エージェントと政策を読み込み、必ずこの関数を通してから実行する。

import {
  AI_ACTION_PARAM_SCHEMAS,
  aiActionDefinition,
  defaultModeForRisk,
  type AiActionName,
  type PolicyMode,
  type RiskCap,
  type RiskLevel,
} from "shared";

export interface AiPolicyRule {
  scope: "site" | "board" | "agent";
  action: string;
  mode: PolicyMode;
  scopeId: string;
}

/** 政策判定に必要なエージェントの最小情報。 */
export interface AiAgentContext {
  id: string;
  name: string;
  ownerType: "site" | "board" | "account";
  ownerId: string;
  boardId: number | null;
  allowedBoards: number[] | "*";
  riskCap: RiskCap;
  status: "active" | "suspended" | "revoked";
  rateLimitPerMin: number;
  dailyLimit: number;
  displayName: string;
  policies: AiPolicyRule[];
}

export interface PolicyDecision {
  mode: PolicyMode;
  risk: RiskLevel;
  reason?: string;
}

export interface PolicyEvaluationOptions {
  /**
   * 操作対象の板。params に boardId がない action（post.delete 等）でも
   * 呼び出し側が対象レコードから解決して渡す。
   */
  boardId?: number | null;
}

/** 板の担当範囲チェック。site agent の "*" は全板。 */
export function isBoardAllowed(agent: AiAgentContext, boardId: number): boolean {
  if (agent.allowedBoards === "*") return true;
  return agent.allowedBoards.includes(boardId);
}

/** params から対象板を取り出す（boardId を持つ action のみ）。 */
export function boardIdFromParams(_action: string, params: unknown): number | null {
  if (!params || typeof params !== "object" || !("boardId" in params)) return null;
  const value = params.boardId;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * 政策モードの解決順: agent 固有 > board 固有 > site 既定 > risk 既定表。
 * 同一スコープ内では完全一致 action が '*' より優先される。
 * board スコープの規則は「対象板のもの」だけを適用する（別板の deny が漏れないように）。
 */
export function resolvePolicyMode(
  policies: readonly AiPolicyRule[],
  action: string,
  boardId?: number | null,
): PolicyMode | undefined {
  for (const scope of ["agent", "board", "site"] as const) {
    const scoped = policies.filter(
      (rule) =>
        rule.scope === scope &&
        (scope !== "board" || (boardId !== null && boardId !== undefined && rule.scopeId === String(boardId))),
    );
    const exact = scoped.find((rule) => rule.action === action);
    if (exact) return exact.mode;
    const wildcard = scoped.find((rule) => rule.action === "*");
    if (wildcard) return wildcard.mode;
  }
  return undefined;
}

/**
 * アカウントが接続した private agent に許す action。
 * 委譲者（一般アカウント）が本来できないモデレーションを AI に肩代わりさせないための許可リスト。
 */
const ACCOUNT_AGENT_ACTIONS: Readonly<Record<string, true>> = {
  "board.list": true,
  "board.get": true,
  "thread.list": true,
  "thread.get": true,
  "post.list": true,
  "post.get": true,
  search: true,
  "monitor.feed": true,
  "report.list": true,
  "report.get": true,
  "stats.read": true,
  "classify.draft": true,
  "agent.self": true,
  "agent.suspend_self": true,
  "queue.list": true,
  "queue.cancel_own": true,
  "audit.read": true,
  "post.create": true,
  "post.reply": true,
};

/** 板管理人が接続した board agent に許さないサイト全体操作。 */
const BOARD_AGENT_DENIED_ACTIONS: Readonly<Record<string, true>> = {
  "site.ban": true,
  "site.announce": true,
  "account.suspend": true,
  "board.delete": true,
  "plugin.review_approve": true,
  "plugin.review_reject": true,
  "plugin.suspend": true,
  "bulk.cross_board": true,
  "agent.policy_update": true,
  "agent.risk_cap_update": true,
};

/** agent 自身による権限・政策の変更は常に拒否（自己昇格・他 agent 操作の遮断）。 */
const AGENT_MANAGEMENT_ACTIONS: Readonly<Record<string, true>> = {
  "agent.create": true,
  "agent.delete": true,
  "agent.key_read": true,
  "agent.policy_update": true,
  "agent.risk_cap_update": true,
  "other_agent.read": true,
};

/**
 * 委譲者の権限を超えないことの検査（DESIGN §10.1）。
 * 返り値は拒否理由。null なら委譲範囲内。
 */
export function delegationDenialReason(agent: AiAgentContext, action: string): string | null {
  if (AGENT_MANAGEMENT_ACTIONS[action]) return "AGENT_SELF_MANAGEMENT";
  switch (agent.ownerType) {
    case "site":
      return null;
    case "board":
      return BOARD_AGENT_DENIED_ACTIONS[action] ? "DELEGATION_SCOPE" : null;
    case "account":
      return ACCOUNT_AGENT_ACTIONS[action] ? null : "DELEGATION_SCOPE";
  }
}

/**
 * AI 操作を評価し auto / queue / deny を返す。
 *
 * 不変条件:
 * - `never` と `humanOnly` は政策に関係なく deny（政策エンジンの無効化不可）。
 * - `high` は政策が auto でも queue（人間承認必須）。deny のみ上書き可。
 * - `risk_cap` を超える操作は deny。ただし DESIGN §10.2 に従い medium × risk_cap=low は queue。
 * - `allowed_boards` 外は deny（権限昇格の主要経路を塞ぐ）。
 */
export async function enforceAiPolicy(
  agent: AiAgentContext,
  action: string,
  params: unknown,
  options: PolicyEvaluationOptions = {},
): Promise<PolicyDecision> {
  const definition = aiActionDefinition(action);
  if (!definition) {
    return { mode: "deny", risk: "never", reason: "UNKNOWN_ACTION" };
  }
  const risk = definition.risk;

  if (risk === "never") return { mode: "deny", risk, reason: "NEVER_ACTION" };
  if (definition.humanOnly) return { mode: "deny", risk, reason: "HUMAN_ONLY" };
  if (agent.status !== "active") return { mode: "deny", risk, reason: "AGENT_INACTIVE" };

  // パラメータは strict スキーマで検証（未知キー = 権限フィールドの混入を拒否）。
  const schema = AI_ACTION_PARAM_SCHEMAS[action as AiActionName];
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) return { mode: "deny", risk, reason: "INVALID_PARAMS" };

  const boardId = options.boardId ?? boardIdFromParams(action, parsed.data);
  // boardId 省略時に全板集約になる読み取りは、担当板限定 agent には許可しない（M-1）。
  // stats.read は件数のみだが、monitor.feed / report.list は本文・通報理由を返す。
  if (
    boardId === null &&
    agent.allowedBoards !== "*" &&
    (action === "monitor.feed" || action === "report.list")
  ) {
    return { mode: "deny", risk, reason: "BOARD_SCOPE" };
  }
  if (boardId !== null && boardId !== undefined && !isBoardAllowed(agent, boardId)) {
    return { mode: "deny", risk, reason: "BOARD_SCOPE" };
  }

  const delegationReason = delegationDenialReason(agent, action);
  if (delegationReason) return { mode: "deny", risk, reason: delegationReason };

  const policyMode = resolvePolicyMode(agent.policies, action, boardId);
  if (policyMode === "deny") return { mode: "deny", risk, reason: "POLICY_DENY" };

  const riskRank = { low: 0, medium: 1, high: 2 } as const;
  if (risk === "high") {
    // risk_cap が high 未満なら high 操作は要求すらできない。
    if (riskRank[agent.riskCap] < riskRank.high) {
      return { mode: "deny", risk, reason: "RISK_CAP_EXCEEDED" };
    }
    return {
      mode: "queue",
      risk,
      reason: policyMode === "auto" ? "HIGH_ALWAYS_QUEUED" : "HIGH_QUEUE",
    };
  }

  if (risk === "medium" && riskRank[agent.riskCap] < riskRank.medium) {
    // DESIGN §10.2: risk_cap=low の agent の medium 操作は自動実行せず承認キューへ。
    return { mode: "queue", risk, reason: "RISK_CAP_LOW_QUEUE" };
  }

  const mode = policyMode ?? defaultModeForRisk(risk);
  return { mode, risk, reason: policyMode ? "POLICY" : "DEFAULT" };
}