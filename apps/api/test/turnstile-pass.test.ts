// ロボット確認（Turnstile）の省略（報告書 81）の API テスト。
//  - 1 回目は確認（トークン必須）→ 期限内のレス・つぶやきは確認を省略
//  - `always` の板・`turnstilePassMinutes: 0` の板では省略しない
//  - スレ立ては省略しない
//  - 期限内でも連投制限は効き、制限に当たると「確認済み」が取り消される
//  - GET /v1/boards/:slug/turnstile が期限内かどうかを返す（Web はこれでウィジェットを省略する）
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { randomHex } from "shared";
import { network } from "./network";
import { api, json, makeAccount, makeSession } from "./ai-helpers";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** siteverify を常に成功にし、呼ばれた回数を数える（E2E のスタブと同じ役割）。 */
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

interface Actor {
  cookie: string;
  headers: Record<string, string>;
}

let ipCounter = 0;
/**
 * 端末 Cookie（oc_did）と、テスト専用の IP。
 * IP を分けないと `postIp` / `threadCreateIp` の窓がテスト間で共有され、
 * レート制限で落ちる（本番の 1 端末 1 IP とは別の話）。
 */
function anon(): Actor {
  ipCounter += 1;
  return {
    cookie: `oc_did=${randomHex(16)}`,
    headers: { "x-real-ip": `198.51.100.${ipCounter}` },
  };
}

/**
 * 所有者アカウントは 1 つだけ（DB の UNIQUE 制約）。テストファイル内で共有する。
 * 本番の所有者は使わない（テスト用 D1 に作る）。
 */
let owner: Actor = { cookie: "", headers: {} };
beforeAll(async () => {
  owner = { cookie: await makeSession(await makeAccount({ role: "owner" })), headers: { "x-real-ip": "198.51.100.250" } };
});

/** 板を API で作る（作成には所有者セッションが要る）。 */
async function createBoard(owner: Actor, settings: Record<string, unknown>): Promise<string> {
  const slug = `tp-${randomHex(4)}`;
  const response = await api("/v1/boards", {
    method: "POST",
    cookie: owner.cookie,
    headers: owner.headers,
    body: {
      slug,
      name: `省略テスト ${slug}`,
      category: "テスト",
      settings: { turnstile: "anonymous", cooldownSeconds: 0, ...settings },
    },
  });
  if (response.status !== 201) throw new Error(`board create failed: ${response.status} ${await response.text()}`);
  return slug;
}

async function createThread(actor: Actor, slug: string, turnstileToken?: string): Promise<number> {
  const response = await api(`/v1/boards/${slug}/threads`, {
    method: "POST",
    cookie: actor.cookie,
    headers: actor.headers,
    body: { title: `スレ ${randomHex(3)}`, body: "1げっと", turnstileToken },
  });
  if (response.status !== 201) throw new Error(`thread create failed: ${response.status} ${await response.text()}`);
  const body = await json<Envelope<{ threadId: number }>>(response);
  return body.data!.threadId;
}

async function reply(actor: Actor, threadId: number, turnstileToken?: string): Promise<Response> {
  return api(`/v1/threads/${threadId}/posts`, {
    method: "POST",
    cookie: actor.cookie,
    headers: actor.headers,
    body: { body: `レス ${randomHex(2)}`, turnstileToken },
  });
}

async function tsubuyaki(actor: Actor, threadId: number, turnstileToken?: string): Promise<Response> {
  return api(`/v1/threads/${threadId}/tsubuyaki`, {
    method: "POST",
    cookie: actor.cookie,
    headers: actor.headers,
    body: { body: "つぶやき", turnstileToken },
  });
}

async function status(actor: Actor, slug: string) {
  const response = await api(`/v1/boards/${slug}/turnstile`, {
    method: "GET",
    cookie: actor.cookie,
    headers: actor.headers,
  });
  const body = await json<Envelope<{ required: boolean; passed: boolean; passMinutes: number }>>(response);
  return { status: response.status, data: body.data! };
}

describe("ロボット確認の省略（A: サーバー側）", () => {
  beforeEach(async () => {
    network.use();
    // 前のテストの記録が残らないようにする（device ごとに別だが、念のため）。
    await env.DB.prepare("DELETE FROM turnstile_passes").run();
  });

  it("1 回確認すると、期限内のレスとつぶやきは確認を省略する", async () => {
    const verify = stubSiteverify();
    const slug = await createBoard(owner, { turnstilePassMinutes: 30 });
    const device = anon();
    const threadId = await createThread(device, slug, "token-1");
    expect(verify.calls()).toBe(1);

    // スレ立て直後はまだ「確認済み」ではない（スレ立ては省略対象外）
    expect((await status(device, slug)).data).toMatchObject({ required: true, passed: false });

    // 1 回目のレス: トークン必須 → 成功したら確認済みになる
    expect((await reply(device, threadId)).status).toBe(400);
    const first = await reply(device, threadId, "token-2");
    expect(first.status, await first.text()).toBe(201);
    expect(verify.calls()).toBe(2);
    expect((await status(device, slug)).data).toMatchObject({ required: true, passed: true });

    // 2 回目以降: トークン無しで通る（siteverify は増えない）
    const second = await reply(device, threadId);
    expect(second.status, await second.text()).toBe(201);
    const tsu = await tsubuyaki(device, threadId);
    expect(tsu.status, await tsu.text()).toBe(201);
    expect(verify.calls()).toBe(2);
  });

  it("期限が切れると再び確認を求める", async () => {
    stubSiteverify();
    const slug = await createBoard(owner, { turnstilePassMinutes: 30 });
    const device = anon();
    // スレは別端末で作る（同じ端末だとスレ作成の回数制限を消費してしまう）
    const threadId = await createThread(anon(), slug, "t");
    expect((await reply(device, threadId, "t")).status).toBe(201);
    expect((await status(device, slug)).data.passed).toBe(true);

    // 期限を過去にする（時計を進める代わりに保存値を書き換える）
    await env.DB.prepare("UPDATE turnstile_passes SET expires_at = ? WHERE board_id = (SELECT id FROM boards WHERE slug = ?)")
      .bind(Math.floor(Date.now() / 1000) - 1, slug)
      .run();
    expect((await status(device, slug)).data.passed).toBe(false);
    expect((await reply(device, threadId)).status).toBe(400);
    expect((await reply(device, threadId, "t2")).status).toBe(201);
  });

  it("turnstilePassMinutes: 0 の板では毎回確認する", async () => {
    const verify = stubSiteverify();
    const slug = await createBoard(owner, { turnstilePassMinutes: 0 });
    const device = anon();
    const threadId = await createThread(device, slug, "t");
    expect((await reply(device, threadId, "t")).status).toBe(201);
    expect((await reply(device, threadId)).status).toBe(400);
    expect((await status(device, slug)).data).toMatchObject({ passed: false, passMinutes: 0 });
    expect(verify.calls()).toBe(2);
  });

  it("turnstile: always の板では省略しない", async () => {
    stubSiteverify();
    const slug = await createBoard(owner, { turnstile: "always", turnstilePassMinutes: 30 });
    const ownerThread = await createThread(owner, slug, "t");
    // ログイン済みでも always は毎回確認（従来どおり）
    expect((await reply(owner, ownerThread, "t")).status).toBe(201);
    expect((await reply(owner, ownerThread)).status).toBe(400);
    expect((await status(owner, slug)).data).toMatchObject({ required: true, passed: false });
  });

  it("スレ立ては省略しない（確認済みでもトークン必須）", async () => {
    stubSiteverify();
    const slug = await createBoard(owner, { turnstilePassMinutes: 30 });
    const device = anon();
    // スレは別端末で作る（同じ端末だとスレ作成の回数制限を消費してしまう）
    const threadId = await createThread(anon(), slug, "t");
    expect((await reply(device, threadId, "t")).status).toBe(201);
    expect((await status(device, slug)).data.passed).toBe(true);

    const withoutToken = await api(`/v1/boards/${slug}/threads`, {
      method: "POST",
      cookie: device.cookie,
      headers: device.headers,
      body: { title: "2つ目のスレ", body: "本文" },
    });
    expect(withoutToken.status).toBe(400);
    const withToken = await api(`/v1/boards/${slug}/threads`, {
      method: "POST",
      cookie: device.cookie,
      headers: device.headers,
      body: { title: "2つ目のスレ", body: "本文", turnstileToken: "t" },
    });
    expect(withToken.status, await withToken.text()).toBe(201);
  });

  it("期限内でも連投制限は効き、制限に当たると確認済みを取り消す", async () => {
    stubSiteverify();
    const slug = await createBoard(owner, { turnstilePassMinutes: 30, cooldownSeconds: 60 });
    const device = anon();
    // スレ立て（OP）も投稿として数えられるため、スレは別端末で作る
    const threadId = await createThread(anon(), slug, "t");
    expect((await reply(device, threadId, "t")).status).toBe(201);
    expect((await status(device, slug)).data.passed).toBe(true);

    // 直後の 2 回目は連投制限（省略で素通りさせない）
    expect((await reply(device, threadId)).status).toBe(429);
    // 制限に当たったので確認済みは取り消され、次はトークンが要る
    expect((await status(device, slug)).data.passed).toBe(false);
    expect((await reply(device, threadId, "t2")).status).toBe(429);
  });

  it("別の端末・別の板へは省略を引き継がない", async () => {
    stubSiteverify();
    const slugA = await createBoard(owner, { turnstilePassMinutes: 30 });
    const slugB = await createBoard(owner, { turnstilePassMinutes: 30 });
    const device = anon();
    const other = anon();
    const threadA = await createThread(device, slugA, "t");
    expect((await reply(device, threadA, "t")).status).toBe(201);

    // 同じ板・別端末
    expect((await status(other, slugA)).data.passed).toBe(false);
    expect((await reply(other, threadA)).status).toBe(400);
    // 同じ端末・別の板
    expect((await status(device, slugB)).data.passed).toBe(false);
    const threadB = await createThread(device, slugB, "t");
    expect((await reply(device, threadB)).status).toBe(400);
  });

  it("cron の定期削除で期限切れの確認済み行だけが消える（R82-06）", async () => {
    stubSiteverify();
    const { runPrune } = await import("../src/services/board/cron");
    const { env } = await import("cloudflare:test");
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO turnstile_passes (device_hash, board_id, verified_at, expires_at, ip_hash) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("expired-device", 1, now - 100, now - 1, "ip")
      .run();
    await env.DB.prepare(
      "INSERT INTO turnstile_passes (device_hash, board_id, verified_at, expires_at, ip_hash) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("valid-device", 1, now, now + 600, "ip")
      .run();

    const result = await runPrune(env as never);
    expect(result.expiredTurnstilePasses).toBeGreaterThanOrEqual(1);
    const remaining = await env.DB.prepare("SELECT device_hash FROM turnstile_passes").all<{ device_hash: string }>();
    const devices = remaining.results.map((row) => row.device_hash);
    expect(devices).toContain("valid-device");
    expect(devices).not.toContain("expired-device");
  });
});
