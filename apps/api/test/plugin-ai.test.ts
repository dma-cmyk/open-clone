// WP3/WP5 — プラグイン AI 連携（POST /v1/ai/complete）の統合テスト。
// 接続先は MSW でモックし、権限・未設定・日次上限・監査ログを実 HTTP 経由で検証する。

import { SELF, env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { randomHex, sha256Hex, ulid } from "shared";
import { z } from "zod";
import { network } from "./network";

const providerBodySchema = z.object({
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});
const createdPluginSchema = z.object({ id: z.string() });
const aiResultSchema = z.object({ text: z.string(), model: z.string() });

const ORIGIN = "http://localhost:3000";
const PROVIDER_URL = "https://ai.example.test/v1/chat/completions";

const callEnvelopeSchema = z.object({
  ok: z.boolean().optional(),
  data: z.unknown().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});
type CallEnvelope = z.infer<typeof callEnvelopeSchema>;

interface CallResult {
  status: number;
  json: CallEnvelope | null;
}

async function call(
  path: string,
  options: { method?: string; cookie?: string; body?: unknown } = {},
): Promise<CallResult> {
  const headers = new Headers({ origin: ORIGIN });
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await SELF.fetch(`http://worker.test${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw: unknown = await response.json().catch(() => null);
  return { status: response.status, json: raw === null ? null : callEnvelopeSchema.parse(raw) };
}

async function seedAccount(): Promise<{ id: string; cookie: string }> {
  const id = ulid();
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, NULL, NULL, 'user', 'active', ?)",
  )
    .bind(id, `plugin-ai-${id.slice(-6)}`, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, 'vitest', ?, ?)",
  )
    .bind(await sha256Hex(token), id, now + 86_400, now, now)
    .run();
  return { id, cookie: `oc_sess=${token}` };
}

async function createPlugin(cookie: string, permissions: string[]): Promise<string> {
  const name = `ai-test-${randomHex(4)}`;
  const result = await call("/v1/plugins", {
    cookie,
    body: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "AI 連携テスト",
        scope: ["personal"],
        permissions,
        slots: [],
        hooks: [],
      },
      code: "register({});",
      visibility: "private",
    },
  });
  expect(result.status, JSON.stringify(result.json)).toBe(201);
  return createdPluginSchema.parse(result.json?.data).id;
}

async function installPersonal(cookie: string, pluginId: string): Promise<void> {
  const result = await call(`/v1/plugins/${pluginId}/install`, {
    cookie,
    body: { scope: "personal" },
  });
  expect(result.status, JSON.stringify(result.json)).toBe(201);
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM plugin_ai_log"),
    env.DB.prepare("DELETE FROM plugin_ai_usage"),
    env.DB.prepare("DELETE FROM plugin_net_log"),
    env.DB.prepare("DELETE FROM plugin_state"),
    env.DB.prepare("DELETE FROM plugin_installs"),
    env.DB.prepare("DELETE FROM plugin_versions"),
    env.DB.prepare("DELETE FROM plugins"),
    env.DB.prepare("DELETE FROM site_config WHERE key IN ('plugin.ai.baseUrl', 'plugin.ai.model')"),
  ]);
});

describe("プラグイン AI 連携（ai.complete）", () => {
  it("権限・導入を検証して接続先へ中継し、監査ログを残す", async () => {
    const providerBodies: unknown[] = [];
    network.use(
      http.post(PROVIDER_URL, async ({ request }) => {
        providerBodies.push(await request.json());
        return HttpResponse.json({
          model: "test-model-2026",
          choices: [{ message: { content: "モック応答です" } }],
        });
      }),
    );
    await setSetting("plugin.ai.baseUrl", "https://ai.example.test/v1");
    await setSetting("plugin.ai.model", "test-model");

    const account = await seedAccount();
    const pluginId = await createPlugin(account.cookie, ["ai:complete"]);
    await installPersonal(account.cookie, pluginId);

    const result = await call("/v1/ai/complete", {
      cookie: account.cookie,
      body: {
        pluginId,
        version: "1.0.0",
        scope: "personal",
        prompt: "こんにちは",
        system: "短く答えてください",
        maxTokens: 32,
        consent: true,
      },
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    const data = aiResultSchema.parse(result.json?.data);
    expect(data.text).toBe("モック応答です");
    expect(data.model).toBe("test-model-2026");

    expect(providerBodies).toHaveLength(1);
    const sent = providerBodySchema.parse(providerBodies[0]);
    expect(sent.model).toBe("test-model");
    expect(sent.max_tokens).toBe(32);
    expect(sent.messages).toEqual([
      { role: "system", content: "短く答えてください" },
      { role: "user", content: "こんにちは" },
    ]);

    const log = await env.DB.prepare(
      "SELECT plugin_id, prompt_chars, output_chars, model, status FROM plugin_ai_log ORDER BY created_at DESC LIMIT 1",
    ).first<{ plugin_id: string; prompt_chars: number; output_chars: number; model: string; status: string }>();
    expect(log).toMatchObject({
      plugin_id: pluginId,
      prompt_chars: 5,
      output_chars: "モック応答です".length,
      model: "test-model-2026",
      status: "ok",
    });
  });

  it("接続先が未設定なら 503 AI_DISABLED（ダミー応答を返さない）", async () => {
    const account = await seedAccount();
    const pluginId = await createPlugin(account.cookie, ["ai:complete"]);
    await installPersonal(account.cookie, pluginId);

    const result = await call("/v1/ai/complete", {
      cookie: account.cookie,
      body: { pluginId, scope: "personal", prompt: "hi", consent: true },
    });
    expect(result.status).toBe(503);
    expect(result.json?.code).toBe("AI_DISABLED");
    expect(result.json?.data).toBeUndefined();
  });

  it("ai:complete を宣言していないプラグインは 403", async () => {
    await setSetting("plugin.ai.baseUrl", "https://ai.example.test/v1");
    const account = await seedAccount();
    const pluginId = await createPlugin(account.cookie, []);
    await installPersonal(account.cookie, pluginId);

    const result = await call("/v1/ai/complete", {
      cookie: account.cookie,
      body: { pluginId, scope: "personal", prompt: "hi", consent: true },
    });
    expect(result.status).toBe(403);
    expect(result.json?.code).toBe("FORBIDDEN");
  });

  it("日次上限を超えたら 429", async () => {
    await setSetting("plugin.ai.baseUrl", "https://ai.example.test/v1");
    const account = await seedAccount();
    const pluginId = await createPlugin(account.cookie, ["ai:complete"]);
    await installPersonal(account.cookie, pluginId);

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO plugin_ai_usage (plugin_id, identity_hash, day_start, count) VALUES (?, ?, ?, 100)",
    )
      .bind(pluginId, `account:${account.id}`, now - (now % 86_400))
      .run();

    const result = await call("/v1/ai/complete", {
      cookie: account.cookie,
      body: { pluginId, scope: "personal", prompt: "hi", consent: true },
    });
    expect(result.status).toBe(429);
    expect(result.json?.code).toBe("RATE_LIMITED");
  });

  it("接続先の失敗は 502 で、成功扱いにしない", async () => {
    network.use(http.post(PROVIDER_URL, () => HttpResponse.json({ error: "boom" }, { status: 500 })));
    await setSetting("plugin.ai.baseUrl", "https://ai.example.test/v1");
    const account = await seedAccount();
    const pluginId = await createPlugin(account.cookie, ["ai:complete"]);
    await installPersonal(account.cookie, pluginId);

    const result = await call("/v1/ai/complete", {
      cookie: account.cookie,
      body: { pluginId, scope: "personal", prompt: "hi", consent: true },
    });
    expect(result.status).toBe(502);
    expect(result.json?.code).toBe("BAD_GATEWAY");
    expect(result.json?.data).toBeUndefined();
  });
});