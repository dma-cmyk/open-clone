// AI 運営 E2E の共通ヘルパ（実スタック: wrangler dev + 固定 E2E セッション）。
import { expect, type APIRequestContext } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope, type ApiEnvelope } from "../helpers/api";

export const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

export interface Result<T> {
  status: number;
  envelope: ApiEnvelope<T> | null;
}

export interface CreatedAgent {
  id: string;
  apiKey: string;
  name: string;
  riskCap: string;
  allowedBoards: number[] | "*";
}

/** 人間（owner 固定セッション）として /v1 を叩く。 */
export async function asOwner<T>(
  request: APIRequestContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<Result<T>> {
  const response = await request.fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Origin: ALLOWED_ORIGIN,
      Cookie: OWNER_COOKIE,
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), envelope: await readEnvelope<T>(response) };
}

/** AI 管理者の Bearer キーで /v1/ai/* を叩く。 */
export async function asAi<T>(
  request: APIRequestContext,
  apiKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<Result<T>> {
  const response = await request.fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Origin: ALLOWED_ORIGIN,
      Authorization: `Bearer ${apiKey}`,
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), envelope: await readEnvelope<T>(response) };
}

/** 成功 envelope を剥がす（失敗時は本文つきでテストを落とす）。 */
export function dataOf<T>(result: Result<T>, label: string, expectedStatus?: number): T {
  if (expectedStatus !== undefined) {
    expect(result.status, `${label}: ${JSON.stringify(result.envelope)}`).toBe(expectedStatus);
  }
  expect(result.envelope?.ok, `${label}: ${JSON.stringify(result.envelope)}`).toBe(true);
  if (!result.envelope || !result.envelope.ok) {
    throw new Error(`${label} が失敗しました: ${JSON.stringify(result.envelope)}`);
  }
  return result.envelope.data;
}

/** 失敗 envelope の code を検証する。 */
export function expectFailure(result: Result<unknown>, status: number, code?: string): void {
  expect(result.status, JSON.stringify(result.envelope)).toBe(status);
  expect(result.envelope?.ok, JSON.stringify(result.envelope)).toBe(false);
  if (code && result.envelope && !result.envelope.ok) {
    expect(result.envelope.code, JSON.stringify(result.envelope)).toBe(code);
  }
}

export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function createBoard(
  request: APIRequestContext,
  suffix: string,
): Promise<{ id: number; slug: string }> {
  const slug = `ai-e2e-${suffix}`.slice(0, 32);
  const created = dataOf<{ board: { id: number } }>(
    await asOwner(request, "POST", "/v1/boards", {
      slug,
      name: `AI E2E ${suffix}`,
      category: "テスト",
      description: "AI 運営 E2E 用の一時板",
    }),
    "board.create",
    201,
  );
  return { id: created.board.id, slug };
}

export async function createThread(
  request: APIRequestContext,
  slug: string,
  title: string,
): Promise<{ threadId: number; postId: number }> {
  const created = dataOf<{ threadId: number; post: { id: number } }>(
    await asOwner(request, "POST", `/v1/boards/${encodeURIComponent(slug)}/threads`, {
      title,
      body: "AI 運営 E2E のスレ本文です。",
    }),
    "thread.create",
    201,
  );
  return { threadId: created.threadId, postId: created.post.id };
}

export async function createAgent(
  request: APIRequestContext,
  input: {
    name: string;
    boardId: number;
    riskCap: "low" | "medium" | "high";
    rateLimitPerMin?: number;
    dailyLimit?: number;
    ownerType?: "board" | "site" | "account";
    allowedBoards?: number[] | "*";
  },
): Promise<CreatedAgent> {
  const ownerType = input.ownerType ?? "board";
  const created = dataOf<CreatedAgent>(
    await asOwner(request, "POST", "/v1/ai/agents", {
      name: input.name,
      description: "E2E 用 AI",
      ownerType,
      ...(ownerType === "board" ? { boardId: input.boardId } : {}),
      allowedBoards: input.allowedBoards ?? [input.boardId],
      riskCap: input.riskCap,
      rateLimitPerMin: input.rateLimitPerMin ?? 120,
      dailyLimit: input.dailyLimit ?? 5000,
      displayName: "E2E AI",
    }),
    "agent.create",
    201,
  );
  return created;
}

/** 承認キューから該当 action の pending を探す。 */
export async function findPendingQueueId(
  request: APIRequestContext,
  agentId: string,
  action: string,
): Promise<string> {
  const page = dataOf<{ items: { id: string; agentId: string; action: string; status: string }[] }>(
    await asOwner(request, "GET", "/v1/ai/queue?status=pending&limit=100"),
    "queue.list",
    200,
  );
  const hit = page.items.find((item) => item.agentId === agentId && item.action === action);
  expect(hit, `pending queue に ${action} (agent=${agentId}) がありません`).toBeTruthy();
  return hit!.id;
}

export interface RunResult {
  action: string;
  risk: string;
  mode: string;
  status: "executed" | "queued" | "denied";
  reason?: string;
  result?: unknown;
  queueId?: string;
}

/** 停止テスト以外の AI 呼び出しは、他 spec の緊急停止テストとの競合を避けて 1 回だけ再試行する。 */
export async function aiCall(
  request: APIRequestContext,
  apiKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<Result<RunResult>> {
  const first = await asAi<RunResult>(request, apiKey, method, path, data);
  if (first.status === 503 && first.envelope && !first.envelope.ok && first.envelope.code === "AI_STOPPED") {
    return asAi<RunResult>(request, apiKey, method, path, data);
  }
  return first;
}