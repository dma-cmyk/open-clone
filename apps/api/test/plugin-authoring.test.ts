// WP-A: 個人用プラグイン作成トークン（REST・認証・Origin 例外・上限・掃除）。
// MCP ツール本体のテストは mcp-plugin.test.ts。

import { env, SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_TOKEN_MAX_PER_ACCOUNT,
  PLUGIN_TOKEN_PREFIX,
  PLUGIN_TOKEN_PREFIX_DISPLAY_CHARS,
  sha256Hex,
} from "shared";
import { api, createAgent, json, makeAccount, makeSession } from "./ai-helpers";
import {
  BASE,
  makeAccountWithSession,
  makePluginToken,
  mcpFetch,
} from "./plugin-authoring-helpers";
import { grantStepUp } from "../src/services/account/step-up";
import { assertAuthorRate, assertDraftLimit, consumeAuthorUsage } from "../src/services/plugin-authoring/limits";
import { prunePluginAuthorData } from "../src/services/plugin-authoring/audit";
import { authenticatePluginToken, createPluginToken } from "../src/services/plugin-authoring/tokens";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
}

async function stepUp(accountId: string, sessionToken: string): Promise<void> {
  await grantStepUp(env.DB, await sha256Hex(sessionToken), accountId);
}

describe("プラグイン作成トークン REST（/v1/me/plugin-tokens）", () => {
  it("発行には step-up が必要（無しは 403 STEP_UP_REQUIRED）", async () => {
    const { cookie } = await makeAccountWithSession();
    const response = await api("/v1/me/plugin-tokens", { method: "POST", cookie, body: {} });
    expect(response.status).toBe(403);
    const body = await json<Envelope<unknown>>(response);
    expect(body.code).toBe("STEP_UP_REQUIRED");
  });

  it("発行すると平文を 1 回だけ返し、DB には SHA-256 ハッシュと prefix のみ保存する", async () => {
    const { accountId, cookie, sessionToken } = await makeAccountWithSession();
    await stepUp(accountId, sessionToken);

    const response = await api("/v1/me/plugin-tokens", {
      method: "POST",
      cookie,
      body: { name: "自宅の Claude Code" },
    });
    expect(response.status).toBe(201);
    const body = await json<Envelope<{ id: string; token: string; prefix: string; name: string; expiresAt: number }>>(response);
    expect(body.ok).toBe(true);
    const data = body.data!;
    expect(data.token.startsWith(PLUGIN_TOKEN_PREFIX)).toBe(true);
    expect(data.prefix).toBe(data.token.slice(0, PLUGIN_TOKEN_PREFIX.length + PLUGIN_TOKEN_PREFIX_DISPLAY_CHARS));
    expect(data.name).toBe("自宅の Claude Code");

    const row = await env.DB.prepare(
      "SELECT token_hash, token_prefix, status FROM plugin_author_tokens WHERE id = ?",
    )
      .bind(data.id)
      .first<{ token_hash: string; token_prefix: string; status: string }>();
    expect(row).not.toBeNull();
    expect(row!.token_hash).toBe(await sha256Hex(data.token));
    expect(row!.token_hash).not.toBe(data.token);
    expect(row!.token_prefix).toBe(data.prefix);
    expect(row!.status).toBe("active");

    // 平文をどこにも保存していない（全行のいずれの列にも一致しない）
    const plainRows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM plugin_author_tokens WHERE token_hash = ? OR token_prefix = ?",
    )
      .bind(data.token, data.token)
      .first<{ count: number }>();
    expect(plainRows?.count).toBe(0);
  });

  it("一覧は prefix・名前・期限のみを返す（平文・ハッシュを含まない）", async () => {
    const { accountId, cookie, sessionToken } = await makeAccountWithSession();
    await stepUp(accountId, sessionToken);
    await api("/v1/me/plugin-tokens", { method: "POST", cookie, body: { name: "A" } });
    await api("/v1/me/plugin-tokens", { method: "POST", cookie, body: { name: "B" } });

    const response = await api("/v1/me/plugin-tokens", { cookie });
    expect(response.status).toBe(200);
    const body = await json<Envelope<{ items: Record<string, unknown>[] }>>(response);
    const items = body.data!.items;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        ["createdAt", "expired", "expiresAt", "id", "name", "prefix", "status"].sort(),
      );
      expect(String(item.prefix)).toMatch(/^ocp_[A-Za-z0-9_-]{8}$/);
    }
  });

  it("同時 5 本を超える発行は 409", async () => {
    const { accountId, cookie, sessionToken } = await makeAccountWithSession();
    await stepUp(accountId, sessionToken);
    for (let index = 0; index < PLUGIN_TOKEN_MAX_PER_ACCOUNT; index++) {
      await makePluginToken(accountId, { name: `t${index}` });
    }
    const response = await api("/v1/me/plugin-tokens", { method: "POST", cookie, body: {} });
    expect(response.status).toBe(409);
    const body = await json<Envelope<unknown>>(response);
    expect(body.code).toBe("CONFLICT");
  });

  it("上限付近からの同時発行でも有効なトークンは 5 本を超えない（M-1）", async () => {
    const { accountId } = await makeAccountWithSession();
    for (let index = 0; index < PLUGIN_TOKEN_MAX_PER_ACCOUNT - 1; index++) {
      await makePluginToken(accountId, { name: `seed-${index}` });
    }

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, index) => createPluginToken(env, accountId, `burst-${index}`)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    }

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM plugin_author_tokens WHERE account_id = ? AND status = 'active' AND expires_at > ?",
    )
      .bind(accountId, Math.floor(Date.now() / 1000))
      .first<{ count: number }>();
    expect(count?.count).toBe(PLUGIN_TOKEN_MAX_PER_ACCOUNT);
  });

  it("10 本の同時発行でも有効なトークンは 5 本を超えない（M-1）", async () => {
    const { accountId } = await makeAccountWithSession();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => createPluginToken(env, accountId, `bulk-${index}`)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      PLUGIN_TOKEN_MAX_PER_ACCOUNT,
    );
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 409 });
    }

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM plugin_author_tokens WHERE account_id = ? AND status = 'active' AND expires_at > ?",
    )
      .bind(accountId, Math.floor(Date.now() / 1000))
      .first<{ count: number }>();
    expect(count?.count).toBe(PLUGIN_TOKEN_MAX_PER_ACCOUNT);
  });

  it("期限切れのトークンは同時本数に数えない", async () => {
    const { accountId, cookie, sessionToken } = await makeAccountWithSession();
    await stepUp(accountId, sessionToken);
    for (let index = 0; index < PLUGIN_TOKEN_MAX_PER_ACCOUNT; index++) {
      await makePluginToken(accountId, { expiresAt: Math.floor(Date.now() / 1000) - 10 });
    }
    const response = await api("/v1/me/plugin-tokens", { method: "POST", cookie, body: {} });
    expect(response.status).toBe(201);
  });

  it("個別失効は本人のトークンだけ。他人の ID は 404", async () => {
    const owner = await makeAccountWithSession();
    const other = await makeAccountWithSession();
    const token = await makePluginToken(owner.accountId);

    const denied = await api(`/v1/me/plugin-tokens/${token.id}`, { method: "DELETE", cookie: other.cookie });
    expect(denied.status).toBe(404);

    const ok = await api(`/v1/me/plugin-tokens/${token.id}`, { method: "DELETE", cookie: owner.cookie });
    expect(ok.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM plugin_author_tokens WHERE id = ?")
      .bind(token.id)
      .first<{ status: string }>();
    expect(row!.status).toBe("revoked");

    const again = await api(`/v1/me/plugin-tokens/${token.id}`, { method: "DELETE", cookie: owner.cookie });
    expect(again.status).toBe(404);
  });

  it("全失効は step-up 必須で、有効なトークンをまとめて失効する", async () => {
    const { accountId, cookie, sessionToken } = await makeAccountWithSession();
    const first = await makePluginToken(accountId);
    await makePluginToken(accountId);

    const denied = await api("/v1/me/plugin-tokens/revoke-all", { method: "POST", cookie, body: {} });
    expect(denied.status).toBe(403);

    await stepUp(accountId, sessionToken);
    const response = await api("/v1/me/plugin-tokens/revoke-all", { method: "POST", cookie, body: {} });
    expect(response.status).toBe(200);
    const body = await json<Envelope<{ ok: boolean; revoked: number }>>(response);
    expect(body.data).toEqual({ ok: true, revoked: 2 });

    await expect(authenticatePluginToken(env, first.token)).rejects.toMatchObject({ status: 401 });
  });

  it("発行・失効は audit_log に残る", async () => {
    const { accountId, cookie, sessionToken } = await makeAccountWithSession();
    await stepUp(accountId, sessionToken);
    const created = await api("/v1/me/plugin-tokens", { method: "POST", cookie, body: {} });
    const data = (await json<Envelope<{ id: string }>>(created)).data!;
    await api(`/v1/me/plugin-tokens/${data.id}`, { method: "DELETE", cookie });

    const rows = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE actor_id = ? AND action LIKE 'plugin_token.%' ORDER BY created_at",
    )
      .bind(accountId)
      .all<{ action: string }>();
    expect((rows.results ?? []).map((row) => row.action)).toEqual([
      "plugin_token.issue",
      "plugin_token.revoke",
    ]);
  });
});

describe("トークン認証（authenticatePluginToken / レーン分離）", () => {
  it("last_used_at を更新する", async () => {
    const { accountId } = await makeAccountWithSession();
    const token = await makePluginToken(accountId);
    await authenticatePluginToken(env, token.token);
    const row = await env.DB.prepare("SELECT last_used_at FROM plugin_author_tokens WHERE id = ?")
      .bind(token.id)
      .first<{ last_used_at: number | null }>();
    expect(row!.last_used_at).not.toBeNull();
  });

  it("失効・期限切れは 401、アカウント停止は 403", async () => {
    const active = await makeAccountWithSession();
    const revoked = await makePluginToken(active.accountId, { status: "revoked" });
    await expect(authenticatePluginToken(env, revoked.token)).rejects.toMatchObject({ status: 401 });

    const expired = await makePluginToken(active.accountId, {
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });
    await expect(authenticatePluginToken(env, expired.token)).rejects.toMatchObject({ status: 401 });

    const suspended = await makeAccountWithSession({ status: "suspended" });
    const suspendedToken = await makePluginToken(suspended.accountId);
    await expect(authenticatePluginToken(env, suspendedToken.token)).rejects.toMatchObject({ status: 403 });
  });

  it("ocai_ は /mcp-plugin で 401、ocp_ は /mcp で 401（相互に受け付けない）", async () => {
    const adminId = await makeAccount({ role: "special_admin" });
    const cookie = await makeSession(adminId);
    const agent = await createAgent(cookie, {
      name: `wp-a-agent-${Math.random().toString(36).slice(2, 7)}`,
      ownerType: "site",
      allowedBoards: "*",
      riskCap: "high",
    });

    const aiKeyOnPluginLane = await mcpFetch("/mcp-plugin", agent.apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(aiKeyOnPluginLane.status).toBe(401);

    const owner = await makeAccountWithSession();
    const pluginToken = await makePluginToken(owner.accountId);
    const pluginTokenOnAiLane = await mcpFetch("/mcp", pluginToken.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(pluginTokenOnAiLane.status).toBe(401);
  });
});

describe("上限（報告書28 §5.2）", () => {
  it("日次カウンタは上限で 429、翌日窓は別カウント", async () => {
    const { accountId } = await makeAccountWithSession();
    const now = Math.floor(Date.now() / 1000);
    const dayStart = now - (now % 86_400);
    await env.DB.prepare(
      "INSERT INTO plugin_author_usage (account_id, kind, day_start, count) VALUES (?, 'create', ?, 10)",
    )
      .bind(accountId, dayStart)
      .run();
    await expect(consumeAuthorUsage(env, accountId, "create")).rejects.toMatchObject({ status: 429 });

    // 別種別は独立
    await expect(consumeAuthorUsage(env, accountId, "check")).resolves.toBeUndefined();
  });

  it("分窓は 30 回/分（31 回目で 429）", async () => {
    const { accountId } = await makeAccountWithSession();
    const token = await makePluginToken(accountId);
    for (let index = 0; index < 30; index++) {
      await assertAuthorRate(env, token.id);
    }
    await expect(assertAuthorRate(env, token.id)).rejects.toMatchObject({ status: 429 });
  });

  it("下書き 50 件で作成を拒否する", async () => {
    const { accountId } = await makeAccountWithSession();
    const now = Math.floor(Date.now() / 1000);
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 50; index++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO plugins (id, owner_account_id, name, summary, manifest_json, scopes, status, visibility,
             latest_version, source, install_count, report_count, flagged, kill_seq, created_at, updated_at)
           VALUES (?, ?, ?, '', '{}', ',personal,', 'draft', 'private', '1.0.0', 'local', 0, 0, 0, 0, ?, ?)`,
        ).bind(`draft-${index}-${accountId}`, accountId, `draft-${index}`, now, now),
      );
    }
    await env.DB.batch(statements);
    await expect(assertDraftLimit(env, accountId)).rejects.toMatchObject({ status: 409 });
  });

  it("掃除は 8 日超の usage と 90 日超の監査を削除する（新規 cron なし）", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO plugin_author_usage (account_id, kind, day_start, count) VALUES ('a', 'create', ?, 1)",
    )
      .bind(now - 9 * 86_400)
      .run();
    await env.DB.prepare(
      "INSERT INTO plugin_author_usage (account_id, kind, day_start, count) VALUES ('a', 'create', ?, 1)",
    )
      .bind(now - 1 * 86_400)
      .run();
    await env.DB.prepare(
      `INSERT INTO plugin_author_audit (id, token_id, account_id, tool, result, created_at)
       VALUES ('old', 't', 'a', 'authoring.list', 'ok', ?)`,
    )
      .bind(now - 91 * 86_400)
      .run();
    await env.DB.prepare(
      `INSERT INTO plugin_author_audit (id, token_id, account_id, tool, result, created_at)
       VALUES ('new', 't', 'a', 'authoring.list', 'ok', ?)`,
    )
      .bind(now - 1 * 86_400)
      .run();

    const pruned = await prunePluginAuthorData(env, now);
    expect(pruned.usage).toBe(1);
    expect(pruned.audit).toBe(1);

    const usage = await env.DB.prepare("SELECT COUNT(*) AS count FROM plugin_author_usage WHERE account_id = 'a'")
      .first<{ count: number }>();
    const audit = await env.DB.prepare("SELECT COUNT(*) AS count FROM plugin_author_audit WHERE token_id = 't'")
      .first<{ count: number }>();
    expect(usage!.count).toBe(1);
    expect(audit!.count).toBe(1);
  });
});

describe("決定1: Origin 例外（本番相当 ENVIRONMENT=production）", () => {
  const PRODUCTION_ORIGIN = "https://open-clone-nine.vercel.app";

  async function withProduction<T>(run: () => Promise<T>): Promise<T> {
    const mutable = env as unknown as { ENVIRONMENT: string; ALLOWED_ORIGINS: string };
    const previous = { ENVIRONMENT: mutable.ENVIRONMENT, ALLOWED_ORIGINS: mutable.ALLOWED_ORIGINS };
    mutable.ENVIRONMENT = "production";
    mutable.ALLOWED_ORIGINS = PRODUCTION_ORIGIN;
    try {
      return await run();
    } finally {
      mutable.ENVIRONMENT = previous.ENVIRONMENT;
      mutable.ALLOWED_ORIGINS = previous.ALLOWED_ORIGINS;
    }
  }

  it("Origin なし + Bearer は /mcp-plugin で Origin ガードを通る（401 はトークン不正）", async () => {
    await withProduction(async () => {
      const response = await mcpFetch("/mcp-plugin", "ocp_invalid", { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(response.status).toBe(401);
      const body = await json<Envelope<unknown>>(response);
      expect(body.code).toBe("UNAUTHORIZED");
    });
  });

  it("Origin なし + 有効な ocp_ トークンで /mcp-plugin が 200（tools/list）", async () => {
    const { accountId } = await makeAccountWithSession();
    const pluginToken = await makePluginToken(accountId);
    await withProduction(async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp-plugin`), {
        requestInit: { headers: { Authorization: `Bearer ${pluginToken.token}` } },
        fetch: (input, init) => SELF.fetch(input instanceof Request ? input : String(input), init),
      });
      const client = new Client(
        { name: "origin-plugin-fix-test", version: "1.0.0" },
        { capabilities: {}, versionNegotiation: { mode: "auto" } },
      );
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(9);
      } finally {
        await client.close();
      }
    });
  });

  it("既存 /mcp も Origin なし + Bearer で通る（本番で CLI が使える）", async () => {
    const adminId = await makeAccount({ role: "special_admin" });
    const cookie = await makeSession(adminId);
    const agent = await createAgent(cookie, {
      name: `origin-agent-${Math.random().toString(36).slice(2, 7)}`,
      ownerType: "site",
      allowedBoards: "*",
      riskCap: "high",
    });

    await withProduction(async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${agent.apiKey}` } },
        fetch: (input, init) => SELF.fetch(input instanceof Request ? input : String(input), init),
      });
      const client = new Client(
        { name: "origin-fix-test", version: "1.0.0" },
        { capabilities: {}, versionNegotiation: { mode: "auto" } },
      );
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === "board.list")).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  it("Origin なしでも Bearer が無ければ 403", async () => {
    await withProduction(async () => {
      const response = await mcpFetch("/mcp-plugin", null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(response.status).toBe(403);
      expect((await json<Envelope<unknown>>(response)).code).toBe("BAD_ORIGIN");
    });
  });

  it("セッション Cookie を併用した Bearer は 403（Cookie 経路は緩和しない）", async () => {
    const { cookie } = await makeAccountWithSession();
    await withProduction(async () => {
      const response = await SELF.fetch(`${BASE}/mcp-plugin`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer ocp_invalid", cookie },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(403);
      expect((await json<Envelope<unknown>>(response)).code).toBe("BAD_ORIGIN");
    });
  });

  it("パスは完全一致のみ（/mcp-plugin/ や /v1/* は 403）", async () => {
    await withProduction(async () => {
      for (const path of ["/mcp-plugin/", "/mcp-plugin/other", "/mcp-other", "/v1/boards"]) {
        const response = await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer ocp_invalid" },
          body: JSON.stringify({}),
        });
        expect(response.status, path).toBe(403);
        expect((await json<Envelope<unknown>>(response)).code, path).toBe("BAD_ORIGIN");
      }
    });
  });

  it("Origin 付き不許可は Bearer があっても 403（従来どおり）", async () => {
    await withProduction(async () => {
      const response = await SELF.fetch(`${BASE}/mcp-plugin`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer ocp_invalid",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(403);
      expect((await json<Envelope<unknown>>(response)).code).toBe("BAD_ORIGIN");
    });
  });
});