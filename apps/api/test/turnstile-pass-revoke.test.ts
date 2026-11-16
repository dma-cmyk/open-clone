// R82-02: NG 拒否・スレ主アク禁で「確認済み（省略）」を取り消す。
// 1 テストの投稿は 3 回まで（post 3回/30秒）に抑え、IP はテストごとに変える。
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

function stubSiteverify(): void {
  network.use(http.post(SITEVERIFY, () => HttpResponse.json({ success: true })));
}

let owner: { cookie: string; headers: Record<string, string> };
let ipCounter = 100;

// 所有者アカウントは 1 つだけ（DB の UNIQUE 制約）。テストファイル内で共有する。
beforeAll(async () => {
  owner = { cookie: await makeSession(await makeAccount({ role: "owner" })), headers: { "cf-connecting-ip": "198.51.100.240" } };
});

beforeEach(async () => {
  network.use();
  await env.DB.prepare("DELETE FROM turnstile_passes").run();
});

function anon() {
  ipCounter += 1;
  return { cookie: `oc_did=${randomHex(16)}`, headers: { "cf-connecting-ip": `198.51.102.${ipCounter}` } };
}

async function setupBoard(
  settings: Record<string, unknown>,
  ngWords: string[] = [],
  options: { threadByOther?: boolean } = {},
): Promise<{ slug: string; threadId: number; poster: ReturnType<typeof anon> }> {
  const slug = `rv-${randomHex(4)}`;
  const board = await api("/v1/boards", {
    method: "POST",
    cookie: owner.cookie,
    headers: owner.headers,
    body: {
      slug,
      name: `取消 ${slug}`,
      category: "テスト",
      settings: { turnstile: "anonymous", cooldownSeconds: 0, ngWords, ...settings },
    },
  });
  expect(board.status, await board.text()).toBe(201);
  const poster = anon();
  const threadOwner = options.threadByOther ? anon() : poster;
  const thread = await api(`/v1/boards/${slug}/threads`, {
    method: "POST",
    cookie: threadOwner.cookie,
    headers: threadOwner.headers,
    body: { title: "取消スレ", body: "1げっと", turnstileToken: "t" },
  });
  const text = await thread.text();
  expect(thread.status, text).toBe(201);
  const threadId = (JSON.parse(text) as Envelope<{ threadId: number }>).data!.threadId;
  return { slug, threadId, poster };
}

async function passed(slug: string, poster: { cookie: string; headers: Record<string, string> }): Promise<boolean> {
  const response = await api(`/v1/boards/${slug}/turnstile`, { cookie: poster.cookie, headers: poster.headers });
  const body = (await response.json()) as Envelope<{ passed: boolean }>;
  return body.data!.passed;
}

describe("R82-02: 異常時に確認済みを取り消す", () => {
  it("NG で拒否されたら確認済みを取り消し、次のレスはトークン必須になる", async () => {
    stubSiteverify();
    const { slug, threadId, poster } = await setupBoard({ turnstilePassMinutes: 30 }, ["spamword"]);
    // 1 回目は通常レス（確認済みになる）
    const first = await api(`/v1/threads/${threadId}/posts`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "通常レス", turnstileToken: "t" },
    });
    expect(first.status, await first.text()).toBe(201);
    expect(await passed(slug, poster)).toBe(true);

    // 2 回目は NG で拒否 → 取消
    const ng = await api(`/v1/threads/${threadId}/posts`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "spamword を含む本文" },
    });
    expect(ng.status, await ng.text()).toBe(400);
    expect(await passed(slug, poster)).toBe(false);

    // 3 回目は確認済みが無いのでトークン必須
    const next = await api(`/v1/threads/${threadId}/posts`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "取消後の通常レス" },
    });
    expect(next.status).toBe(400);
    const body = (await next.json()) as { code?: string };
    expect(body.code).toBe("TURNSTILE_FAILED");
  });


  it("つぶやきが NG で拒否されたら確認済みを取り消す", async () => {
    stubSiteverify();
    const { slug, threadId, poster } = await setupBoard({ turnstilePassMinutes: 30 }, ["ngtsu"]);
    // レスで確認済みにする（post 1 回）
    const first = await api(`/v1/threads/${threadId}/posts`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "通常レス", turnstileToken: "t" },
    });
    expect(first.status, await first.text()).toBe(201);
    expect(await passed(slug, poster)).toBe(true);

    // つぶやき（tsubuyaki 1 回）が NG で拒否 → 取消
    const ng = await api(`/v1/threads/${threadId}/tsubuyaki`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "ngtsu を含むつぶやき" },
    });
    expect(ng.status, await ng.text()).toBe(400);
    expect(await passed(slug, poster)).toBe(false);
  });

  it("スレ主アク禁（!aku）で拒否されたら確認済みを取り消す", async () => {
    stubSiteverify();
    const { slug, threadId, poster } = await setupBoard({ turnstilePassMinutes: 30 }, [], { threadByOther: true });
    // レスで確認済みにする（post 1 回）
    const first = await api(`/v1/threads/${threadId}/posts`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "通常レス", turnstileToken: "t" },
    });
    expect(first.status, await first.text()).toBe(201);
    expect(await passed(slug, poster)).toBe(true);

    // スレの状態に「この端末をアク禁」を直接入れる（UI の !aku と同じ thread_state）
    const row = await env.DB.prepare("SELECT state FROM thread_state WHERE thread_id = ?")
      .bind(threadId)
      .first<{ state: string }>();
    const state = row?.state
      ? (JSON.parse(row.state) as Record<string, unknown>)
      : {};
    (state as { akuDevices?: string[] }).akuDevices = [];
    // device_hash は deviceHashes と分離できないため、ID アク禁で代替する（表示 ID は毎回変わるが、
    // ここでは `akuIds` に投稿時の ID を入れて再現する）。
    const post = await env.DB.prepare(
      "SELECT device_hash, ip_hash FROM posts WHERE thread_id = ? AND kind = 'post' ORDER BY id DESC LIMIT 1",
    )
      .bind(threadId)
      .first<{ device_hash: string }>();
    (state as { akuDevices?: string[] }).akuDevices = post ? [post.device_hash] : [];
    await env.DB.prepare(
      "INSERT INTO thread_state (thread_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    )
      .bind(threadId, JSON.stringify(state), Math.floor(Date.now() / 1000))
      .run();

    // 2 回目のレスはアク禁で 403 → 取消
    const banned = await api(`/v1/threads/${threadId}/posts`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "アク禁後のレス" },
    });
    expect(banned.status, await banned.text()).toBe(403);
    expect(await passed(slug, poster)).toBe(false);
  });
});
