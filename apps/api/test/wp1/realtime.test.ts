// WP1 受入: RealtimeHub（WebSocket Hibernation・ticket 単回使用・再接続差分）。

import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { network } from "../network";
import {
  TestClient,
  authedClient,
  createBoard,
  createThread,
  postReply,
  resetWorld,
} from "./helpers";

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface RealtimeEvent {
  type: string;
  channel?: string;
  seq?: number;
  at?: number;
  data?: { post?: { num: number; body: string } };
}

interface Collected {
  messages: unknown[];
  waitFor<T extends RealtimeEvent>(predicate: (event: T) => boolean): Promise<T>;
}

/** WS メッセージを収集し、条件一致を Promise で待つ（実時間ポーリングはしない）。 */
function collect(socket: WebSocket): Collected {
  const messages: unknown[] = [];
  const waiters = new Set<{ predicate: (event: never) => boolean; resolve: (event: never) => void }>();
  socket.addEventListener("message", (event) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      parsed = String(event.data);
    }
    messages.push(parsed);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(parsed as never)) {
        waiter.resolve(parsed as never);
        waiters.delete(waiter);
      }
    }
  });
  return {
    messages,
    waitFor<T extends RealtimeEvent>(predicate: (event: T) => boolean): Promise<T> {
      const existing = messages.find((message) => predicate(message as T));
      if (existing !== undefined) return Promise.resolve(existing as T);
      // tsconfig の lib が ES2023 のため Promise.withResolvers は未提供（WP0 の tsconfig は編集しない）。
      return new Promise<T>((resolve) => {
        waiters.add({ predicate: predicate as (event: never) => boolean, resolve: resolve as (event: never) => void });
      });
    },
  };
}

async function openSocket(client: TestClient, channel: string, ticket: string, since = 0) {
  return client.fetch(
    `/rt?ticket=${encodeURIComponent(ticket)}&channel=${encodeURIComponent(channel)}&since=${since}`,
    { headers: { upgrade: "websocket" } },
  );
}

async function issueTicket(client: TestClient, channels: string[]): Promise<string> {
  const response = await client.post<{ ticket: string }>("/v1/rt/ticket", { channels });
  if (!response.body.ok) throw new Error(`ticket failed: ${JSON.stringify(response.body)}`);
  return response.body.data.ticket;
}

async function setup() {
  const owner = await authedClient({ name: "rt-owner" });
  const board = await createBoard(owner.client, { settings: { turnstile: "off" } });
  const thread = await createThread(owner.client, board.board.slug, { title: "実況スレ", body: "開始" });
  return { owner, board, thread, channel: `thread:${thread.threadId}` };
}

beforeEach(async () => {
  network.use(http.post(TURNSTILE_URL, () => HttpResponse.json({ success: true })));
  await resetWorld();
});

describe("RealtimeHub", () => {
  it("ticket→WS 接続→publish 受信→統計が動く", async () => {
    const { owner, thread, channel } = await setup();
    const ticket = await issueTicket(owner.client, [channel]);
    const response = await openSocket(owner.client, channel, ticket);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    expect(socket).toBeTruthy();
    socket.accept();
    const stream = collect(socket);

    const hello = await stream.waitFor((event) => event.type === "hello");
    expect(hello.channel).toBe(channel);

    await postReply(new TestClient(), thread.threadId, "実況の新着レスです");
    const created = await stream.waitFor(
      (event) => event.type === "post.created" && event.data?.post?.num === 2,
    );
    expect(created.data?.post?.body).toContain("実況の新着レス");

    const stats = await owner.client.get<{ connections: number }>(
      `/v1/rt/stats?channel=${encodeURIComponent(channel)}`,
    );
    expect(stats.body.ok && stats.body.data.connections).toBe(1);

    socket.close(1000, "done");
  });

  it("ticket は同一チャンネルで 1 回しか使えない", async () => {
    const { owner, channel } = await setup();
    const ticket = await issueTicket(owner.client, [channel]);
    const first = await openSocket(owner.client, channel, ticket);
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    first.webSocket?.close(1000, "done");

    const reused = await openSocket(new TestClient(), channel, ticket);
    expect(reused.status).toBe(401);
  });

  it("再接続は since 以降の差分を返す", async () => {
    const { owner, thread, channel } = await setup();
    const ticket = await issueTicket(owner.client, [channel]);
    const first = await openSocket(owner.client, channel, ticket);
    expect(first.status).toBe(101);
    const firstSocket = first.webSocket!;
    firstSocket.accept();
    const firstStream = collect(firstSocket);
    await firstStream.waitFor((event) => event.type === "hello");

    await postReply(new TestClient(), thread.threadId, "差分の対象レス");
    const event = await firstStream.waitFor(
      (message) => message.type === "post.created" && message.data?.post?.num === 2,
    );
    expect(typeof event.seq).toBe("number");
    firstSocket.close(1000, "done");

    // since = 受信済み seq の 1 つ前 → そのイベントが backlog として返る
    const ticket2 = await issueTicket(owner.client, [channel]);
    const second = await openSocket(owner.client, channel, ticket2, (event.seq ?? 0) - 1);
    expect(second.status).toBe(101);
    const secondSocket = second.webSocket!;
    secondSocket.accept();
    const secondStream = collect(secondSocket);
    const replayed = await secondStream.waitFor(
      (message) => message.type === "post.created" && message.data?.post?.num === 2,
    );
    expect(replayed.seq).toBeGreaterThanOrEqual((event.seq ?? 0) - 1);
    await secondStream.waitFor((message) => message.type === "hello");
    secondSocket.close(1000, "done");
  });

  it("ping は Runtime の autoResponse が pong を返す（Hibernation）", async () => {
    const { owner, channel } = await setup();
    const ticket = await issueTicket(owner.client, [channel]);
    const response = await openSocket(owner.client, channel, ticket);
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const raw: string[] = [];
    const pong = new Promise<void>((resolve) => {
      socket.addEventListener("message", (event) => {
        const value = String(event.data);
        if (value === "pong") {
          raw.push(value);
          resolve();
        }
      });
    });
    socket.send("ping");
    await pong;
    expect(raw[0]).toBe("pong");
    socket.close(1000, "done");
  });

  it("別チャンネルの ticket では接続できない", async () => {
    const { owner, channel } = await setup();
    const ticket = await issueTicket(owner.client, [channel]);
    const response = await openSocket(new TestClient(), "thread:99999", ticket);
    expect(response.status).toBe(403);
  });
});