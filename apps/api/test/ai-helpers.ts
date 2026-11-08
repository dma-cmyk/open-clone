// AI 統合テスト用のフィクスチャ（アカウント・板・スレ・レス・セッション）。

import { env, SELF } from "cloudflare:test";
import { randomHex, sha256Hex, ulid } from "shared";

export const BASE = "http://worker.test";

export async function makeAccount(input: {
  name?: string;
  role?: "owner" | "special_admin" | "user";
  status?: "active" | "suspended";
} = {}): Promise<string> {
  const id = ulid();
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)",
  )
    .bind(id, input.name ?? `user-${id.slice(-6)}`, input.role ?? "user", input.status ?? "active", Math.floor(Date.now() / 1000))
    .run();
  return id;
}

export async function makeSession(accountId: string): Promise<string> {
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, NULL, ?, ?)",
  )
    .bind(await sha256Hex(token), accountId, now + 86_400, now, now)
    .run();
  return `oc_sess=${token}`;
}

export async function makeBoard(input: {
  slug?: string;
  name?: string;
  ownerAccountId?: string | null;
  settings?: Record<string, unknown>;
} = {}): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const slug = input.slug ?? `board-${randomHex(4)}`;
  const row = await env.DB.prepare(
    `INSERT INTO boards (slug, name, category, description, rules_md, design, settings, owner_account_id, status, last_post_at, created_at)
     VALUES (?, ?, '雑談', '', '', '{}', ?, ?, 'active', ?, ?) RETURNING id`,
  )
    .bind(
      slug,
      input.name ?? `板 ${slug}`,
      JSON.stringify(input.settings ?? {}),
      input.ownerAccountId ?? null,
      now,
      now,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function addBoardStaff(boardId: number, accountId: string, level: "admin" | "deputy" | "moderator" = "admin"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, ?, NULL, ?)",
  )
    .bind(boardId, accountId, level, Math.floor(Date.now() / 1000))
    .run();
}

export async function makeThread(input: { boardId: number; title?: string }): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO threads (board_id, title, title_flags, live, post_count, max_posts, last_post_at, bump_at, pinned, status, created_at)
     VALUES (?, ?, '{}', 0, 0, 1000, ?, ?, 0, 'active', ?) RETURNING id`,
  )
    .bind(input.boardId, input.title ?? `スレ ${randomHex(3)}`, now, now, now)
    .first<{ id: number }>();
  return row!.id;
}

export async function makePost(input: {
  boardId: number;
  threadId: number;
  body: string;
  hidden?: boolean;
  deleted?: boolean;
}): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO posts (thread_id, board_id, num, name, mail, body, post_id_hash, device_hash, ip_hash,
                        kind, hidden, deleted, created_at)
     VALUES (?, ?,
       (SELECT COALESCE(MAX(num), 0) + 1 FROM posts WHERE thread_id = ? AND kind = 'post'),
       '名無しさん', '', ?, 'abcd', 'dev', 'ip', 'post', ?, ?, ?) RETURNING id`,
  )
    .bind(
      input.threadId,
      input.boardId,
      input.threadId,
      input.body,
      input.hidden ? 1 : 0,
      input.deleted ? 1 : 0,
      now,
    )
    .first<{ id: number }>();
  // 実パイプラインは threads.post_count を num の基準にするため、フィクスチャでも一致させる。
  await env.DB.prepare("UPDATE threads SET post_count = post_count + 1 WHERE id = ?")
    .bind(input.threadId)
    .run();
  return row!.id;
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  key?: string;
  headers?: Record<string, string>;
}

export async function api(path: string, options: ApiOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  return SELF.fetch(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export async function json<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export interface CreatedAgentResponse {
  ok: true;
  data: {
    id: string;
    name: string;
    apiKey: string;
    riskCap: string;
    allowedBoards: number[] | "*";
    status: string;
    keyPrefix: string;
  };
}

export async function createAgent(
  cookie: string,
  input: Record<string, unknown>,
): Promise<{ id: string; apiKey: string; data: CreatedAgentResponse["data"] }> {
  const response = await api("/v1/ai/agents", { method: "POST", cookie, body: input });
  const body = await json<CreatedAgentResponse>(response);
  if (!body.ok) throw new Error(`agent creation failed: ${JSON.stringify(body)}`);
  return { id: body.data.id, apiKey: body.data.apiKey, data: body.data };
}

export async function agentRow(agentId: string): Promise<{
  risk_cap: string;
  status: string;
  allowed_boards: string;
  key_hash: string;
}> {
  const row = await env.DB.prepare(
    "SELECT risk_cap, status, allowed_boards, key_hash FROM ai_agents WHERE id = ?",
  )
    .bind(agentId)
    .first<{ risk_cap: string; status: string; allowed_boards: string; key_hash: string }>();
  if (!row) throw new Error("agent not found");
  return row;
}

export async function auditRows(agentId: string): Promise<
  { action: string; result: string; risk: string; mode: string; error_code: string | null }[]
> {
  const rows = await env.DB.prepare(
    "SELECT action, result, risk, mode, error_code FROM ai_audit WHERE agent_id = ? ORDER BY created_at ASC",
  )
    .bind(agentId)
    .all<{ action: string; result: string; risk: string; mode: string; error_code: string | null }>();
  return rows.results ?? [];
}

export async function queueRows(agentId: string): Promise<
  { id: string; action: string; status: string; risk: string; params: string; expires_at: number }[]
> {
  const rows = await env.DB.prepare(
    "SELECT id, action, status, risk, params, expires_at FROM ai_queue WHERE agent_id = ? ORDER BY requested_at ASC",
  )
    .bind(agentId)
    .all<{ id: string; action: string; status: string; risk: string; params: string; expires_at: number }>();
  return rows.results ?? [];
}