// WP1 受入: cron（ランキング snapshot・1 週間無投稿の板自動削除・!timer・期限切れ BAN prune）。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runPrune, runRankingSnapshot } from "../../src/services/board/cron";
import { authedClient, createBoard, createThread, postReply, resetWorld } from "./helpers";

beforeEach(async () => {
  await resetWorld();
});

describe("cron", () => {
  it("ランキング snapshot が hour/day を書く", async () => {
    const { client } = await authedClient({ name: "cron-owner" });
    const board = await createBoard(client, { settings: { turnstile: "off" } });
    const thread = await createThread(client, board.board.slug, { title: "snapshot 対象", body: "開始" });
    await postReply(client, thread.threadId, "直近のレス");

    const result = await runRankingSnapshot(env);
    expect(result.written).toBe(2);
    expect(result.threads).toBeGreaterThanOrEqual(1);

    const snapshots = await env.DB.prepare(
      "SELECT period, payload FROM ranking_snapshots ORDER BY period ASC",
    ).all<{ period: string; payload: string }>();
    expect(snapshots.results.map((row) => row.period)).toEqual(["day", "hour"]);
    const payload = JSON.parse(snapshots.results[0]!.payload) as { items: Array<{ threadId: number }> };
    expect(payload.items.some((item) => item.threadId === thread.threadId)).toBe(true);
  });

  it("1 週間無投稿の板を自動削除し、!timer スレと期限切れ BAN を prune する", async () => {
    const { client } = await authedClient({ name: "cron-prune" });
    const stale = await createBoard(client, { slug: "stale-board", name: "過疎板" });
    const active = await createBoard(client, { slug: "active-board", name: "現役板" });
    const timer = await createThread(client, active.board.slug, { title: "タイマー !timer", body: "1 時間で消える" });

    const old = Math.floor(Date.now() / 1000) - 8 * 86_400;
    await env.DB.prepare("UPDATE boards SET created_at = ?, last_post_at = NULL WHERE id = ?")
      .bind(old, stale.board.id)
      .run();
    await env.DB.prepare("UPDATE threads SET created_at = ? WHERE id = ?").bind(old, timer.threadId).run();
    await env.DB.prepare(
      "INSERT INTO board_bans (id, board_id, identity_hash, kind, reason, created_at, expires_at) VALUES ('ban-1', ?, 'hash', 'device', '', ?, ?)",
    )
      .bind(active.board.id, old, old)
      .run();

    const result = await runPrune(env);
    expect(result.deletedBoards).toBe(1);
    expect(result.closedThreads).toBe(1);
    expect(result.expiredBans).toBe(1);

    const boards = await env.DB.prepare("SELECT id, status FROM boards ORDER BY id").all<{ id: number; status: string }>();
    expect(boards.results.find((row) => row.id === stale.board.id)?.status).toBe("deleted");
    expect(boards.results.find((row) => row.id === active.board.id)?.status).toBe("active");

    const thread = await env.DB.prepare("SELECT status FROM threads WHERE id = ?").bind(timer.threadId).first<{ status: string }>();
    expect(thread?.status).toBe("deleted");

    const bans = await env.DB.prepare("SELECT COUNT(*) AS n FROM board_bans").first<{ n: number }>();
    expect(bans?.n).toBe(0);
  });

  it("削除された板には投稿できない", async () => {
    const { client } = await authedClient({ name: "cron-post" });
    const board = await createBoard(client, { slug: "will-delete", settings: { turnstile: "off" } });
    const thread = await createThread(client, board.board.slug, { title: "消えるスレ", body: "開始" });
    await env.DB.prepare("UPDATE boards SET status = 'deleted' WHERE id = ?").bind(board.board.id).run();
    const blocked = await client.post(`/v1/threads/${thread.threadId}/posts`, { body: "投稿できる？" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.ok).toBe(false);
  });

  it("期限切れのセッションだけを消し、有効なセッションは残す", async () => {
    const { account } = await authedClient({ name: "cron-sess-user" });
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, 'ua', ?, ?)",
      ).bind("cron-sess-expired-1", account.id, now - 60, now - 1000, now - 1000),
      env.DB.prepare(
        "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, 'ua', ?, ?)",
      ).bind("cron-sess-expired-2", account.id, now - 1, now - 1000, now - 1000),
      env.DB.prepare(
        "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, 'ua', ?, ?)",
      ).bind("cron-sess-valid-1", account.id, now + 3600, now, now),
    ]);

    const result = await runPrune(env);
    expect(result.expiredSessions).toBe(2);

    const remaining = await env.DB.prepare(
      "SELECT token_hash FROM sessions WHERE token_hash LIKE 'cron-sess-%' ORDER BY token_hash",
    ).all<{ token_hash: string }>();
    expect(remaining.results.map((row) => row.token_hash)).toEqual(["cron-sess-valid-1"]);
  });

  it("期限切れセッションの削除は 1 回あたり 500 件まで", async () => {
    const { account } = await authedClient({ name: "cron-sess-batch" });
    const now = Math.floor(Date.now() / 1000);
    const inserts: D1PreparedStatement[] = [];
    for (let i = 0; i < 505; i += 1) {
      inserts.push(
        env.DB.prepare(
          "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, 'ua', ?, ?)",
        ).bind(`cron-batch-exp-${i}`, account.id, now - 10, now - 1000, now - 1000),
      );
    }
    inserts.push(
      env.DB.prepare(
        "INSERT INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at) VALUES (?, ?, ?, 'ua', ?, ?)",
      ).bind("cron-batch-valid", account.id, now + 3600, now, now),
    );
    // D1 batch は 100 件単位に分けて投入する
    for (let offset = 0; offset < inserts.length; offset += 100) {
      await env.DB.batch(inserts.slice(offset, offset + 100));
    }

    const first = await runPrune(env);
    expect(first.expiredSessions).toBe(500);

    const afterFirst = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE token_hash LIKE 'cron-batch-exp-%'",
    ).first<{ n: number }>();
    expect(afterFirst?.n).toBe(5);

    const second = await runPrune(env);
    expect(second.expiredSessions).toBe(5);

    const remaining = await env.DB.prepare(
      "SELECT token_hash FROM sessions WHERE token_hash LIKE 'cron-batch-%'",
    ).all<{ token_hash: string }>();
    expect(remaining.results.map((row) => row.token_hash)).toEqual(["cron-batch-valid"]);
  });
});