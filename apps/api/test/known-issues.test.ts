// 既知不具合（K1・K2）の回帰テスト。
// K1: つぶやきの !jien 表示 ID が Lv1 固定だった（レス・編集は端末の投稿数から Lv を計算）。
// K2: 削除板のスレがスレ単位の読み取り API から見えていた（板は一覧から消え、本体 API も一般には無い扱い）。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authedClient, createBoard, createThread, postReply, resetWorld, TestClient } from "./wp1/helpers";
import type { PostData } from "./wp1/helpers";
import { api, createAgent, makeSession } from "./ai-helpers";

beforeEach(async () => {
  await resetWorld();
});

/** 端末の投稿数を直接進める（Lv2 以上をテストで作る。実際は 50 投稿ごとに +1）。 */
async function setDevicePostCount(postId: number, postCount: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE devices SET post_count = ? WHERE device_hash = (SELECT device_hash FROM posts WHERE id = ?)",
  )
    .bind(postCount, postId)
    .run();
}

describe("K1: つぶやきの !jien 表示 ID はレスと同じ忍法帖 Lv", () => {
  it("つぶやきの表示 ID はレスと同じ計算（端末の投稿数 + 1）で Lv が付く", async () => {
    const owner = await authedClient({ name: "k1-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const anon = new TestClient();
    const thread = await createThread(anon, board.board.slug, { title: "jien とつぶやき", body: "本文" });
    await postReply(anon, thread.threadId, "!jien");
    // スレ主（匿名端末）を Lv2（投稿数 50 以上）にする。
    const seed = await postReply(anon, thread.threadId, "Lv を上げる前のレス");
    await setDevicePostCount(seed.post.id, 60);

    const reply = await postReply(anon, thread.threadId, "Lv2 のレス");
    expect(reply.post.idHash).toContain(".L2");

    const tsu = await anon.post<{ tsubuyaki: PostData["post"] }>(`/v1/threads/${thread.threadId}/tsubuyaki`, {
      body: "Lv2 のつぶやき",
    });
    expect(tsu.status).toBe(201);
    if (!tsu.body.ok) throw new Error(JSON.stringify(tsu.body));
    const tsubuyaki = tsu.body.data.tsubuyaki;
    // 表示に出す ID はレスと同じ（同じ端末・同じ Lv）。
    expect(tsubuyaki.idHash).toBe(reply.post.idHash);
    expect(tsubuyaki.idHash).toMatch(/^[^.]+\.\w\.L2$/);

    // つぶやきは端末の投稿数を進めない（現状仕様のまま。レスを 1 件書いた 61 のまま）。
    const row = await env.DB.prepare(
      "SELECT d.post_count AS n FROM devices d JOIN posts p ON p.device_hash = d.device_hash WHERE p.id = ?",
    )
      .bind(seed.post.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(61);
  });

  it("Lv2 で表示 ID アク禁された相手は、同じ IP の別端末からつぶやけない", async () => {
    const owner = await authedClient({ name: "k1-aku-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const anon = new TestClient();
    const thread = await createThread(anon, board.board.slug, { title: "jien アク禁とつぶやき", body: "本文" });
    await postReply(anon, thread.threadId, "!jien");

    // 同じ IP の 2 端末。どちらも忍法帖 Lv2（投稿数 50 以上）にする。
    const a = new TestClient();
    const b = new TestClient();
    const a1 = await postReply(a, thread.threadId, "A の最初のレス");
    const b1 = await postReply(b, thread.threadId, "B の最初のレス");
    for (const postId of [a1.post.id, b1.post.id]) await setDevicePostCount(postId, 60);
    const a2 = await postReply(a, thread.threadId, "A の Lv2 のレス");
    const b2 = await postReply(b, thread.threadId, "B の Lv2 のレス");
    expect(a2.post.idHash).toBe(b2.post.idHash);
    expect(a2.post.idHash).toContain(".L2");

    // スレ主が A のレス（Lv2 の表示 ID）をアク禁。
    const aku = await postReply(anon, thread.threadId, `!aku >>${a2.post.num}`);
    expect(aku.post.body).toContain("★アク禁にしました");

    // 同じ表示 ID の別端末 B は、レスだけでなくつぶやきも止まる（修正前は Lv1 で計算され通っていた）。
    const tsu = await b.post(`/v1/threads/${thread.threadId}/tsubuyaki`, { body: "アク禁中のつぶやき" });
    expect(tsu.status).toBe(403);
    if (!tsu.body.ok) expect(tsu.body.code).toBe("BANNED");
  });
});

describe("K2: 削除板のスレは一般の読み取り API から見えない", () => {
  it("一般には 404、板スタッフとサイト管理者には見える。カードは中身を出さない", async () => {
    const owner = await authedClient({ name: "k2-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "K2 秘密タイトル", body: "K2 秘密本文" });
    const reply = await postReply(owner.client, thread.threadId, "K2 秘密レス");
    await owner.client.patch(`/v1/posts/${reply.post.id}`, { body: "K2 秘密レスの編集後" });
    const paths = [
      `/v1/boards/${board.board.slug}`,
      `/v1/boards/${board.board.slug}/threads`,
      `/v1/boards/${board.board.slug}/staff`,
      `/v1/boards/${board.board.slug}/turnstile`,
      `/v1/threads?board=${board.board.slug}`,
      `/v1/threads/${thread.threadId}`,
      `/v1/threads/${thread.threadId}/posts`,
      `/v1/threads/${thread.threadId}/quotes`,
      `/v1/threads/${thread.threadId}/range`,
      `/v1/posts/${reply.post.id}`,
      `/v1/posts/${reply.post.id}/history`,
      `/v1/posts/${reply.post.id}/backlinks`,
      `/v1/posts/${reply.post.id}/like`,
      // 専ブラ互換（subject.txt / dat / RSS）もスレ内容を返す読み取り API。
      `/compat/${board.board.slug}/subject.txt`,
      `/compat/${board.board.slug}/dat/${thread.threadId}.dat`,
      `/compat/${board.board.slug}/index.rdf`,
    ];

    // 削除前は一般（Cookie なし）でも読める。
    const anon = new TestClient();
    for (const path of paths) {
      expect((await anon.get(path)).status, `削除前: ${path}`).toBe(200);
    }

    await env.DB.prepare("UPDATE boards SET status = 'deleted' WHERE id = ?").bind(board.board.id).run();

    // 一般には「無い板・無いスレ」として 404。どの応答にもスレタイ・本文・レスを載せない。
    for (const path of paths) {
      const response = await anon.get(path);
      expect(response.status, `削除後（一般）: ${path}`).toBe(404);
      const text = JSON.stringify(response.body);
      expect(text, `削除後（一般）の応答本文: ${path}`).not.toContain("K2 秘密");
    }

    // インラインカードは 200 のまま「削除されたスレ」だけを返す（R74-05 の挙動を変えない）。
    const card = await anon.get(`/v1/threads/${thread.threadId}/card`);
    expect(card.status).toBe(200);
    expect(JSON.stringify(card.body)).not.toContain("K2 秘密");

    // 板スタッフ（板の管理人）は管理・確認のため見える。
    for (const path of paths) {
      expect((await owner.client.get(path)).status, `削除後（板スタッフ）: ${path}`).toBe(200);
    }

    // サイト管理者も見える（板スタッフでない owner ロールのアカウント）。
    const siteAdmin = await authedClient({ role: "owner", name: "k2-site-admin" });
    const detail = await siteAdmin.client.get<{ thread: { title: string }; posts: Array<{ body: string }> }>(
      `/v1/threads/${thread.threadId}`,
    );
    expect(detail.status).toBe(200);
    if (detail.body.ok) expect(detail.body.data.thread.title).toBe("K2 秘密タイトル");
  });

  it("削除板への書き込み（スレ・レス・つぶやき・評価）は拒否される", async () => {
    const owner = await authedClient({ name: "k2-write-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "書き込み拒否", body: "本文" });
    const reply = await postReply(owner.client, thread.threadId, "レス");

    await env.DB.prepare("UPDATE boards SET status = 'deleted' WHERE id = ?").bind(board.board.id).run();

    const boardPatch = await owner.client.patch(`/v1/boards/${board.board.slug}`, { description: "変更" });
    expect(boardPatch.status).toBe(409);
    const threadPatch = await owner.client.patch(`/v1/threads/${thread.threadId}`, { title: "変更" });
    expect(threadPatch.status).toBe(409);
    const threadDelete = await owner.client.delete(`/v1/threads/${thread.threadId}`);
    expect(threadDelete.status).toBe(409);
    const postPatch = await owner.client.patch(`/v1/posts/${reply.post.id}`, { body: "変更" });
    expect(postPatch.status).toBe(409);
    const postDelete = await owner.client.delete(`/v1/posts/${reply.post.id}`);
    expect(postDelete.status).toBe(409);
    const like = await owner.client.post(`/v1/posts/${reply.post.id}/like`, {});
    expect(like.status).toBe(409);
    const newPost = await owner.client.post(`/v1/threads/${thread.threadId}/posts`, { body: "新規" });
    expect(newPost.status).toBe(409);
    const tsu = await owner.client.post(`/v1/threads/${thread.threadId}/tsubuyaki`, { body: "つぶやき" });
    expect(tsu.status).toBe(409);
  });
});
describe("T11-01: 横断一覧・リアルタイムに削除板の内容を出さない", () => {
  it("検索（全種別・板指定）・ランキング・ヘッドライン・rt recent/ticket が匿名に返さない", async () => {
    const owner = await authedClient({ name: "t11-01-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "T1101 秘密タイトル", body: "T1101 秘密本文" });
    const reply = await postReply(owner.client, thread.threadId, "T1101 秘密レス");
    // 公開板の対照（検索・ランキングの正例）。
    const publicBoard = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    await createThread(owner.client, publicBoard.board.slug, { title: "T1101 公開スレ", body: "公開本文" });

    await owner.client.delete(`/v1/boards/${board.board.slug}?confirm=1`);

    const anon = new TestClient();
    const jsonPaths = [
      `/v1/search?q=T1101&type=thread`,
      `/v1/search?q=T1101&type=full`,
      `/v1/search?q=${reply.post.idHash}&type=id`,
      `/v1/ranking`,
      `/v1/ranking?metric=posts`,
      `/v1/ranking?metric=connections`,
      `/v1/headline`,
    ];
    for (const path of jsonPaths) {
      const response = await anon.get(path);
      expect(response.status, path).toBe(200);
      expect(JSON.stringify(response.body), `匿名に削除板の内容が出る: ${path}`).not.toContain("T1101 秘密");
    }
    // 板を指定した検索・ランキング・ヘッドラインは、削除板そのものが 404。
    for (const path of [
      `/v1/search?q=T1101&type=thread&board=${board.board.slug}`,
      `/v1/search?q=T1101&type=full&board=${board.board.slug}`,
      `/v1/ranking?board=${board.board.slug}`,
      `/v1/headline?board=${board.board.slug}`,
    ]) {
      expect((await anon.get(path)).status, path).toBe(404);
    }
    // リアルタイム（過去バッファ・購読チケット）も削除板は 404。
    for (const channel of [`thread:${thread.threadId}`, `board:${board.board.id}`]) {
      const recent = await anon.get(`/rt/recent?channel=${channel}`);
      expect(recent.status, `rt recent ${channel}`).toBe(404);
      expect(JSON.stringify(recent.body)).not.toContain("T1101 秘密");
      const ticket = await anon.post("/rt/ticket", { channels: [channel] });
      expect(ticket.status, `rt ticket ${channel}`).toBe(404);
    }

    // 公開板の内容は従来どおり検索・ランキングに出る。
    const publicSearch = await anon.get(`/v1/search?q=T1101&type=thread`);
    expect(JSON.stringify(publicSearch.body)).toContain("T1101 公開スレ");
    const publicRanking = await anon.get("/v1/ranking");
    expect(JSON.stringify(publicRanking.body)).toContain("T1101 公開スレ");

    // 板スタッフ（板の管理人）は削除板を指定した検索・ランキング・recent を読める。
    const staffSearch = await owner.client.get(`/v1/search?q=T1101&type=thread&board=${board.board.slug}`);
    expect(staffSearch.status).toBe(200);
    if (staffSearch.body.ok) expect(JSON.stringify(staffSearch.body)).toContain("T1101 秘密タイトル");
    expect((await owner.client.get(`/v1/ranking?board=${board.board.slug}`)).status).toBe(200);
    expect((await owner.client.get(`/rt/recent?channel=thread:${thread.threadId}`)).status).toBe(200);
  });
});

describe("T11-02: account AI は実権限が無ければ削除板を読めない", () => {
  it("板と無関係の一般ユーザーの account agent は 6 経路とも中身を返さず、板スタッフの agent は読める", async () => {
    const owner = await authedClient({ name: "t11-02-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "T1102 秘密タイトル", body: "T1102 秘密本文" });
    const reply = await postReply(owner.client, thread.threadId, "T1102 秘密レス");

    // 板と無関係の一般ユーザー（板スタッフではない）が、自分の account AI に削除板を担当させる。
    const outsider = await authedClient({ name: "t11-02-outsider" });
    const outsiderCookie = await makeSession(outsider.account.id);
    const outsiderAgent = await createAgent(outsiderCookie, {
      name: "T1102 outsider reader",
      ownerType: "account",
      allowedBoards: [board.board.id],
      riskCap: "low",
    });
    // 板の管理人（板スタッフ）の account AI（正例）。
    const staffCookie = await makeSession(owner.account.id);
    const staffAgent = await createAgent(staffCookie, {
      name: "T1102 staff reader",
      ownerType: "account",
      allowedBoards: [board.board.id],
      riskCap: "low",
    });

    await owner.client.delete(`/v1/boards/${board.board.slug}?confirm=1`);

    const paths = [
      `/v1/ai/threads?boardId=${board.board.id}`,
      `/v1/ai/threads/${thread.threadId}`,
      `/v1/ai/threads/${thread.threadId}/posts`,
      `/v1/ai/posts/${reply.post.id}`,
      `/v1/ai/search?q=T1102&boardId=${board.board.id}`,
      `/v1/ai/feed?boardId=${board.board.id}`,
    ];
    for (const path of paths) {
      const response = await api(path, { key: outsiderAgent.apiKey });
      const text = await response.text();
      expect([403, 404], `${path} は拒否される`).toContain(response.status);
      expect(text, `一般ユーザーの AI に中身が出る: ${path}`).not.toContain("T1102 秘密");
    }
    for (const path of paths) {
      const response = await api(path, { key: staffAgent.apiKey });
      expect(response.status, `板スタッフの AI は読める: ${path}`).toBe(200);
    }
    // 削除板を担当していない横断検索・フィードにも中身を出さない。
    for (const path of [`/v1/ai/search?q=T1102`, `/v1/ai/feed`]) {
      const response = await api(path, { key: outsiderAgent.apiKey });
      const text = await response.text();
      expect(text, path).not.toContain("T1102 秘密");
    }
  });
});

describe("T11-03: 削除板の読み取りはスタッフに許し、書き込みだけを凍結する", () => {
  it("板スタッフ・サイト管理者の GET bans は 200、一般は 401、書き込みは 409", async () => {
    const owner = await authedClient({ name: "t11-03-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    await createThread(owner.client, board.board.slug, { title: "T1103", body: "本文" });
    const moderator = await authedClient({ name: "t11-03-moderator" });
    // サイト管理者（owner は seed で 1 人だけ。special_admin も同じ全板の権限を持つ）。
    const siteAdmin = await authedClient({ role: "special_admin", name: "t11-03-site-admin" });
    await env.DB.prepare(
      "INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, 'moderator', ?, ?)",
    )
      .bind(board.board.id, moderator.account.id, owner.account.id, Math.floor(Date.now() / 1000))
      .run();

    await owner.client.delete(`/v1/boards/${board.board.slug}?confirm=1`);

    // 読み取り（管理用）はスタッフ・サイト管理者に開く。
    expect((await owner.client.get(`/v1/boards/${board.board.slug}/bans`)).status).toBe(200);
    expect((await moderator.client.get(`/v1/boards/${board.board.slug}/bans`)).status).toBe(200);
    expect((await siteAdmin.client.get(`/v1/boards/${board.board.slug}/bans`)).status).toBe(200);
    // 一般（未ログイン）は従来どおり認証が要る。
    expect((await new TestClient().get(`/v1/boards/${board.board.slug}/bans`)).status).toBe(401);

    // 同じ板の書き込みは引き続き拒否する。
    expect((await owner.client.patch(`/v1/boards/${board.board.slug}`, { description: "変更" })).status).toBe(409);
    expect(
      (
        await owner.client.post(`/v1/boards/${board.board.slug}/staff`, {
          accountName: moderator.account.name,
          level: "deputy",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await owner.client.post(`/v1/boards/${board.board.slug}/bans`, {
          identity: "deadbeefdeadbeef",
          kind: "device",
          reason: "t11-03",
          durationHours: 1,
        })
      ).status,
    ).toBe(409);
  });
});

describe("T11-04: 通報処理からも削除板の内容を変えられない", () => {
  it("削除後に通報の hide/delete を送っても 409 で内容と通報 status が変わらない", async () => {
    const owner = await authedClient({ name: "t11-04-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "T1104", body: "本文" });
    const reply = await postReply(owner.client, thread.threadId, "T1104 通報対象");

    const reporter = new TestClient();
    const created = await reporter.post<{ id: string }>("/v1/reports", {
      boardSlug: board.board.slug,
      threadId: thread.threadId,
      posts: String(reply.post.num),
      reason: "abuse",
      comment: "T1104",
      turnstileToken: "dummy-token",
    });
    expect(created.status).toBe(201);
    if (!created.body.ok) throw new Error(JSON.stringify(created.body));
    const reportId = created.body.data.id;

    await owner.client.delete(`/v1/boards/${board.board.slug}?confirm=1`);

    for (const action of ["hide", "delete"] as const) {
      const handled = await owner.client.post(`/v1/reports/${reportId}/handle`, { action, note: "T1104" });
      expect(handled.status, action).toBe(409);
      const row = await env.DB.prepare("SELECT hidden, deleted FROM posts WHERE id = ?")
        .bind(reply.post.id)
        .first<{ hidden: number; deleted: number }>();
      expect(row, action).toEqual({ hidden: 0, deleted: 0 });
      const report = await env.DB.prepare("SELECT status FROM reports WHERE id = ?")
        .bind(reportId)
        .first<{ status: string }>();
      expect(report?.status, action).toBe("pending");
    }
  });
});
