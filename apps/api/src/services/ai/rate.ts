// AI 操作のレート/日次上限（D1 カウンタ）。
// 1 AI 操作 = 2 行の upsert（分・日）。DO を使わないのは、判定と監査を同一トランザクション境界に
// 置かずに済ませ、REST/MCP の両経路で同じ結果にするため。

import type { Env } from "../../lib/env";
import type { AiAgentContext } from "./policy-engine";

export interface RateResult {
  allowed: boolean;
  minuteCount: number;
  dayCount: number;
  limit: "minute" | "day" | null;
}

const MINUTE = 60;
const DAY = 86_400;

async function bump(
  env: Env,
  agentId: string,
  kind: "minute" | "day",
  windowStart: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO ai_rate_counters (agent_id, kind, window_start, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(agent_id, kind, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(agentId, kind, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/** 分・日のカウンタを加算し、上限超過なら allowed=false を返す。 */
export async function consumeAiRate(
  env: Env,
  agent: Pick<AiAgentContext, "id" | "rateLimitPerMin" | "dailyLimit">,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<RateResult> {
  const minuteStart = nowSeconds - (nowSeconds % MINUTE);
  const dayStart = nowSeconds - (nowSeconds % DAY);

  const [minuteCount, dayCount] = await Promise.all([
    bump(env, agent.id, "minute", minuteStart),
    bump(env, agent.id, "day", dayStart),
  ]);

  if (minuteCount > agent.rateLimitPerMin) {
    return { allowed: false, minuteCount, dayCount, limit: "minute" };
  }
  if (dayCount > agent.dailyLimit) {
    return { allowed: false, minuteCount, dayCount, limit: "day" };
  }
  return { allowed: true, minuteCount, dayCount, limit: null };
}