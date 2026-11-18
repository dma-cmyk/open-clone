// 名前欄コマンド `!NdM` の実装（全経路）の受け入れテスト。
// 表示名は投稿後にスレを読み直して確認する（クライアントに返る値ではなく、保存された名前）。
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { randomHex } from "shared";
import { network } from "./network";
import { TestClient, authedClient, createBoard, createThread, resetWorld } from "./wp1/helpers";

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface Envelope<T> {
  ok: boolean;
  data?: T;
}
interface ThreadPosts {
  posts: Array<{ num: number; name: string; body: string }>;
}

let ipSerial = 0;
/** 端末・IP を毎回変える（投稿のレート制限をテスト間・テスト内で共有しない）。 */
function freshClient(): TestClient {
  const client = new TestClient();
  client.setCookie("oc_did", randomHex(16));
  return client;
}

interface ReplyResult {
  status: number;
  body: Envelope<{ post: { num: number; name: string }; thread: { postCount: number } }>;
}

/** 匿名の新しい端末・IP でレスする。 */
async function reply(client: TestClient, threadId: number, name: string, body = "サイコロのテスト"): Promise<ReplyResult> {
  ipSerial += 1;
  const response = await client.fetch(`/v1/threads/${threadId}/posts`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${(ipSerial % 200) + 1}` },
    body: JSON.stringify({ name, body }),
  });
  return { status: response.status, body: (await response.json()) as ReplyResult["body"] };
}

async function postsOf(client: TestClient, threadId: number): Promise<ThreadPosts["posts"]> {
  const response = await client.get<ThreadPosts>(`/v1/threads/${threadId}?r=1-50`);
  if (!response.body.ok) throw new Error(`thread get failed: ${response.status}`);
  return response.body.data!.posts;
}

beforeEach(async () => {
  network.use(http.post(TURNSTILE_URL, () => HttpResponse.json({ success: true })));
  await resetWorld();
});

async function setup() {
  const owner = await authedClient({ name: "dice-owner" });
  const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
  const thread = await createThread(owner.client, board.board.slug, {
    title: "サイコロのスレ",
    body: "1げっと",
  });
  return { owner, board, thread };
}

describe("名前欄 `!NdM`", () => {
  it("レスに結果が付き、出目は範囲内（保存された名前で確認）", async () => {
    const { owner, thread } = await setup();
    const replyResult = await reply(freshClient(), thread.threadId, "!2d6");
    expect(replyResult.status, JSON.stringify(replyResult.body)).toBe(201);

    const posts = await postsOf(owner.client, thread.threadId);
    const posted = posts.find((post) => post.num === 2)!;
    const matched = /^名無しさん 【2d6:(\d)\+(\d)=(\d+)】$/.exec(posted.name);
    expect(matched, posted.name).not.toBeNull();
    const [first, second, total] = [Number(matched![1]), Number(matched![2]), Number(matched![3])];
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(6);
    expect(second).toBeGreaterThanOrEqual(1);
    expect(second).toBeLessThanOrEqual(6);
    expect(total).toBe(first + second);
  });

  it("長い名前でも結果の部分は切れない", async () => {
    const { owner, thread } = await setup();
    const longName = `${"あ".repeat(36)} !2d6`;
    const replyResult = await reply(freshClient(), thread.threadId, longName);
    expect(replyResult.status, JSON.stringify(replyResult.body)).toBe(201);

    const posts = await postsOf(owner.client, thread.threadId);
    const posted = posts.find((post) => post.num === 2)!;
    expect(posted.name.endsWith("】")).toBe(true);
    expect(posted.name).toMatch(/【2d6:\d\+\d=\d+】$/);
    expect(posted.name.startsWith("あああ")).toBe(true);
  });

  it("手書きの【2d6:6+6=12】は本物と見分けられる", async () => {
    const { owner, thread } = await setup();
    const replyResult = await reply(freshClient(), thread.threadId, "【2d6:6+6=12】");
    expect(replyResult.status, JSON.stringify(replyResult.body)).toBe(201);

    const posts = await postsOf(owner.client, thread.threadId);
    const posted = posts.find((post) => post.num === 2)!;
    expect(posted.name).toBe("〔2d6:6+6=12〕");
  });

  it("書式外（N=0・11、M=1・1001）はコマンドにならず、名前に残る", async () => {
    const { owner, thread } = await setup();
    for (const [index, name] of ["!0d6", "!11d6", "!2d1", "!2d1001"].entries()) {
      const replyResult = await reply(freshClient(), thread.threadId, name);
      expect(replyResult.status, `${name}: ${JSON.stringify(replyResult.body)}`).toBe(201);
      const posts = await postsOf(owner.client, thread.threadId);
      const posted = posts.find((post) => post.num === index + 2)!;
      expect(posted.name, name).toBe(name);
      expect(posted.name, name).not.toContain("【");
    }
  });

  it("2 個目以降の !NdM は振らない（結果は 1 つだけ）", async () => {
    const { owner, thread } = await setup();
    const replyResult = await reply(freshClient(), thread.threadId, "!2d6 !10d1000");
    expect(replyResult.status, JSON.stringify(replyResult.body)).toBe(201);

    const posts = await postsOf(owner.client, thread.threadId);
    const posted = posts.find((post) => post.num === 2)!;
    expect(posted.name.split("【")).toHaveLength(2);
    expect(posted.name).toMatch(/【2d6:\d\+\d=\d+】$/);
    expect(posted.name).not.toContain("10d1000");
  });

  it("スレ立て・つぶやきでも同じ表示になる", async () => {
    const { owner, board, thread } = await setup();
    // スレ立て（>>1 の名前欄）
    ipSerial += 1;
    const created = await freshClient().fetch(`/v1/boards/${board.board.slug}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${(ipSerial % 200) + 1}` },
      body: JSON.stringify({ title: "サイコロで立てるスレ", body: "1げっと", name: "!1d6" }),
    });
    const createdText = await created.text();
    expect(created.status, createdText).toBe(201);
    const createdBody = JSON.parse(createdText) as Envelope<{ threadId: number }>;
    const newThreadId = createdBody.data!.threadId;
    const createdPosts = await postsOf(owner.client, newThreadId);
    expect(createdPosts[0]!.name).toMatch(/^名無しさん 【1d6:[1-6]】$/);

    // つぶやき
    ipSerial += 1;
    const tsubuyaki = await freshClient().fetch(`/v1/threads/${thread.threadId}/tsubuyaki`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `203.0.113.${(ipSerial % 200) + 1}` },
      body: JSON.stringify({ body: "つぶやきのサイコロ", name: "!2d6" }),
    });
    const tsubuyakiText = await tsubuyaki.text();
    expect(tsubuyaki.status, tsubuyakiText).toBe(201);
    const tsubuyakiBody = JSON.parse(tsubuyakiText) as Envelope<{ tsubuyaki: { name: string } }>;
    expect(tsubuyakiBody.data!.tsubuyaki.name).toMatch(/^名無しさん 【2d6:\d\+\d=\d+】$/);
  });

  it("!kuji の手書き【大吉】も本物と見分けられる（既存の表示は残る）", async () => {
    const { owner, thread } = await setup();
    const fake = await reply(freshClient(), thread.threadId, "【大吉】");
    expect(fake.status, JSON.stringify(fake.body)).toBe(201);
    const real = await reply(freshClient(), thread.threadId, "!kuji");
    expect(real.status, JSON.stringify(real.body)).toBe(201);

    const posts = await postsOf(owner.client, thread.threadId);
    expect(posts.find((post) => post.num === 2)!.name).toBe("〔大吉〕");
    const genuine = posts.find((post) => post.num === 3)!.name;
    expect(genuine).toMatch(/^名無しさん 【(大吉|中吉|小吉|吉|末吉|凶|大凶)】$/);
  });
});