// セキュリティレビュー（報告書 24）の L-1〜L-3 の回帰テスト。
// L-1: 所有者ブートストラップの誤キー試行制限（IP 単位）
// L-2: /v1/meta/usage は管理者のみ
// L-3: 未認証で所有者の有無を観測できない（status 廃止・誤キーは常に 403）

import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateTotp, generateTotpSecret } from "shared";
import { makeAccount, makeSession } from "./ai-helpers";

const ORIGIN = "http://localhost:3000";
const OWNER_KEY = "test-owner-key";

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    ip?: string;
  } = {},
): Promise<{ status: number; body: Envelope | null }> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.ip) headers["cf-connecting-ip"] = options.ip;
  const response = await SELF.fetch(`http://worker.test${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json().catch(() => null)) as Envelope | null;
  return { status: response.status, body };
}

function bootstrapBody(secret: string, code: string): Record<string, unknown> {
  return {
    bootstrapKey: OWNER_KEY,
    name: "テスト所有者",
    email: "owner-secfix@example.com",
    password: "ownerpass-1234",
    totpSecret: secret,
    totpCode: code,
  };
}

describe("L-1: 所有者ブートストラップの試行回数制限", () => {
  it("誤キーは IP 単位で 5 回まで 403、6 回目は 429。正しいキーは別 IP から 1 回で通る", async () => {
    const secret = generateTotpSecret();
    const code = await generateTotp(secret, { time: Math.floor(Date.now() / 1000) });
    const wrong = { ...bootstrapBody(secret, code), bootstrapKey: "wrong-key" };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await request("/v1/admin/owner/setup", { body: wrong, ip: "203.0.113.10" });
      expect(result.status, `attempt ${attempt}`).toBe(403);
      expect(result.body?.code).toBe("FORBIDDEN");
    }

    const limited = await request("/v1/admin/owner/setup", { body: wrong, ip: "203.0.113.10" });
    expect(limited.status).toBe(429);
    expect(limited.body?.code).toBe("RATE_LIMITED");

    // 正しいキーは別 IP から初回で成功する（試行制限が正当なセットアップを妨げない）。
    const ok = await request("/v1/admin/owner/setup", {
      body: bootstrapBody(secret, code),
      ip: "203.0.113.11",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body?.ok).toBe(true);
  });
});

describe("L-2: /v1/meta/usage は管理者のみ", () => {
  it("未認証は 401、一般ユーザーは 403、owner は 200", async () => {
    const anonymous = await request("/v1/meta/usage");
    expect(anonymous.status).toBe(401);

    const userId = await makeAccount({ role: "user" });
    const userCookie = await makeSession(userId);
    const forbidden = await request("/v1/meta/usage", { cookie: userCookie });
    expect(forbidden.status).toBe(403);

    const owner = await env.DB.prepare("SELECT id FROM accounts WHERE role = 'owner' LIMIT 1").first<{
      id: string;
    }>();
    const ownerId = owner?.id ?? (await makeAccount({ role: "owner" }));
    const ownerCookie = await makeSession(ownerId);
    const allowed = await request("/v1/meta/usage", { cookie: ownerCookie });
    expect(allowed.status).toBe(200);
    expect(allowed.body?.ok).toBe(true);
  });
});

describe("L-3: 未認証で所有者の有無を観測できない", () => {
  it("status エンドポイントは廃止され 404", async () => {
    const result = await request("/v1/admin/owner/setup/status");
    expect(result.status).toBe(404);
  });

  it("所有者作成後も誤キーは 409 ではなく 403（存在を漏らさない）", async () => {
    // 同一ファイル内の先行テストが owner を作っている場合がある（role の部分ユニーク索引）。
    const existingOwner = await env.DB.prepare("SELECT 1 AS one FROM accounts WHERE role = 'owner' LIMIT 1").first();
    if (!existingOwner) await makeAccount({ role: "owner" });

    const secret = generateTotpSecret();
    const code = await generateTotp(secret, { time: Math.floor(Date.now() / 1000) });
    const wrong = { ...bootstrapBody(secret, code), bootstrapKey: "wrong-key" };
    const result = await request("/v1/admin/owner/setup", { body: wrong, ip: "203.0.113.20" });
    expect(result.status).toBe(403);

    // 正しいキーなら 409 OWNER_SETUP_CLOSED（セットアップ画面の判定に使う）。
    const correct = await request("/v1/admin/owner/setup", {
      body: bootstrapBody(secret, code),
      ip: "203.0.113.21",
    });
    expect(correct.status).toBe(409);
    expect(correct.body?.code).toBe("OWNER_SETUP_CLOSED");
  });
});