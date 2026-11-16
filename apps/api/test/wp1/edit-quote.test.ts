// 71: レス・スレの本人編集・本人削除・引用スレ（設計 70）。
// 本人判定（端末・アカウント）・板設定の許可・時間制限・投稿検査の再利用・履歴・引用を検証する。

import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { network } from "../network";
import { TestClient, authedClient, createBoard, createThread, postReply, resetWorld } from "./helpers";

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

async function setupWorld(options: { settings?: Record<string, unknown> } = {}) {
  const owner = await authedClient({ name: "board-admin" });
  const board = await createBoard(owner.client, {
    name: "編集テスト板",
    category: "雑談",
    settings: { turnstile: "off", ...(options.settings ?? {}) },
  });
  const thread = await createThread(owner.client, board.board.slug, {
    title: "編集テストスレ",
    body: "1 の本文です",
  });
  return { owner, board, thread };
}

beforeEach(async () => {
  network.use(http.post(TURNSTILE_URL, () => HttpResponse.json({ success: true })));
  await resetWorld();
});

describe("本人編集・本人削除", () => {
  it("匿名ブラウザ（Cookie のみ）で自分のレスを編集でき、履歴が残る", async () => {
    const { thread } = await setupWorld();
    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "2 の本文です");
    expect(reply.post.num).toBe(2);

    const edited = await anon.patch<{ post: { body: string; editedCount: number; mine: boolean } }>(
      `/v1/posts/${reply.post.id}`,
      { body: "2 の本文（編集後）" },
    );
    expect(edited.status).toBe(200);
    if (!edited.body.ok) throw new Error(JSON.stringify(edited.body));
    expect(edited.body.data.post.body).toBe("2 の本文（編集後）");
    expect(edited.body.data.post.editedCount).toBe(1);
    expect(edited.body.data.post.mine).toBe(true);

    // 履歴は誰でも取得できる（別端末・未ログイン）。
    const other = new TestClient();
    const history = await other.get<{ items: Array<{ previousBody: string; editedAt: number }> }>(
      `/v1/posts/${reply.post.id}/history`,
    );
    expect(history.status).toBe(200);
    if (!history.body.ok) throw new Error(JSON.stringify(history.body));
    expect(history.body.data.items).toHaveLength(1);
    expect(history.body.data.items[0]!.previousBody).toBe("2 の本文です");
  });

  it("他人は編集・削除が 403", async () => {
    const { thread } = await setupWorld();
    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "私のレス");

    const other = new TestClient();
    const edit = await other.patch(`/v1/posts/${reply.post.id}`, { body: "乗っ取り" });
    expect(edit.status).toBe(403);
    const del = await other.delete(`/v1/posts/${reply.post.id}`);
    expect(del.status).toBe(403);
  });

  it("本人削除は「投稿者により削除されました」になり、レス番号は残る", async () => {
    const { thread } = await setupWorld();
    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "消すレス");
    const other = await postReply(new TestClient(), thread.threadId, "後続のレス");

    const del = await anon.delete<{ selfDeleted: boolean }>(`/v1/posts/${reply.post.id}`);
    expect(del.status).toBe(200);
    if (!del.body.ok) throw new Error(JSON.stringify(del.body));
    expect(del.body.data.selfDeleted).toBe(true);

    // レス番号が消えない（アンカー互換）: other のレスは 3 のまま。
    const rows = await env.DB.prepare("SELECT num, self_deleted, body FROM posts WHERE thread_id = ? ORDER BY num").bind(thread.threadId).all<{ num: number; self_deleted: number; body: string }>();
    expect(rows.results.map((row) => row.num)).toEqual([1, 2, 3]);
    expect(rows.results[1]!.self_deleted).toBe(1);
    expect(rows.results[1]!.body).toBe("投稿者により削除されました");
    expect(rows.results[2]!.num).toBe(other.post.num);
  });

  it("板設定で不許可なら 403", async () => {
    const { board, thread } = await setupWorld({ settings: { allowPostEdit: false, allowPostDelete: false } });
    expect(board.board.settings["allowPostEdit"]).toBe(false);

    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "自分のレス");

    const edit = await anon.patch(`/v1/posts/${reply.post.id}`, { body: "編集したい" });
    expect(edit.status).toBe(403);
    const del = await anon.delete(`/v1/posts/${reply.post.id}`);
    expect(del.status).toBe(403);
  });

  it("時間制限の境界: 期限を過ぎたら 403", async () => {
    const { board, thread } = await setupWorld({ settings: { selfEditWindowMinutes: 1 } });
    expect(board.board.settings["selfEditWindowMinutes"]).toBe(1);

    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "自分のレス");

    // created_at を 61 秒前に巻き戻す（1 分の期限を過ぎた状態を作る）。
    await env.DB
      .prepare("UPDATE posts SET created_at = created_at - 61 WHERE id = ?")
      .bind(reply.post.id)
      .run();

    const edit = await anon.patch(`/v1/posts/${reply.post.id}`, { body: "編集したい" });
    expect(edit.status).toBe(403);
    const del = await anon.delete(`/v1/posts/${reply.post.id}`);
    expect(del.status).toBe(403);
  });

  it("編集でも投稿検査が効く（NG ワード・スレ停止）", async () => {
    const { owner, thread } = await setupWorld({ settings: { ngWords: ["禁止語"], ngWordAction: "reject" } });

    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "自分のレス");

    const ng = await anon.patch(`/v1/posts/${reply.post.id}`, { body: "これは禁止語入り" });
    expect(ng.status).toBe(400);

    // スレを close したら編集不可（板の管理人が close）。
    const closeResponse = await owner.client.patch(`/v1/threads/${thread.threadId}`, { status: "closed" });
    expect(closeResponse.status).toBe(200);
    const closed = await anon.patch(`/v1/posts/${reply.post.id}`, { body: "閉じたスレでの編集" });
    expect(closed.status).toBe(409);
  });

  it("アカウント一致でも本人編集できる（別端末からログイン）", async () => {
    const { thread } = await setupWorld();
    const account = await authedClient({ name: "post-author" });
    const reply = await postReply(account.client, thread.threadId, "アカウントで投稿");

    // 別端末（oc_did が違う）でも同じアカウントなら編集できる。
    const otherDevice = new TestClient();
    otherDevice.setCookie("oc_sess", account.account.token);
    const edited = await otherDevice.patch<{ post: { mine: boolean } }>(`/v1/posts/${reply.post.id}`, {
      body: "別端末から編集",
    });
    expect(edited.status).toBe(200);
    if (!edited.body.ok) throw new Error(JSON.stringify(edited.body));
    expect(edited.body.data.post.mine).toBe(true);
  });
});

describe("スレの本人編集・本人削除", () => {
  it("匿名のスレ主がタイトルと本文を編集できる（ログイン不要）", async () => {
    const anon = new TestClient();
    const owner = await authedClient({ name: "board-admin2" });
    const board2 = await createBoard(owner.client, { settings: { turnstile: "off" } });
    const anonThread = await createThread(anon, board2.board.slug, {
      title: "匿名スレ主のスレ",
      body: "本文",
    });

    const patched = await anon.patch<{ thread: { title: string } }>(`/v1/threads/${anonThread.threadId}`, {
      title: "編集後のタイトル",
      body: "編集後の本文",
    });
    expect(patched.status).toBe(200);
    if (!patched.body.ok) throw new Error(JSON.stringify(patched.body));
    expect(patched.body.data.thread.title).toBe("編集後のタイトル");

    // 他人のスレは 403。
    const other = new TestClient();
    const foreign = await other.patch(`/v1/threads/${anonThread.threadId}`, { title: "乗っ取り", body: "乗っ取り" });
    expect(foreign.status).toBe(403);
  });

  it("他人のレスがあるスレは本人削除 403、>>1 のみなら削除できる", async () => {
    const owner = await authedClient({ name: "board-admin3" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off" } });
    const anon = new TestClient();
    const thread = await createThread(anon, board.board.slug, { title: "消す予定のスレ", body: "本文" });

    // 他人のレスが 1 件でもあるなら本人削除は不可。
    await postReply(new TestClient(), thread.threadId, "他人のレス");
    const denied = await anon.delete(`/v1/threads/${thread.threadId}`);
    expect(denied.status).toBe(403);

    // >>1 のみのスレ（別スレ）は削除できる。
    const solo = await createThread(anon, board.board.slug, { title: ">>1 のみのスレ", body: "本文" });
    const del = await anon.delete<{ selfDeleted: boolean }>(`/v1/threads/${solo.threadId}`);
    expect(del.status).toBe(200);
    if (!del.body.ok) throw new Error(JSON.stringify(del.body));
    expect(del.body.data.selfDeleted).toBe(true);
  });
});

describe("引用スレ", () => {
  it("引用して新スレを立てると quoteSource カードと引用一覧が取れる", async () => {
    const owner = await authedClient({ name: "board-admin4" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off" } });
    const source = await createThread(owner.client, board.board.slug, { title: "引用元スレ", body: "元の本文" });

    const anon = new TestClient();
    const created = await anon.post<{ threadId: number; quoteThreadId: number | null }>(
      `/v1/boards/${board.board.slug}/threads`,
      { title: "引用して立てたスレ", body: "新しいスレ", quoteThreadId: source.threadId },
    );
    expect(created.status).toBe(201);
    if (!created.body.ok) throw new Error(JSON.stringify(created.body));
    expect(created.body.data.quoteThreadId).toBe(source.threadId);

    // 新スレの GET に quoteSource カードが付く。
    const detail = await anon.get<{ quoteSource: { threadId: number; title: string; unavailable: boolean } | null }>(
      `/v1/threads/${created.body.data.threadId}`,
    );
    expect(detail.status).toBe(200);
    if (!detail.body.ok) throw new Error(JSON.stringify(detail.body));
    expect(detail.body.data.quoteSource?.threadId).toBe(source.threadId);
    expect(detail.body.data.quoteSource?.title).toBe("引用元スレ");
    expect(detail.body.data.quoteSource?.unavailable).toBe(false);

    // 元スレの引用一覧に新スレが載る。
    const quotes = await anon.get<{ items: Array<{ id: number; title: string }>; count: number }>(
      `/v1/threads/${source.threadId}/quotes`,
    );
    expect(quotes.status).toBe(200);
    if (!quotes.body.ok) throw new Error(JSON.stringify(quotes.body));
    expect(quotes.body.data.count).toBe(1);
    expect(quotes.body.data.items[0]!.id).toBe(created.body.data.threadId);
  });

  it("板が引用スレを不許可なら 403", async () => {
    const owner = await authedClient({ name: "board-admin5" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", allowQuoteThread: false } });
    const source = await createThread(owner.client, board.board.slug, { title: "元", body: "本文" });

    const anon = new TestClient();
    const created = await anon.post(`/v1/boards/${board.board.slug}/threads`, {
      title: "引用スレ",
      body: "本文",
      quoteThreadId: source.threadId,
    });
    expect(created.status).toBe(403);
  });

  it("削除済みの元スレを引用すると「削除されたスレ」カードになる", async () => {
    const owner = await authedClient({ name: "board-admin6" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off" } });
    const source = await createThread(owner.client, board.board.slug, { title: "消えるスレ", body: "本文" });

    await owner.client.delete(`/v1/threads/${source.threadId}`);

    const anon = new TestClient();
    const created = await anon.post<{ threadId: number }>(`/v1/boards/${board.board.slug}/threads`, {
      title: "削除済みを引用",
      body: "本文",
      quoteThreadId: source.threadId,
    });
    expect(created.status).toBe(201);

    const detail = await anon.get<{ quoteSource: { title: string; unavailable: boolean } | null }>(
      `/v1/threads/${(created.body.ok ? created.body.data.threadId : 0)}`,
    );
    expect(detail.status).toBe(200);
    if (!detail.body.ok) throw new Error(JSON.stringify(detail.body));
    expect(detail.body.data.quoteSource?.title).toBe("削除されたスレ");
    expect(detail.body.data.quoteSource?.unavailable).toBe(true);
  });
});

describe("第1回レビュー修正", () => {
  it("M1: 本人削除したレスの履歴は他人に 404、板スタッフには見える", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "削除するレス");
    await anon.patch(`/v1/posts/${reply.post.id}`, { body: "編集後（履歴に残る旧本文）" });
    await anon.delete(`/v1/posts/${reply.post.id}`);

    // 他人（未ログイン）には 404。
    const other = new TestClient();
    const history = await other.get(`/v1/posts/${reply.post.id}/history`);
    expect(history.status).toBe(404);

    // 板スタッフ（板管理人）には履歴が返る。
    const staffHistory = await owner.client.get<{ items: unknown[] }>(`/v1/posts/${reply.post.id}/history`);
    expect(staffHistory.status).toBe(200);
  });

  it("M1: スタッフ削除・非表示でも履歴は 404（未ログイン）", async () => {
    const { owner, thread } = await setupWorld();
    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "消されるレス 1");
    await anon.patch(`/v1/posts/${reply.post.id}`, { body: "履歴用の編集" });
    const reply2 = await postReply(anon, thread.threadId, "隠されるレス 2");
    await anon.patch(`/v1/posts/${reply2.post.id}`, { body: "履歴用の編集 2" });
    await owner.client.delete(`/v1/posts/${reply.post.id}`);
    await owner.client.post(`/v1/posts/${reply2.post.id}/hide`);

    const other = new TestClient();
    const h1 = await other.get(`/v1/posts/${reply.post.id}/history`);
    expect(h1.status).toBe(404);
    const h2 = await other.get(`/v1/posts/${reply2.post.id}/history`);
    expect(h2.status).toBe(404);
  });

  it("M3: 短時間の連続編集が postEdit 窓で 429 になる", async () => {
    const { thread } = await setupWorld();
    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "連続編集の対象");

    // postEdit は 30 秒 5 回。6 回目で 429 を期待するが、テストの並列性を考え
    // 「1 回でも 429 になるか」までを検証する（窓の上限は shared 定数に従う）。
    let saw429 = false;
    for (let i = 0; i < 6; i += 1) {
      const response = await anon.patch(`/v1/posts/${reply.post.id}`, { body: `連続編集 ${i + 1}` });
      if (response.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it("m1: 引用元の板が削除済みならタイトルも出さない", async () => {
    const ownerA = await authedClient({ name: "m1-admin" });
    const boardA = await createBoard(ownerA.client, { settings: { turnstile: "off" } });
    const source = await createThread(ownerA.client, boardA.board.slug, { title: "非公開板のスレ", body: "本文" });

    const ownerB = await authedClient({ name: "m1-admin-b" });
    const boardB = await createBoard(ownerB.client, { settings: { turnstile: "off" } });
    const quoted = await ownerB.client.post<{ threadId: number }>(`/v1/boards/${boardB.board.slug}/threads`, {
      title: "引用スレ",
      body: "本文",
      quoteThreadId: source.threadId,
    });
    expect(quoted.status).toBe(201);

    // 引用元の板を削除。
    await ownerA.client.delete(`/v1/boards/${boardA.board.slug}?confirm=1`);

    const detail = await ownerB.client.get<{ quoteSource: { title: string; unavailable: boolean } | null }>(
      `/v1/threads/${quoted.body.ok ? quoted.body.data.threadId : 0}`,
    );
    expect(detail.status).toBe(200);
    if (!detail.body.ok) throw new Error(JSON.stringify(detail.body));
    expect(detail.body.data.quoteSource?.title).toBe("削除されたスレ");
    expect(detail.body.data.quoteSource?.unavailable).toBe(true);
  });

  it("m2: スレ主が板スタッフでもある場合、他人レスがあっても自分のスレを削除できる", async () => {
    const owner = await authedClient({ name: "m2-admin" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off" } });
    const thread = await createThread(owner.client, board.board.slug, { title: "板管理者のスレ", body: "本文" });
    // 他人のレスを 1 件（通常は本人削除 403 の条件）。
    await postReply(new TestClient(), thread.threadId, "他人のレス");

    const del = await owner.client.delete<{ deleted: boolean; selfDeleted?: boolean }>(`/v1/threads/${thread.threadId}`);
    expect(del.status).toBe(200);
    if (!del.body.ok) throw new Error(JSON.stringify(del.body));
    expect(del.body.data.deleted).toBe(true);
  });
});


describe("第2回レビュー修正", () => {
  it("R74-01: スレ本人削除後の履歴は 404（板スタッフには見える）", async () => {
    const owner = await authedClient({ name: "r74-admin" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const anon = new TestClient();
    // 匿名スレ主がスレを立てて >>1 を編集 → スレ本人削除。
    const thread = await createThread(anon, board.board.slug, { title: "消すスレ", body: "本文" });
    await anon.patch(`/v1/threads/${thread.threadId}`, {
      title: "消すスレ",
      body: "編集後の本文（履歴に残る）",
      turnstileToken: "1x00000000000000000000AA",
    });
    const firstPost = await env.DB
      .prepare("SELECT id FROM posts WHERE thread_id = ? AND num = 1")
      .bind(thread.threadId)
      .first<{ id: number }>();

    await anon.delete(`/v1/threads/${thread.threadId}`);

    // 他人（未ログイン）の履歴は 404（スレ削除後）。
    const other = new TestClient();
    const history = await other.get(`/v1/posts/${firstPost!.id}/history`);
    expect(history.status).toBe(404);
    // 板スタッフには見える。
    const staffHistory = await owner.client.get<{ items: unknown[] }>(`/v1/posts/${firstPost!.id}/history`);
    expect(staffHistory.status).toBe(200);
  });

  it("R74-01: 板削除後の履歴も 404", async () => {
    const ownerA = await authedClient({ name: "r74-admin-a" });
    const boardA = await createBoard(ownerA.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const anon = new TestClient();
    const thread = await createThread(anon, boardA.board.slug, { title: "板ごと消えるスレ", body: "本文" });
    const reply = await postReply(anon, thread.threadId, "レス本文");
    await anon.patch(`/v1/posts/${reply.post.id}`, { body: "編集後（履歴に残る）" });

    await ownerA.client.delete(`/v1/boards/${boardA.board.slug}?confirm=1`);

    const other = new TestClient();
    const history = await other.get(`/v1/posts/${reply.post.id}/history`);
    expect(history.status).toBe(404);
  });

  it("R74-02: cooldown 中の編集は 429（レス・スレ両方）", async () => {
    const owner = await authedClient({ name: "r74-cooldown" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 3600 } });
    const anon = new TestClient();
    // スレ立て（>>1 の投稿）直後 = cooldown 内。レスの投稿は別端末に任せる。
    const thread = await createThread(anon, board.board.slug, { title: "cooldown 板のスレ", body: "本文" });
    const other = new TestClient();
    const reply = await postReply(other, thread.threadId, "他人のレス");

    // 投稿直後（cooldown 内）の本人（>>1 投稿者）のスレ編集は 429。
    const editThread = await anon.patch(`/v1/threads/${thread.threadId}`, {
      title: "cooldown 中のスレタイ",
      body: "cooldown 中の本文",
    });
    expect(editThread.status).toBe(429);

    // レス側も同様: other の投稿直後の編集は 429。
    const editPost = await other.patch(`/v1/posts/${reply.post.id}`, { body: "cooldown 中の編集" });
    expect(editPost.status).toBe(429);
  });

  it("R74-02: !aku された端末の編集は 403", async () => {
    const owner = await authedClient({ name: "r74-aku" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    // スレ主（anon）と、アク禁される第三者（victim）を分ける。
    const anon = new TestClient();
    const thread = await createThread(anon, board.board.slug, { title: "aku のスレ", body: "本文" });
    const victim = new TestClient();
    const reply = await postReply(victim, thread.threadId, "aku される前のレス");

    // スレ主が victim を !aku でアク禁（>>2 は victim のレス）。
    const aku = await postReply(anon, thread.threadId, "!aku >>2");
    expect(aku.post.num).toBe(3);

    // アク禁後のレス投稿は 403、編集も 403。
    const posted = await victim.post(`/v1/threads/${thread.threadId}/posts`, { body: "アク禁中の投稿" });
    expect(posted.status).toBe(403);
    const edited = await victim.patch(`/v1/posts/${reply.post.id}`, { body: "アク禁中の編集" });
    expect(edited.status).toBe(403);
  });

  it("R74-03: NG 拒否で確認済み（pass）が取り消される", async () => {
    const owner = await authedClient({ name: "r74-ng" });
    const board = await createBoard(owner.client, {
      settings: { turnstile: "anonymous", cooldownSeconds: 0, ngWords: ["禁止語"], ngWordAction: "reject" },
    });
    const anon = new TestClient();
    const thread = await createThread(owner.client, board.board.slug, { title: "NG のスレ", body: "本文" });
    // 匿名がトークン付きで投稿 → 確認済み（pass）が付く。
    const reply = await postReply(anon, thread.threadId, "匿名の投稿", { turnstileToken: "1x00000000000000000000AA" });

    // device_hash は Cookie から計算されるため直接は引けない。板単位で存在を確認。
    const passCount = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM turnstile_passes WHERE board_id = (SELECT id FROM boards WHERE slug = ?)")
      .bind(board.board.slug)
      .first<{ n: number }>();
    expect(passCount?.n ?? 0).toBeGreaterThan(0);

    // NG 拒否（400）で確認済みが取り消される。
    const ng = await anon.patch(`/v1/posts/${reply.post.id}`, { body: "禁止語入り" });
    expect(ng.status).toBe(400);
    const passAfter = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM turnstile_passes WHERE board_id = (SELECT id FROM boards WHERE slug = ?)")
      .bind(board.board.slug)
      .first<{ n: number }>();
    expect(passAfter?.n ?? 0).toBe(0);
  });
});
