// R84-01: プラグイン中継（x-oc-plugin-relay）でも、板アク禁・連投制限・回数制限で
// 「確認済み」を取り消す（省略しないことと、取り消すことは別）。
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { randomHex } from "shared";
import { network } from "./network";
import { api, makeAccount, makeSession } from "./ai-helpers";

interface Envelope<T> {
  ok: boolean;
  data?: T;
}

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
let owner: { cookie: string; headers: Record<string, string> };
let ipCounter = 40;

beforeAll(async () => {
  owner = { cookie: await makeSession(await makeAccount({ role: "owner" })), headers: { "cf-connecting-ip": "198.51.100.230" } };
});

beforeEach(async () => {
  network.use(http.post(SITEVERIFY, () => HttpResponse.json({ success: true })));
  await env.DB.prepare("DELETE FROM turnstile_passes").run();
});

function anon() {
  ipCounter += 1;
  return { cookie: `oc_did=${randomHex(16)}`, headers: { "cf-connecting-ip": `198.51.103.${ipCounter}` } };
}

async function setup(settings: Record<string, unknown>): Promise<{ slug: string; threadId: number; poster: ReturnType<typeof anon> }> {
  const slug = `rr-${randomHex(4)}`;
  const board = await api("/v1/boards", {
    method: "POST",
    cookie: owner.cookie,
    headers: owner.headers,
    body: { slug, name: `中継取消 ${slug}`, category: "テスト", settings: { turnstile: "anonymous", cooldownSeconds: 0, ...settings } },
  });
  expect(board.status, await board.text()).toBe(201);
  const poster = anon();
  // 連投制限（cooldown）は OP も 1 投稿として数えるため、スレは別端末に立てさせる。
  const threadOwner = anon();
  const thread = await api(`/v1/boards/${slug}/threads`, {
    method: "POST",
    cookie: threadOwner.cookie,
    headers: threadOwner.headers,
    body: { title: "中継取消スレ", body: "1げっと", turnstileToken: "t" },
  });
  const text = await thread.text();
  expect(thread.status, text).toBe(201);
  const threadId = (JSON.parse(text) as Envelope<{ threadId: number }>).data!.threadId;
  // 通常レスで確認済みを作る
  const first = await api(`/v1/threads/${threadId}/posts`, {
    method: "POST",
    cookie: poster.cookie,
    headers: poster.headers,
    body: { body: "通常レス", turnstileToken: "t" },
  });
  expect(first.status, await first.text()).toBe(201);
  return { slug, threadId, poster };
}

async function passed(slug: string, poster: { cookie: string; headers: Record<string, string> }): Promise<boolean> {
  const response = await api(`/v1/boards/${slug}/turnstile`, { cookie: poster.cookie, headers: poster.headers });
  return ((await response.json()) as Envelope<{ passed: boolean }>).data!.passed;
}

describe("R84-01: 中継でも異常時は確認済みを取り消す", () => {
  it("中継要求が連投制限（429）に当たると取り消される", async () => {
    const { slug, threadId, poster } = await setup({ turnstilePassMinutes: 30, cooldownSeconds: 60 });
    expect(await passed(slug, poster)).toBe(true);
    const relay = await api("/v1/posts", {
      method: "POST",
      cookie: poster.cookie,
      headers: { ...poster.headers, "x-oc-plugin-relay": "1" },
      body: { threadId, body: "中継投稿", turnstileToken: "t" },
    });
    expect(relay.status, await relay.text()).toBe(429);
    expect(await passed(slug, poster)).toBe(false);
  });

  it("中継要求が板アク禁（403）に当たると取り消される", async () => {
    const { slug, threadId, poster } = await setup({ turnstilePassMinutes: 30 });
    const boardId = (
      await env.DB.prepare("SELECT id FROM boards WHERE slug = ?").bind(slug).first<{ id: number }>()
    )!.id;
    const device = (await env.DB.prepare("SELECT device_hash FROM posts WHERE thread_id = ? AND kind = 'post' ORDER BY id DESC LIMIT 1")
      .bind(threadId)
      .first<{ device_hash: string }>())!.device_hash;
    await env.DB.prepare(
      "INSERT INTO board_bans (id, board_id, kind, identity_hash, reason, expires_at, created_at) VALUES (?, ?, 'device', ?, 'test', NULL, ?)",
    )
      .bind(randomHex(8), boardId, device, Math.floor(Date.now() / 1000))
      .run();

    const relay = await api("/v1/posts", {
      method: "POST",
      cookie: poster.cookie,
      headers: { ...poster.headers, "x-oc-plugin-relay": "1" },
      body: { threadId, body: "中継投稿", turnstileToken: "t" },
    });
    expect(relay.status, await relay.text()).toBe(403);
    expect(await passed(slug, poster)).toBe(false);
  });
});
