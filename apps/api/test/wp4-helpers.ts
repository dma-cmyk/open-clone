// WP4 テスト用ヘルパ（テストファイルではないので vitest の include 対象外）。
import { env, SELF } from "cloudflare:test";
import { randomHex, randomToken, sha256Hex, ulid } from "shared";

export const BASE = "http://worker.test";
export const ORIGIN = "http://localhost:3000";

/** 最小の PNG シグネチャ + IHDR 先頭（マジックバイト検証を通すため） */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

export interface TestAccount {
  accountId: string;
  name: string;
  cookie: string;
  device: string;
}

export async function createTestAccount(role: "user" | "owner" | "special_admin" = "user"): Promise<TestAccount> {
  const accountId = ulid();
  const name = `tester-${accountId.slice(-6)}`;
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const device = randomHex(16);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, NULL, ?, 'active', ?)",
  )
    .bind(accountId, name, `${accountId}@example.test`, role, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(tokenHash, accountId, now + 86_400, "vitest", now, now)
    .run();
  return { accountId, name, cookie: `oc_sess=${token}; oc_did=${device}`, device };
}

export function anonymousCookie(device = randomHex(16)): string {
  return `oc_did=${device}`;
}

export async function setSiteConfig(key: string, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

export async function deleteSiteConfig(key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM site_config WHERE key = ?").bind(key).run();
}

/**
 * WP4 が触るテーブルを空にする。
 * @cloudflare/vitest-plugin の isolatedStorage に依存せず、テスト間の状態持ち越しを防ぐ。
 */
export async function resetWp4State(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM upload_tickets"),
    env.DB.prepare("DELETE FROM uploader_adapters"),
    env.DB.prepare("DELETE FROM github_links"),
    env.DB.prepare("DELETE FROM github_ops_log"),
    env.DB.prepare("DELETE FROM github_webhook_events"),
    env.DB.prepare("DELETE FROM site_config"),
    env.DB.prepare("DELETE FROM sessions"),
    env.DB.prepare("DELETE FROM accounts"),
  ]);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
}

export function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return SELF.fetch(`${BASE}${path}`, { method: options.method ?? "POST", headers, body });
}

export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
  details?: unknown;
}

/** アップロードを prepare する（Turnstile はテストで無効化しておく）。 */
export async function prepareUpload(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; data: ApiEnvelope<Record<string, unknown>> }> {
  const response = await apiFetch("/v1/uploads/prepare", { cookie, body });
  return { response, data: await readJson<ApiEnvelope<Record<string, unknown>>>(response) };
}

/** proxy へ生ボディを送る。 */
export function proxyUpload(
  cookie: string,
  proxyPath: string,
  uploadToken: string,
  bytes: Uint8Array,
  contentType = "image/png",
): Promise<Response> {
  return SELF.fetch(`${BASE}${proxyPath}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      cookie,
      "x-upload-token": uploadToken,
      "content-type": contentType,
    },
    body: bytes,
  });
}