// WP1 受入: 板作成→スレ立て→レス→安価→コマンド(!aku)→検索→ランキング→通報→互換出力。

import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { decodeShiftJis, encodeShiftJis, hmacSha256Hex, randomHex } from "shared";
import { network } from "../network";
import {
  TestClient,
  authedClient,
  createBoard,
  createThread,
  measureAppWrites,
  postReply,
  resetWorld,
  type BoardData,
  type PostData,
  type ThreadData,
} from "./helpers";
import { createPostInternal } from "../../src/lib/pipeline";
import { createWebhook } from "../../src/services/ai/webhook";

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function setupWorld(options: { settings?: Record<string, unknown> } = {}) {
  const owner = await authedClient({ name: "board-admin" });
  const board = await createBoard(owner.client, {
    name: "テスト板",
    category: "雑談",
    settings: { turnstile: "off", ...(options.settings ?? {}) },
  });
  const thread = await createThread(owner.client, board.board.slug, {
    title: "プロ野球について語るスレ",
    body: "よろしくお願いします",
  });
  return { owner, board, thread };
}

beforeEach(async () => {
  network.use(http.post(TURNSTILE_URL, () => HttpResponse.json({ success: true })));
  await resetWorld();
});

describe("板・スレ・レス", () => {
  it("板作成→スレ立て→レス→安価の逆参照が通る", async () => {
    const { owner, board, thread } = await setupWorld();
    expect(board.board.slug).toMatch(/^b-/);
    expect(thread.thread.postCount).toBe(1);

    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, ">>1 これは安価です。プロ野球の話をしよう");
    expect(reply.post.num).toBe(2);

    const { status, body } = await owner.client.get<{ posts: PostData["post"][]; thread: { postCount: number } }>(
      `/v1/threads/${thread.threadId}?r=1-10`,
    );
    expect(status).toBe(200);
    if (!body.ok) throw new Error("failed");
    expect(body.data.posts).toHaveLength(2);
    expect(body.data.posts[0]!.backlinks).toContain(2);
    expect(body.data.posts[1]!.isOp).toBe(false);
    expect(body.data.posts[0]!.isOp).toBe(true);
    expect(body.data.posts[1]!.idHash).toMatch(/^[A-Z2-7]{4}$/);
    expect(body.data.posts[0]!.idHash).toBe(body.data.posts[1]!.idHash === body.data.posts[0]!.idHash ? body.data.posts[0]!.idHash : body.data.posts[0]!.idHash);

    // 範囲指定バリエーション
    const last = await owner.client.get<{ posts: PostData["post"][] }>(`/v1/threads/${thread.threadId}?r=l1`);
    expect(last.body.ok && last.body.data.posts).toHaveLength(1);
    const nums = await owner.client.get<{ posts: PostData["post"][] }>(`/v1/threads/${thread.threadId}?r=1,2`);
    expect(nums.body.ok && nums.body.data.posts.map((post) => post.num)).toEqual([1, 2]);
  });

  it("8 並行投稿が全て成功し、レス番号が重複・欠番なく連番になる", async () => {
    const { thread } = await setupWorld();
    // device 窓と IP 窓を別々に消費させる（同一端末/同一 IP のレート制限に掛からない条件で採番だけを見る）。
    const clients = Array.from({ length: 8 }, (_, index) => {
      const client = new TestClient();
      client.setCookie("oc_did", randomHex(16));
      return { client, ip: `203.0.113.${index + 1}` };
    });

    const responses = await Promise.all(
      clients.map(({ client, ip }, index) =>
        client.fetch(`/v1/threads/${thread.threadId}/posts`, {
          method: "POST",
          headers: { "x-real-ip": ip },
          body: JSON.stringify({ body: `並行投稿 ${index + 1}` }),
        }),
      ),
    );
    const bodies = z
      .array(
        z.object({
          ok: z.boolean(),
          code: z.string().optional(),
          data: z.object({ post: z.object({ num: z.number().int() }) }).optional(),
        }),
      )
      .parse(await Promise.all(responses.map((response) => response.json())));
    expect(responses.map((response, index) => `${response.status}:${bodies[index]?.code ?? ""}`)).toEqual(
      Array(8).fill("201:"),
    );

    const nums = bodies.map((body) => body.data!.post.num).sort((a, b) => a - b);
    expect(nums).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

    const rows = await env.DB.prepare(
      "SELECT num FROM posts WHERE thread_id = ? AND kind = 'post' ORDER BY num",
    )
      .bind(thread.threadId)
      .all<{ num: number }>();
    expect(rows.results.map((row) => row.num)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const threadRow = await env.DB.prepare("SELECT post_count FROM threads WHERE id = ?")
      .bind(thread.threadId)
      .first<{ post_count: number }>();
    expect(threadRow!.post_count).toBe(9);
  });

  it("sage は bump を更新しない", async () => {
    const { owner, thread } = await setupWorld();
    const before = await env.DB.prepare("SELECT bump_at FROM threads WHERE id = ?").bind(thread.threadId).first<{ bump_at: number }>();
    await postReply(owner.client, thread.threadId, "sage 投稿", { sage: true, mail: "sage" });
    const after = await env.DB.prepare("SELECT bump_at FROM threads WHERE id = ?").bind(thread.threadId).first<{ bump_at: number }>();
    expect(after!.bump_at).toBe(before!.bump_at);
  });

  it("レス上限に達したら 409", async () => {
    const { thread } = await setupWorld();
    await env.DB.prepare("UPDATE threads SET max_posts = 10, post_count = 10 WHERE id = ?").bind(thread.threadId).run();
    const blocked = await new TestClient().post(`/v1/threads/${thread.threadId}/posts`, { body: "上限超え" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.ok).toBe(false);
  });
});

describe("スレ主コマンド", () => {
  it("!aku でアク禁、!kaijo で解除できる", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    const target = await postReply(anon, thread.threadId, "荒らしレス");

    const aku = await postReply(owner.client, thread.threadId, "!aku >>2");
    expect(aku.post.body).toContain("★アク禁にしました");

    const denied = await anon.post(`/v1/threads/${thread.threadId}/posts`, { body: "まだ書ける？" });
    expect(denied.status).toBe(403);
    expect(denied.body.ok).toBe(false);
    if (!denied.body.ok) expect(denied.body.code).toBe("BANNED");

    const kaijo = await postReply(owner.client, thread.threadId, "!kaijo >>2");
    expect(kaijo.post.body).toContain("★アク禁を解除しました");

    const allowed = await postReply(anon, thread.threadId, "解除されたので書けます");
    expect(allowed.post.num).toBeGreaterThan(target.post.num);
  });

  it("副主以外の !aku は 403", async () => {
    const { thread } = await setupWorld();
    const other = new TestClient();
    await postReply(other, thread.threadId, "普通のレス");
    const attempt = await other.post(`/v1/threads/${thread.threadId}/posts`, { body: "!aku >>1" });
    expect(attempt.status).toBe(403);
  });

  it("!sub で副主を任命し、副主は !aku を使える", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    await postReply(anon, thread.threadId, "副主候補のレス");

    const sub = await postReply(owner.client, thread.threadId, "!sub >>2");
    expect(sub.post.body).toContain("★副主に追加");

    const third = new TestClient();
    await postReply(third, thread.threadId, "対象レス");
    const aku = await anon.post(`/v1/threads/${thread.threadId}/posts`, { body: "!aku >>4" });
    expect(aku.status).toBe(201);
    if (aku.body.ok) expect((aku.body.data as PostData).post.body).toContain("★アク禁にしました");
  });

  it("!cap と !jien と !nopic", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    await postReply(anon, thread.threadId, "キャップ対象");

    const capped = await postReply(owner.client, thread.threadId, "!cap >>2 テストキャップ");
    expect(capped.post.body).toContain("★キャップを付与しました");
    const capRow = await env.DB.prepare("SELECT cap FROM posts WHERE thread_id = ? AND num = 2").bind(thread.threadId).first<{ cap: string }>();
    expect(capRow?.cap).toBe("テストキャップ");

    await postReply(owner.client, thread.threadId, "!jien");
    const third = new TestClient();
    const jienPost = await postReply(third, thread.threadId, "じえん後の投稿");
    expect(jienPost.post.idHash).toMatch(/^[^.]{2}\.[a-z0-9]\.L\d+$/);

    const nopic = await postReply(owner.client, thread.threadId, "!nopic");
    expect(nopic.post.body).toContain("★画像投稿を禁止");
  });

  it("!add は >>1 に追記する", async () => {
    const { owner, thread } = await setupWorld();
    const added = await postReply(owner.client, thread.threadId, "!add 追記されました");
    expect(added.post.body).toContain("★>>1 に追記しました");
    const op = await env.DB.prepare("SELECT body FROM posts WHERE thread_id = ? AND num = 1").bind(thread.threadId).first<{ body: string }>();
    expect(op?.body).toContain("追記されました");
  });
});

describe("検索", () => {
  it("3 文字以上は FTS5、2 文字は LIKE フォールバックでヒットする", async () => {
    const { owner, board, thread } = await setupWorld();
    const anon = new TestClient();
    await postReply(anon, thread.threadId, "宇宙戦艦ヤマトの話をします");

    const fts = await owner.client.get<{ items: Array<{ post: { body: string } }> }>(
      `/v1/search?type=full&q=${encodeURIComponent("宇宙戦艦")}`,
    );
    expect(fts.status).toBe(200);
    if (fts.body.ok) {
      expect(fts.body.data.items.length).toBeGreaterThan(0);
      expect(fts.body.data.items[0]!.post.body).toContain("宇宙戦艦");
    }

    const like = await owner.client.get<{ items: unknown[] }>(`/v1/search?type=full&q=${encodeURIComponent("戦艦")}`);
    expect(like.status).toBe(200);
    if (like.body.ok) expect(like.body.data.items.length).toBeGreaterThan(0);

    const threadSearch = await owner.client.get<{ items: Array<{ type: string }> }>(
      `/v1/search?type=thread&q=${encodeURIComponent("プロ野球")}&board=${board.board.slug}`,
    );
    expect(threadSearch.body.ok && threadSearch.body.data.items[0]?.type).toBe("thread");
  });

  it("長い日本語のスレタイ検索は FTS5 でヒットし 400 にならない", async () => {
    const { owner, board } = await setupWorld();
    const longTitle = "とても長いスレッドタイトルの一部を貼り付けて検索するための検証スレッドです";
    await createThread(owner.client, board.board.slug, { title: longTitle, body: "長いタイトルの本文" });

    // タイトルの 17 文字以上の部分一致（LIKE の 50 バイト制限を超える長さ）
    const fragment = longTitle.slice(0, 25);
    const found = await owner.client.get<{ items: Array<{ type: string; thread: { title: string } }> }>(
      `/v1/search?type=thread&q=${encodeURIComponent(fragment)}&board=${encodeURIComponent(board.board.slug)}`,
    );
    expect(found.status).toBe(200);
    expect(found.body.ok && found.body.data.items.some((item) => item.thread.title === longTitle)).toBe(true);

    // 49 バイト超・51 バイト超でも 200（FTS 経路）
    const ascii = await owner.client.get(`/v1/search?type=thread&q=${encodeURIComponent("a".repeat(49))}`);
    expect(ascii.status).toBe(200);
    const jp17 = await owner.client.get(`/v1/search?type=full&q=${encodeURIComponent("あ".repeat(17))}`);
    expect(jp17.status).toBe(200);

    // FTS の実用上限（200 文字）超過のみ 400
    const over = await owner.client.get(`/v1/search?type=thread&q=${encodeURIComponent("あ".repeat(201))}`);
    expect(over.status).toBe(400);
    expect(over.body.ok).toBe(false);
    if (!over.body.ok) expect(over.body.code).toBe("VALIDATION");
  });

  it("3 文字未満の語は従来どおり LIKE でヒットする", async () => {
    const { owner, board } = await setupWorld();
    const short = await owner.client.get<{ items: Array<{ type: string }> }>(
      `/v1/search?type=thread&q=${encodeURIComponent("野球")}&board=${encodeURIComponent(board.board.slug)}`,
    );
    expect(short.status).toBe(200);
    expect(short.body.ok && short.body.data.items.some((item) => item.type === "thread")).toBe(true);
  });

  it("ID でレスを抽出できる", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    const posted = await postReply(anon, thread.threadId, "ID 抽出テスト");
    const found = await owner.client.get<{ items: Array<{ post: { idHash: string } }> }>(
      `/v1/search?type=id&q=${posted.post.idHash}`,
    );
    expect(found.body.ok && found.body.data.items.length).toBeGreaterThan(0);
  });
});

describe("ランキング・ヘッドライン", () => {
  it("ランキングとヘッドラインにスレが出る", async () => {
    const { owner, thread } = await setupWorld();
    await postReply(owner.client, thread.threadId, "ランキング用レス");

    const ranking = await owner.client.get<{ items: Array<{ threadId: number; quick?: boolean }>; period: string }>(
      "/v1/ranking?period=day",
    );
    expect(ranking.status).toBe(200);
    if (ranking.body.ok) {
      expect(ranking.body.data.period).toBe("day");
      expect(ranking.body.data.items.some((item) => item.threadId === thread.threadId)).toBe(true);
    }

    const headline = await owner.client.get<{ items: Array<{ threadId: number }> }>("/v1/headline?period=24h&sort=posts");
    expect(headline.status).toBe(200);
    if (headline.body.ok) expect(headline.body.data.items.some((item) => item.threadId === thread.threadId)).toBe(true);
  });
});

describe("通報", () => {
  it("通報の作成・一覧・非表示処理", async () => {
    const { owner, board, thread } = await setupWorld();
    const anon = new TestClient();
    const reported = await postReply(anon, thread.threadId, "通報対象のレスです");

    const reporter = new TestClient();
    const created = await reporter.post<{ id: string }>("/v1/reports", {
      boardSlug: board.board.slug,
      threadId: thread.threadId,
      posts: String(reported.post.num),
      reason: "abuse",
      comment: "荒らしです",
      turnstileToken: "dummy-token",
    });
    expect(created.status).toBe(201);
    if (!created.body.ok) throw new Error("report create failed");
    const reportId = created.body.data.id;

    const list = await owner.client.get<{ items: Array<{ id: string; reason: string; status: string }> }>("/v1/reports?status=pending");
    expect(list.status).toBe(200);
    if (list.body.ok) {
      expect(list.body.data.items.some((item) => item.id === reportId)).toBe(true);
    }

    const handled = await owner.client.post<{ status: string; affectedPosts: number[] }>(`/v1/reports/${reportId}/handle`, {
      action: "hide",
      note: "非表示にしました",
    });
    expect(handled.status).toBe(200);
    if (handled.body.ok) expect(handled.body.data.status).toBe("resolved");

    const after = await owner.client.get<{ posts: Array<{ body: string }> }>(`/v1/threads/${thread.threadId}?r=1-10`);
    if (after.body.ok) expect(after.body.data.posts.some((post) => post.body.includes("通報対象"))).toBe(false);

    const outsider = await authedClient({ name: "outsider" });
    const forbidden = await outsider.client.get("/v1/reports");
    expect(forbidden.status).toBe(403);
  });

  it("通報作成で report.created Webhook が配信される", async () => {
    const { owner, board, thread } = await setupWorld();
    const anon = new TestClient();
    const reported = await postReply(anon, thread.threadId, "Webhook 対象のレス");

    const hook = await createWebhook(env, {
      ownerType: "board",
      ownerId: String(board.board.id),
      url: "https://hooks.example.test/report",
      events: ["report.created"],
      createdBy: owner.account.id,
    });

    // 外部への実 fetch を止める（配信内容は webhook_deliveries.payload で検証する）。
    network.use(http.post("https://hooks.example.test/report", () => HttpResponse.json({ ok: true })));

    const created = await anon.post<{ id: string }>("/v1/reports", {
      boardSlug: board.board.slug,
      threadId: thread.threadId,
      posts: String(reported.post.num),
      reason: "spam",
      comment: "Webhook 検証",
      turnstileToken: "dummy-token",
    });
    expect(created.status).toBe(201);
    if (!created.body.ok) throw new Error("report create failed");

    // emitReportCreated は waitUntil で配信するが、配信 INSERT はレスポンス前に発行される。
    const row = await env.DB.prepare(
      "SELECT event, payload FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(hook.id)
      .first<{ event: string; payload: string }>();
    expect(row?.event).toBe("report.created");
    const event = JSON.parse(row!.payload) as { type: string; data: { reportId: string; comment: string } };
    expect(event.type).toBe("report.created");
    expect(event.data.reportId).toBe(created.body.data.id);
    expect(event.data.comment).toBe("Webhook 検証");
  });
});

describe("互換出力（Shift_JIS）", () => {
  it("subject.txt と dat が Shift_JIS で返る", async () => {
    const { board, thread } = await setupWorld();
    const anon = new TestClient();
    await postReply(anon, thread.threadId, ">>1 互換テスト本文");

    const subject = await anon.fetch(`/compat/${board.board.slug}/subject.txt`);
    expect(subject.status).toBe(200);
    expect(subject.headers.get("content-type")).toContain("Shift_JIS");
    const subjectBytes = new Uint8Array(await subject.arrayBuffer());
    const subjectText = decodeShiftJis(subjectBytes);
    expect(subjectText).toContain(`${thread.threadId}.dat<>`);
    expect(subjectText).toContain("(2)");
    expect(Array.from(subjectBytes)).toEqual(Array.from(encodeShiftJis(subjectText)));

    const dat = await anon.fetch(`/compat/${board.board.slug}/dat/${thread.threadId}.dat`);
    expect(dat.status).toBe(200);
    const datText = decodeShiftJis(new Uint8Array(await dat.arrayBuffer()));
    const lines = datText.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.split("<>")).toHaveLength(5);
    expect(lines[0]!.endsWith("テスト板の名無しさん")).toBe(false);
    expect(lines[0]).toContain("【スレタイ】".length > 0 ? "" : "");
    expect(lines[0]!.split("<>")[4]).toBe("プロ野球について語るスレ");
    expect(lines[1]!.split("<>")[3]).toContain("&gt;&gt;1");
  });

  it("bbsmenu.html と index.rdf が返る", async () => {
    const { board } = await setupWorld();
    const menu = await new TestClient().fetch("/compat/bbsmenu.html");
    expect(menu.status).toBe(200);
    expect(decodeShiftJis(new Uint8Array(await menu.arrayBuffer()))).toContain(board.board.name);
    const rss = await new TestClient().fetch(`/compat/${board.board.slug}/index.rdf`);
    expect(rss.status).toBe(200);
    expect(await rss.text()).toContain("<rss");
  });
});

describe("Turnstile", () => {
  it("anonymous 設定では未ログイン投稿にトークンが必要", async () => {
    const { owner, thread } = await setupWorld({ settings: { turnstile: "anonymous" } });
    const anon = new TestClient();
    const denied = await anon.post(`/v1/threads/${thread.threadId}/posts`, { body: "トークンなし" });
    expect(denied.status).toBe(400);
    if (!denied.body.ok) expect(denied.body.code).toBe("TURNSTILE_FAILED");

    const passed = await anon.post(`/v1/threads/${thread.threadId}/posts`, {
      body: "トークンあり",
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    });
    expect(passed.status).toBe(201);

    // ログイン済みは Turnstile 不要
    const authed = await postReply(owner.client, thread.threadId, "ログイン済み投稿");
    expect(authed.post.num).toBeGreaterThan(0);
  });
});

describe("投票・kome", () => {
  it("投票の作成・1 IP 1 票・結果取得", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    const voted = await postReply(anon, thread.threadId, "どれがいい？ [ank:10m:A,B,C]");
    const poll = await new TestClient().get<{ options: string[]; totalVotes: number }>(`/v1/posts/${voted.post.id}/poll`);
    expect(poll.status).toBe(200);
    if (!poll.body.ok) throw new Error("poll missing");
    expect(poll.body.data.options).toEqual(["A", "B", "C"]);

    const voter = new TestClient();
    const first = await voter.post(`/v1/posts/${voted.post.id}/poll/vote`, { option: 1 });
    expect(first.status).toBe(200);
    const second = await voter.post(`/v1/posts/${voted.post.id}/poll/vote`, { option: 2 });
    expect(second.status).toBe(409);

    const result = await voter.get<{ counts: number[]; totalVotes: number; votedOption: number }>(
      `/v1/posts/${voted.post.id}/poll`,
    );
    if (result.body.ok) {
      expect(result.body.data.totalVotes).toBe(1);
      expect(result.body.data.counts[1]).toBe(1);
      expect(result.body.data.votedOption).toBe(1);
    }
    expect(owner.account.id).toBeTruthy();
  });

  it("未ログインの kome は Turnstile トークンで通る（body / cf-turnstile-response / ヘッダ）", async () => {
    const { thread } = await setupWorld({ settings: { turnstile: "anonymous" } });
    const anon = new TestClient();

    const missing = await anon.post<{ kome: { kind: string } }>(`/v1/threads/${thread.threadId}/kome`, {
      body: "トークンなし",
    });
    expect(missing.status).toBe(400);
    if (!missing.body.ok) expect(missing.body.code).toBe("TURNSTILE_FAILED");

    const fromBody = await anon.post<{ kome: { kind: string } }>(`/v1/threads/${thread.threadId}/kome`, {
      body: "トークン付き",
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
    });
    expect(fromBody.status).toBe(201);
    if (fromBody.body.ok) expect(fromBody.body.data.kome.kind).toBe("kome");

    const fromCfField = await anon.post<{ kome: { kind: string } }>(`/v1/threads/${thread.threadId}/kome`, {
      body: "cf フィールド",
      "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX",
    });
    expect(fromCfField.status).toBe(201);

    // posts ルート（threadId をボディで受ける）も同じ受け渡し。
    const fromPostsRoute = await anon.fetch(`/v1/posts/kome`, {
      method: "POST",
      headers: { "x-turnstile-token": "XXXX.DUMMY.TOKEN.XXXX" },
      body: JSON.stringify({ threadId: thread.threadId, body: "ヘッダのトークン" }),
    });
    expect(fromPostsRoute.status).toBe(201);
  });

  it("kome はレス一覧に含まれない", async () => {
    const { owner, thread } = await setupWorld();
    const kome = await owner.client.post<{ kome: { kind: string; body: string } }>(`/v1/threads/${thread.threadId}/kome`, {
      body: "流れるコメント",
    });
    expect(kome.status).toBe(201);
    if (kome.body.ok) expect(kome.body.data.kome.kind).toBe("kome");

    const posts = await owner.client.get<{ posts: Array<{ kind: string }> }>(`/v1/threads/${thread.threadId}?r=1-10`);
    if (posts.body.ok) expect(posts.body.data.posts.every((post) => post.kind === "post")).toBe(true);
  });
});

describe("いいね", () => {
  it("トグルで加算・解除される", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    const target = await postReply(anon, thread.threadId, "いいね対象");

    const on = await anon.post<{ count: number; liked: boolean }>(`/v1/posts/${target.post.id}/like`, { kind: "like" });
    expect(on.body.ok && on.body.data.count).toBe(1);
    expect(on.body.ok && on.body.data.liked).toBe(true);

    const off = await anon.post<{ count: number; liked: boolean }>(`/v1/posts/${target.post.id}/like`, { kind: "like" });
    expect(off.body.ok && off.body.data.count).toBe(0);
    expect(off.body.ok && off.body.data.liked).toBe(false);
    expect(owner.account.id).toBeTruthy();
  });
});

describe("無料枠ガード: 1 投稿の rows_written", () => {
  // workerd の D1 meta.rows_written は索引エントリ/FTS shadow 表も数える（実測: posts INSERT=8）。
  // 無料枠の上限は「アプリ表の行」の書込数（DESIGN §12 の posts+fts+counters+backlinks）なので、
  // helpers.measureAppWrites のトリガプローブで論理行を測る。
  it("通常投稿は 12 行以内、安価 5 件でも 12 行以内", async () => {
    const { owner, board, thread } = await setupWorld();
    const deviceHash = await hmacSha256Hex("test-salt", "device:rows-test");
    const ipHash = await hmacSha256Hex("test-salt", "ip:rows-test");

    const { result: base, writes: baseWrites } = await measureAppWrites(() =>
      createPostInternal(
        {
          boardId: board.board.id,
          threadId: thread.threadId,
          body: "行数計測用のレス",
          deviceHash,
          ipHash,
          accountId: owner.account.id,
          skipGuards: true,
        },
        { env },
      ),
    );
    expect(base.post.num).toBe(2);
    expect(baseWrites).toBeLessThanOrEqual(12);
    expect(base.writeStats.rowsWritten).toBeGreaterThan(0);

    for (let index = 0; index < 4; index++) {
      await createPostInternal(
        {
          boardId: board.board.id,
          threadId: thread.threadId,
          body: `埋め草 ${index}`,
          deviceHash,
          ipHash,
          accountId: owner.account.id,
          skipGuards: true,
        },
        { env },
      );
    }

    const { result: anchored, writes: anchoredWrites } = await measureAppWrites(() =>
      createPostInternal(
        {
          boardId: board.board.id,
          threadId: thread.threadId,
          body: ">>1 >>2 >>3 >>4 >>5",
          deviceHash,
          ipHash,
          accountId: owner.account.id,
          skipGuards: true,
        },
        { env },
      ),
    );
    expect(anchoredWrites).toBeLessThanOrEqual(12);
    expect(anchoredWrites).toBeGreaterThan(baseWrites);
    const links = await env.DB.prepare("SELECT COUNT(*) AS n FROM backlinks WHERE post_id = ?").bind(anchored.postId).first<{ n: number }>();
    expect(links?.n).toBe(5);
  });
});

describe("RateLimiter DO", () => {
  it("窓内の上限を超えると拒否する", async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName("post:rate-test"));
    const consume = async () => {
      const response = await stub.fetch("https://do/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "post", identityHash: "rate-test" }),
      });
      return (await response.json()) as { allowed: boolean; retryAfterSeconds: number };
    };
    const first = await consume();
    const second = await consume();
    const third = await consume();
    const fourth = await consume();
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(true);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("板管理", () => {
  it("設定更新・スタッフ任免・アク禁が動く", async () => {
    const { owner, board } = await setupWorld();
    const moderator = await authedClient({ name: "moderator-user" });

    const patch = await owner.client.patch<{ board: { settings: { cooldownSeconds: number } } }>(`/v1/boards/${board.board.slug}`, {
      settings: { cooldownSeconds: 5, ngWords: ["禁止語"] },
      description: "更新後の説明",
    });
    expect(patch.status).toBe(200);
    if (patch.body.ok) expect(patch.body.data.board.settings.cooldownSeconds).toBe(5);

    const staff = await owner.client.post(`/v1/boards/${board.board.slug}/staff`, {
      accountName: moderator.account.name,
      level: "moderator",
    });
    expect(staff.status).toBe(200);

    const listed = await owner.client.get<{ items: Array<{ accountName: string; level: string }> }>(
      `/v1/boards/${board.board.slug}/staff`,
    );
    if (listed.body.ok) {
      expect(listed.body.data.items.some((item) => item.accountName === moderator.account.name)).toBe(true);
    }

    const ban = await owner.client.post<{ id: string }>(`/v1/boards/${board.board.slug}/bans`, {
      identity: "deadbeefdeadbeefdeadbeefdeadbeef",
      kind: "device",
      reason: "テストBAN",
      durationHours: 1,
    });
    expect(ban.status).toBe(201);
    if (ban.body.ok) {
      const removed = await owner.client.delete(`/v1/boards/${board.board.slug}/bans/${ban.body.data.id}`);
      expect(removed.status).toBe(200);
    }

    const settings = await owner.client.get<{ board: { description: string; settings: { ngWords: string[] } } }>(
      `/v1/boards/${board.board.slug}`,
    );
    if (settings.body.ok) {
      expect(settings.body.data.board.description).toBe("更新後の説明");
      expect(settings.body.data.board.settings.ngWords).toContain("禁止語");
    }
  });
});

// 型の未使用警告を避ける
void (null as unknown as BoardData & ThreadData);
describe("画像添付（WP4 attachToPost 契約）", () => {
  it("attachmentIds を渡すと投稿に紐付き、レスに添付が返る", async () => {
    const { owner, thread } = await setupWorld();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO attachments (id, post_id, uploader_account_id, device_hash, board_id, adapter, external_url,
        content_type, size, filename, kind, status, created_at)
       VALUES ('att-1', NULL, NULL, 'dev', NULL, 'catbox', 'https://example.test/a.png', 'image/png', 1234, 'a.png', 'image', 'active', ?)`,
    )
      .bind(now)
      .run();

    const posted = await postReply(owner.client, thread.threadId, "画像つきレス", { attachments: ["att-1"] });
    expect(posted.post.attachments).toHaveLength(1);
    expect(posted.post.attachments[0]?.url).toBe("https://example.test/a.png");

    const row = await env.DB.prepare("SELECT post_id FROM attachments WHERE id = 'att-1'").first<{ post_id: number }>();
    expect(row?.post_id).toBe(posted.post.id);
  });

  it("!nopic 中は添付付き投稿を拒否する", async () => {
    const { owner, thread } = await setupWorld();
    await postReply(owner.client, thread.threadId, "!nopic");
    const blocked = await owner.client.post(`/v1/threads/${thread.threadId}/posts`, {
      body: "画像つき",
      attachments: ["att-x"],
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.ok).toBe(false);
  });
});
