// WP6 テスト用ヘルパ（Cookie ジャー・TOTP 生成・API 呼び出し）。
// 個別テストファイルから import する（include は *.test.ts のみのため実行対象外）。

import { env, SELF } from "cloudflare:test";
import { generateTotp, generateTotpSecret, sha256Hex } from "shared";

export interface ApiResult<T = unknown> {
  status: number;
  body: { ok: true; data: T } | { ok: false; code: string; message: string; details?: unknown };
  data: T | null;
  errorCode: string | null;
  cookies: string[];
  sessionCookie: string | null;
  headers: Headers;
}

export interface CallOptions {
  body?: unknown;
  cookie?: string | null;
  headers?: Record<string, string>;
  ip?: string;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.ip) headers["cf-connecting-ip"] = options.ip;
  const response = await SELF.fetch(`http://worker.test${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const cookies = response.headers.getSetCookie();
  const json = (await response.json().catch(() => null)) as ApiResult<T>["body"] | null;
  if (!json) {
    return {
      status: response.status,
      body: { ok: false, code: "INVALID_RESPONSE", message: "non-json response" },
      data: null,
      errorCode: "INVALID_RESPONSE",
      cookies,
      sessionCookie: null,
      headers: response.headers,
    };
  }
  const sessionCookie =
    cookies.map((c) => c.split(";")[0]!).find((c) => c.startsWith("oc_sess=")) ?? null;
  return {
    status: response.status,
    body: json,
    data: json.ok ? json.data : null,
    errorCode: json.ok ? null : json.code,
    cookies,
    sessionCookie,
    headers: response.headers,
  };
}

/** 現在時刻（オフセット窓数）の TOTP コード */
export async function totpCode(secret: string, windowOffset = 0): Promise<string> {
  return generateTotp(secret, { time: Math.floor(Date.now() / 1000) + windowOffset * 30 });
}

export async function registerUser(
  email: string,
  password = "password-1234",
  name = "テストユーザー",
  ip?: string,
): Promise<ApiResult<{ account: { id: string; role: string }; expiresAt: number }>> {
  return call("POST", "/v1/auth/register", { body: { name, email, password }, ip });
}

export async function loginUser(
  email: string,
  password = "password-1234",
  totp?: string,
  ip?: string,
): Promise<ApiResult<{ account: { id: string; role: string }; requires?: unknown }>> {
  return call("POST", "/v1/auth/login", {
    body: { email, password, ...(totp === undefined ? {} : { totpCode: totp }) },
    ip,
  });
}

export interface OwnerSetup {
  cookie: string;
  accountId: string;
  email: string;
  password: string;
  secret: string;
  recoveryCodes: string[];
}

export async function bootstrapOwner(email = "owner@example.com"): Promise<OwnerSetup> {
  const secret = generateTotpSecret();
  const code = await totpCode(secret);
  const result = await call<{
    account: { id: string; role: string };
    recoveryCodes: string[];
  }>("POST", "/v1/admin/owner/setup", {
    body: {
      bootstrapKey: "test-owner-key",
      name: "サイト所有者",
      email,
      password: "ownerpass-1234",
      totpSecret: secret,
      totpCode: code,
    },
    ip: "10.0.0.1",
  });
  if (result.status !== 201 || !result.data) {
    throw new Error(`owner bootstrap failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  if (!result.sessionCookie) throw new Error("owner bootstrap did not set session cookie");
  return {
    cookie: result.sessionCookie,
    accountId: result.data.account.id,
    email,
    password: "ownerpass-1234",
    secret,
    recoveryCodes: result.data.recoveryCodes,
  };
}

/**
 * step-up 用のコードを選ぶ。同一タイムステップの再利用はサーバが拒否する（M-4）ため、
 * そのアカウントの last_used_step と異なるステップ（±1 窓内）を選ぶ。
 * これによりテストが「同じコードを 2 回」で落ちない（検証対象は step-up の認可そのもの）。
 */
export async function stepUp(cookie: string, secret: string): Promise<ApiResult<{ verifiedUntil: number }>> {
  const match = /oc_sess=([^;]+)/.exec(cookie);
  const lastStep = match
    ? (
        await env.DB.prepare(
          `SELECT t.last_used_step FROM sessions s JOIN account_totp t ON t.account_id = s.account_id
           WHERE s.token_hash = ?`,
        )
          .bind(await sha256Hex(match[1]!))
          .first<{ last_used_step: number | null }>()
      )?.last_used_step ?? null
    : null;
  const base = Math.floor(Date.now() / 1000 / 30);
  const step = [base, base + 1, base - 1].find((candidate) => candidate >= 0 && candidate !== lastStep) ?? base;
  return call("POST", "/v1/auth/step-up", {
    body: { code: await generateTotp(secret, { time: step * 30 }) },
    cookie,
  });
}

export interface SpecialAdminSetup {
  id: string;
  email: string;
  password: string;
  secret: string;
  recoveryCodes: string[];
  cookie: string;
  inviteId: string;
  inviteKey: string;
}

/** owner で招待を発行し、就任フローを最後まで実行する。 */
export async function createSpecialAdmin(
  owner: OwnerSetup,
  email = "special-admin@example.com",
): Promise<SpecialAdminSetup> {
  await stepUp(owner.cookie, owner.secret);
  const issued = await call<{ id: string; key: string }>("POST", "/v1/admin/invites", {
    cookie: owner.cookie,
    body: { kind: "special_admin", note: "特別管理人" },
    ip: "10.0.0.1",
  });
  if (issued.status !== 201 || !issued.data) {
    throw new Error(`invite issue failed: ${issued.status} ${JSON.stringify(issued.body)}`);
  }
  const prepared = await call<{ secret: string; otpauthUri: string }>("POST", "/v1/admin/invites/prepare-totp", {
    body: { key: issued.data.key },
    ip: "10.0.0.2",
  });
  if (prepared.status !== 200 || !prepared.data) {
    throw new Error(`prepare-totp failed: ${prepared.status} ${JSON.stringify(prepared.body)}`);
  }
  const accepted = await call<{
    account: { id: string; role: string };
    recoveryCodes: string[];
  }>("POST", "/v1/admin/invites/accept", {
    body: {
      key: issued.data.key,
      name: "特別管理人テスト",
      email,
      password: "specialpass-1234",
      totpSecret: prepared.data.secret,
      totpCode: await totpCode(prepared.data.secret),
    },
    ip: "10.0.0.2",
  });
  if (accepted.status !== 201 || !accepted.data) {
    throw new Error(`invite accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  }
  if (!accepted.sessionCookie) throw new Error("accept did not set session cookie");
  return {
    id: accepted.data.account.id,
    email,
    password: "specialpass-1234",
    secret: prepared.data.secret,
    recoveryCodes: accepted.data.recoveryCodes,
    cookie: accepted.sessionCookie,
    inviteId: issued.data.id,
    inviteKey: issued.data.key,
  };
}

export async function countRows(sql: string, ...bindings: (string | number | null)[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...bindings)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function setSiteSetting(key: string, value: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}