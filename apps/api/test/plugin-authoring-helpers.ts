// WP-A（プラグイン作成トークン + /mcp-plugin）のテストフィクスチャ。

import { env, SELF } from "cloudflare:test";
import {
  PLUGIN_TOKEN_PREFIX,
  PLUGIN_TOKEN_PREFIX_DISPLAY_CHARS,
  PLUGIN_TOKEN_TTL_DAYS,
  normalizeManifest,
  randomToken,
  sha256Hex,
  ulid,
  type PluginManifest,
} from "shared";
import { makeAccount, makeSession } from "./ai-helpers";

export const BASE = "http://worker.test";

export interface TestAccount {
  accountId: string;
  cookie: string;
  sessionToken: string;
}

export async function makeAccountWithSession(
  input: { role?: "owner" | "special_admin" | "user"; status?: "active" | "suspended" } = {},
): Promise<TestAccount> {
  const accountId = await makeAccount({ role: input.role ?? "user", status: input.status });
  const cookie = await makeSession(accountId);
  return { accountId, cookie, sessionToken: cookie.replace("oc_sess=", "") };
}

export interface TestToken {
  token: string;
  id: string;
}

/** DB に直接トークンを 1 本作る（REST 発行のテストと分離するため）。 */
export async function makePluginToken(
  accountId: string,
  options: { name?: string; expiresAt?: number; status?: "active" | "revoked"; lastUsedAt?: number | null } = {},
): Promise<TestToken> {
  const token = `${PLUGIN_TOKEN_PREFIX}${randomToken(32)}`;
  const id = ulid();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO plugin_author_tokens
       (id, account_id, name, token_hash, token_prefix, status, expires_at, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      accountId,
      options.name ?? "test-token",
      await sha256Hex(token),
      token.slice(0, PLUGIN_TOKEN_PREFIX.length + PLUGIN_TOKEN_PREFIX_DISPLAY_CHARS),
      options.status ?? "active",
      options.expiresAt ?? now + PLUGIN_TOKEN_TTL_DAYS * 86_400,
      now,
      options.lastUsedAt ?? null,
    )
    .run();
  return { token, id };
}

/** URL 直叩き（Bearer 付き）。 */
export function mcpFetch(path: string, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function manifestFor(name: string, overrides: Record<string, unknown> = {}): PluginManifest {
  return normalizeManifest({
    name,
    version: "1.0.0",
    summary: "WP-A テスト用プラグイン",
    scope: ["personal"],
    ...overrides,
  });
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`.slice(0, 41);
}