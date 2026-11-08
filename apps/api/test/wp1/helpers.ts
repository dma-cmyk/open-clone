// API 統合テスト用ヘルパ（アカウント・セッション・Cookie ジャー・API 呼び出し）。

import { SELF, env } from "cloudflare:test";
import { randomHex, sha256Hex, ulid } from "shared";

export const BASE_URL = "http://worker.test";
export const ALLOWED_ORIGIN = "http://localhost:3000";

export interface TestAccount {
  id: string;
  name: string;
  token: string;
}

/** アカウントと有効なセッションを作る（Cookie 認証用トークンを返す）。 */
export async function createAccount(options: { role?: "owner" | "special_admin" | "user"; name?: string } = {}): Promise<TestAccount> {
  const id = ulid();
  const name = options.name ?? `user-${randomHex(4)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, NULL, ?, 'active', ?)",
  )
    .bind(id, name, `${id}@example.com`, options.role ?? "user", now)
    .run();
  const token = randomHex(32);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), id, now + 86_400, "vitest", now, now)
    .run();
  return { id, name, token };
}

/** Cookie ジャー付きの HTTP クライアント（oc_did を持ち回る）。 */
export class TestClient {
  private readonly cookies = new Map<string, string>();

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("origin", ALLOWED_ORIGIN);
    if (!headers.has("content-type") && init.body !== undefined) headers.set("content-type", "application/json");
    const cookieHeader = Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
    if (cookieHeader.length > 0) headers.set("cookie", cookieHeader);

    const response = await SELF.fetch(`${BASE_URL}${path}`, { ...init, headers });
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie") ?? "").split(/,(?=\s*\w+=)/);
    for (const raw of setCookies) {
      const pair = raw.split(";")[0]?.trim();
      if (!pair) continue;
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }

  async get<T = unknown>(path: string): Promise<{ status: number; body: ApiEnvelope<T> }> {
    return this.parse<T>(await this.fetch(path));
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<{ status: number; body: ApiEnvelope<T> }> {
    return this.parse<T>(await this.fetch(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }));
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<{ status: number; body: ApiEnvelope<T> }> {
    return this.parse<T>(await this.fetch(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) }));
  }

  async delete<T = unknown>(path: string): Promise<{ status: number; body: ApiEnvelope<T> }> {
    return this.parse<T>(await this.fetch(path, { method: "DELETE" }));
  }

  private async parse<T>(response: Response): Promise<{ status: number; body: ApiEnvelope<T> }> {
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as ApiEnvelope<T> };
    } catch {
      return {
        status: response.status,
        body: { ok: false, code: "NON_JSON", message: `HTTP ${response.status}: ${text.slice(0, 500)}` },
      };
    }
  }
}

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; details?: unknown };

export interface BoardData {
  board: { id: number; slug: string; name: string; category: string; settings: Record<string, unknown> };
}

export interface ThreadData {
  threadId: number;
  thread: { id: number; title: string; postCount: number };
  post: { id: number; num: number };
}

export interface PostData {
  post: {
    id: number;
    num: number;
    body: string;
    idHash: string;
    backlinks: number[];
    isOp: boolean;
    attachments: Array<{ id?: string; url: string; contentType?: string; size?: number; name?: string }>;
  };
  thread: { postCount: number };
}

/** 認証済みクライアントを作る（セッション Cookie を設定）。 */
export async function authedClient(options: { role?: "owner" | "special_admin" | "user"; name?: string } = {}) {
  const account = await createAccount(options);
  const client = new TestClient();
  client.setCookie("oc_sess", account.token);
  return { account, client };
}

/** 板を作る。 */
export async function createBoard(client: TestClient, body: Record<string, unknown> = {}) {
  const slug = body["slug"] ?? `b-${randomHex(4)}`;
  const response = await client.post<BoardData>("/v1/boards", {
    slug,
    name: body["name"] ?? `板 ${slug}`,
    category: body["category"] ?? "雑談",
    description: body["description"] ?? "",
    settings: body["settings"] ?? {},
    ...body,
  });
  if (response.status !== 201) {
    throw new Error(`board create failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.ok ? response.body.data : (undefined as never);
}

/** スレを作る。 */
export async function createThread(client: TestClient, slug: string, body: Record<string, unknown> = {}) {
  const response = await client.post<ThreadData>(`/v1/boards/${slug}/threads`, {
    title: body["title"] ?? "テストスレ",
    body: body["body"] ?? ">>1 の本文です",
    ...body,
  });
  if (response.status !== 201) {
    throw new Error(`thread create failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.ok ? response.body.data : (undefined as never);
}

/** レスを投稿する。 */
export async function postReply(client: TestClient, threadId: number, body: string, extra: Record<string, unknown> = {}) {
  const response = await client.post<PostData>(`/v1/threads/${threadId}/posts`, { body, ...extra });
  if (response.status !== 201) {
    throw new Error(`post failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.ok ? response.body.data : (undefined as never);
}

/** アプリ表への論理行書込（INSERT/UPDATE/DELETE）を計測する。
 *  workerd の D1 meta.rows_written は索引エントリや FTS5 shadow 表も数えるため、
 *  無料枠ガード（DESIGN §12 の「posts+fts+counters+backlinks」= 論理行）は
 *  アプリ表に張った一時トリガで測る。fn の実行後にプローブを必ず除去する。 */
export async function measureAppWrites<T>(fn: () => Promise<T>): Promise<{ result: T; writes: number }> {
  const tables = [
    "posts",
    "threads",
    "boards",
    "devices",
    "counters",
    "backlinks",
    "thread_state",
    "thread_subs",
    "tags",
    "thread_tags",
    "polls",
    "poll_votes",
    "post_reactions",
  ];
  const setup: D1PreparedStatement[] = [
    env.DB.prepare("DROP TABLE IF EXISTS _wp_write_probe"),
    env.DB.prepare("CREATE TABLE _wp_write_probe (n INTEGER NOT NULL)"),
    env.DB.prepare("INSERT INTO _wp_write_probe (n) VALUES (0)"),
  ];
  for (const table of tables) {
    for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
      setup.push(
        env.DB.prepare(
          `CREATE TRIGGER _wp_probe_${table}_${op} AFTER ${op} ON ${table} BEGIN UPDATE _wp_write_probe SET n = n + 1; END`,
        ),
      );
    }
  }
  await env.DB.batch(setup);
  try {
    const result = await fn();
    const row = await env.DB.prepare("SELECT n FROM _wp_write_probe").first<{ n: number }>();
    return { result, writes: row?.n ?? 0 };
  } finally {
    const cleanup: D1PreparedStatement[] = [];
    for (const table of tables) {
      for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
        cleanup.push(env.DB.prepare(`DROP TRIGGER IF EXISTS _wp_probe_${table}_${op}`));
      }
    }
    cleanup.push(env.DB.prepare("DROP TABLE IF EXISTS _wp_write_probe"));
    await env.DB.batch(cleanup).catch(() => undefined);
  }
}

/** 期限切れデータの掃除（テスト間の独立性のため）。 */
export async function resetWorld(): Promise<void> {
  for (const table of [
    "backlinks",
    "post_reactions",
    "poll_votes",
    "polls",
    "reports",
    "thread_tags",
    "tags",
    "thread_subs",
    "thread_state",
    "posts",
    "threads",
    "board_staff",
    "board_bans",
    "boards",
    "devices",
    "counters",
    "ranking_snapshots",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}