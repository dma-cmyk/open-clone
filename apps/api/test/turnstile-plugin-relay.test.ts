// R82-01: プラグイン sandbox からの中継（ホストが付ける x-oc-plugin-relay）は、
// 確認済み（期限内の省略）でも毎回 Turnstile を検証する。
// レート制限の窓を他のテストと共有しないよう、独立したファイルにしている。
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { randomHex } from "shared";
import { network } from "./network";
import { api, json, makeAccount, makeSession } from "./ai-helpers";

interface Envelope<T> {
  ok: boolean;
  data?: T;
}

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function stubSiteverify(): { calls: () => number } {
  let count = 0;
  network.use(
    http.post(SITEVERIFY, () => {
      count += 1;
      return HttpResponse.json({ success: true });
    }),
  );
  return { calls: () => count };
}

let owner: { cookie: string; headers: Record<string, string> };

beforeEach(async () => {
  network.use();
  await env.DB.prepare("DELETE FROM turnstile_passes").run();
  owner = { cookie: await makeSession(await makeAccount({ role: "owner" })), headers: { "cf-connecting-ip": "198.51.100.201" } };
});

let ipCounter = 0;
/** テストごとに別の IP を割り当てる（postIp などの IP 窓をテスト間で共有しない）。 */
function anon(): { cookie: string; headers: Record<string, string> } {
  ipCounter += 1;
  return { cookie: `oc_did=${randomHex(16)}`, headers: { "cf-connecting-ip": `198.51.101.${ipCounter}` } };
}

describe("R82-01: プラグイン中継は省略しない", () => {
  /** 板・スレ・確認済みの端末を用意する（投稿回数は 1 回）。 */
  async function setupPassed(): Promise<{ slug: string; threadId: number; poster: { cookie: string; headers: Record<string, string> } }> {
    const slug = `pr-${randomHex(4)}`;
    const board = await api("/v1/boards", {
      method: "POST",
      cookie: owner.cookie,
      headers: owner.headers,
      body: { slug, name: `中継 ${slug}`, category: "テスト", settings: { turnstile: "anonymous", cooldownSeconds: 0 } },
    });
    expect(board.status, await board.text()).toBe(201);
    const poster = anon();
    const thread = await api(`/v1/boards/${slug}/threads`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { title: "中継スレ", body: "1げっと", turnstileToken: "t" },
    });
    const threadText = await thread.text();
    expect(thread.status, threadText).toBe(201);
    const threadId = (JSON.parse(threadText) as Envelope<{ threadId: number }>).data!.threadId;
    const first = await api(`/v1/threads/${threadId}/posts`, {
      method: "POST",
      cookie: poster.cookie,
      headers: poster.headers,
      body: { body: "通常レス", turnstileToken: "t" },
    });
    expect(first.status, await first.text()).toBe(201);
    const st = await api(`/v1/boards/${slug}/turnstile`, { cookie: poster.cookie, headers: poster.headers });
    expect((await json<Envelope<{ passed: boolean }>>(st)).data!.passed).toBe(true);
    return { slug, threadId, poster };
  }

  it("確認済みでも、x-oc-plugin-relay 付きの投稿はトークン必須（siteverify も増えない）", async () => {
    const verify = stubSiteverify();
    const { threadId, poster } = await setupPassed();
    const calls = verify.calls();

    const relay = await api("/v1/posts", {
      method: "POST",
      cookie: poster.cookie,
      headers: { ...poster.headers, "x-oc-plugin-relay": "1" },
      body: { threadId, body: "プラグイン投稿" },
    });
    expect(relay.status, await relay.text()).toBe(400);
    expect(verify.calls()).toBe(calls);

    // トークンを付ければ通る（毎回検証）
    const relayOk = await api("/v1/posts", {
      method: "POST",
      cookie: poster.cookie,
      headers: { ...poster.headers, "x-oc-plugin-relay": "1" },
      body: { threadId, body: "プラグイン投稿2", turnstileToken: "t" },
    });
    expect(relayOk.status, await relayOk.text()).toBe(201);
    expect(verify.calls()).toBe(calls + 1);
  });

});
