// AiGate DO のクライアント（緊急停止の読み書き）。
// 全 AI 認証は `checkStopped()` を 1 回呼ぶ。DO が落ちている場合は fail-closed（503）。

import { ApiError, EMPTY_STOP_STATE, type StopState } from "shared";
import type { Env } from "../../lib/env";

async function callGate(env: Env, path: string, init?: RequestInit): Promise<Response> {
  try {
    return await env.AI_GATE.get(env.AI_GATE.idFromName("global")).fetch(
      `https://ai-gate.internal${path}`,
      init,
    );
  } catch (error) {
    console.error("AI_GATE_UNAVAILABLE", error);
    throw new ApiError(503, "MISCONFIGURED", "AI 停止フラグを読み取れません（安全側で拒否します）");
  }
}

export async function readStopState(env: Env): Promise<StopState> {
  const response = await callGate(env, "/state");
  if (!response.ok) return EMPTY_STOP_STATE;
  return (await response.json()) as StopState;
}

export interface StopCheck {
  stopped: boolean;
  scope?: "global" | "board";
  reason?: string | null;
}

export async function checkStopped(env: Env, boardId?: number | null): Promise<StopCheck> {
  const query = boardId === undefined || boardId === null ? "" : `?boardId=${boardId}`;
  const response = await callGate(env, `/check${query}`);
  if (!response.ok) {
    throw new ApiError(503, "MISCONFIGURED", "AI 停止フラグを読み取れません（安全側で拒否します）");
  }
  return (await response.json()) as StopCheck;
}

export interface StopInput {
  scope: "global" | "board";
  boardId?: number;
  reason: string;
  actorId: string | null;
}

export async function stopAi(env: Env, input: StopInput): Promise<StopState> {
  const response = await callGate(env, "/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(500, "INTERNAL", "AI の停止に失敗しました");
  return (await response.json()) as StopState;
}

export async function resumeAi(
  env: Env,
  input: { scope: "global" | "board"; boardId?: number; actorId: string | null },
): Promise<StopState> {
  const response = await callGate(env, "/resume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new ApiError(500, "INTERNAL", "AI の停止解除に失敗しました");
  return (await response.json()) as StopState;
}