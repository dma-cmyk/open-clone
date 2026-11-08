// RealtimeHub DO（SQLite-backed + WebSocket Hibernation）。
// 1 DO = 1 チャンネル（`board:<id>` / `thread:<id>`）。直近イベントをリングバッファに保持し、
// 再接続クライアントへ `since` 以降の差分を返す（正本は D1。DESIGN §11.1）。

import { DurableObject } from "cloudflare:workers";
import { RT_RING_BUFFER_SIZE } from "shared";
import type { Env } from "../lib/env";

interface PublishBody {
  channel: string;
  event: { type: string; channel?: string; at?: number; data?: unknown };
}

interface EventRow {
  seq: number;
  payload: string;
}

export class RealtimeHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         channel TEXT NOT NULL,
         payload TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS tickets (key TEXT PRIMARY KEY, used_at INTEGER NOT NULL)",
    );
    // Hibernation 中の ping をランタイムで処理する（アプリ層 heartbeat は送らない）。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/publish":
        return this.handlePublish(request);
      case "/ws":
        return this.handleWebSocket(url);
      case "/stats":
        return this.handleStats(url);
      case "/recent":
        return this.handleRecent(url);
      case "/ticket":
        return this.handleTicket(url);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  /** イベントをリングバッファへ書き、購読中の全 WS へ配信する。 */
  private async handlePublish(request: Request): Promise<Response> {
    const body = (await request.json()) as PublishBody;
    const channel = body.channel;
    if (!channel) return new Response("channel required", { status: 400 });

    const next = this.ctx.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events").one() as {
      seq: number;
    };
    const seq = Number(next.seq);
    const at = body.event.at ?? Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ ...body.event, channel, seq, at });

    this.ctx.storage.sql.exec(
      "INSERT INTO events (seq, channel, payload, created_at) VALUES (?, ?, ?, ?)",
      seq,
      channel,
      payload,
      at,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM events WHERE seq <= ?",
      Math.max(0, seq - RT_RING_BUFFER_SIZE),
    );

    let delivered = 0;
    for (const socket of this.ctx.getWebSockets(channel)) {
      try {
        socket.send(payload);
        delivered += 1;
      } catch (error) {
        console.error("realtime send failed", String(error));
      }
    }
    return Response.json({ ok: true, seq, delivered });
  }

  /** チケットの単回使用を検証する（チャンネルごとに 1 回）。 */
  private handleTicket(url: URL): Response {
    const key = url.searchParams.get("key");
    if (!key) return new Response("key required", { status: 400 });
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO tickets (key, used_at) VALUES (?, ?)",
        key,
        Math.floor(Date.now() / 1000),
      );
    } catch {
      return Response.json({ ok: false, error: "ticket already used" }, { status: 409 });
    }
    // 古いチケット記録を遅延削除（alarm を使わない。DESIGN §11.3）
    this.ctx.storage.sql.exec(
      "DELETE FROM tickets WHERE used_at < ?",
      Math.floor(Date.now() / 1000) - 3600,
    );
    return Response.json({ ok: true });
  }

  /** WebSocket 接続を確立し、`since` 以降のイベントを即時返す。 */
  private handleWebSocket(url: URL): Response {
    const channel = url.searchParams.get("channel");
    if (!channel) return new Response("channel required", { status: 400 });
    const since = Number(url.searchParams.get("since") ?? 0) || 0;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [channel]);

    const rows = this.ctx.storage.sql
      .exec("SELECT seq, payload FROM events WHERE channel = ? AND seq > ? ORDER BY seq ASC", channel, since)
      .toArray() as unknown as EventRow[];
    for (const row of rows) {
      try {
        server.send(row.payload);
      } catch (error) {
        console.error("realtime backlog send failed", String(error));
      }
    }

    const head = this.ctx.storage.sql
      .exec("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")
      .one() as { seq: number };
    server.send(JSON.stringify({ type: "hello", channel, seq: Number(head.seq), at: Math.floor(Date.now() / 1000), data: { since } }));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** 現在の接続数（ランキングの「同時接続最大」指標に使う）。 */
  private handleStats(url: URL): Response {
    const channel = url.searchParams.get("channel");
    const sockets = channel ? this.ctx.getWebSockets(channel) : this.ctx.getWebSockets();
    const channels: Record<string, number> = {};
    for (const socket of sockets) {
      const tag = this.ctx.getTags(socket)[0] ?? channel ?? "unknown";
      channels[tag] = (channels[tag] ?? 0) + 1;
    }
    return Response.json({ connections: sockets.length, channels });
  }

  /** 直近イベント（デバッグ・再接続フォールバック用）。 */
  private handleRecent(url: URL): Response {
    const channel = url.searchParams.get("channel");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), RT_RING_BUFFER_SIZE);
    const rows = channel
      ? this.ctx.storage.sql
          .exec("SELECT payload FROM events WHERE channel = ? ORDER BY seq DESC LIMIT ?", channel, limit)
          .toArray()
      : this.ctx.storage.sql.exec("SELECT payload FROM events ORDER BY seq DESC LIMIT ?", limit).toArray();
    return Response.json({
      items: (rows as unknown as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as unknown).reverse(),
    });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    // ping は setWebSocketAutoResponse が処理する。それ以外はそのまま返す（疎通確認用）。
    if (typeof message === "string" && message !== "ping") {
      try {
        socket.send(message);
      } catch {
        // 切断済み
      }
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // すでに閉じている
    }
  }

  override webSocketError(socket: WebSocket, error: unknown): void {
    console.error("realtime websocket error", String(error));
    try {
      socket.close(1011, "error");
    } catch {
      // noop
    }
  }
}