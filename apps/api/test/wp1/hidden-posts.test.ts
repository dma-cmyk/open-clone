// 管理画面「非表示のレス」の受入（一覧 API・監査ログ・再表示）。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  TestClient,
  authedClient,
  createBoard,
  createThread,
  postReply,
  resetWorld,
} from "./helpers";

interface HiddenPostItem {
  postId: number;
  boardId: number;
  boardSlug: string;
  boardName: string;
  boardStatus: "active" | "deleted";
  threadId: number;
  threadTitle: string;
  num: number;
  name: string;
  excerpt: string;
  createdAt: number;
  hiddenAt: number | null;
  hiddenByName: string | null;
}

async function setupBoard() {
  const owner = await authedClient({ role: "special_admin", name: "site-owner" });
  const board = await createBoard(owner.client, {
    name: "非表示テスト板",
    category: "E2E",
    settings: { turnstile: "off", cooldownSeconds: 0 },
  });
  const thread = await createThread(owner.client, board.board.slug, {
    title: "非表示の受入スレ",
    body: "スレ本文",
  });
  return { owner, board, thread };
}

async function addStaff(
  owner: TestClient,
  slug: string,
  action: { accountName: string; level: "admin" | "deputy" | "moderator" },
) {
  const response = await owner.post(`/v1/boards/${slug}/staff`, action);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

beforeEach(async () => {
  await resetWorld();
});

describe("非表示レスの一覧 API", () => {
  it("権限: 未ログイン 401・一般 403・他の板のスタッフ 403・その板のスタッフ 200・管理者 200", async () => {
    const { owner, board, thread } = await setupBoard();
    const anon = new TestClient();
    const reply = await postReply(anon, thread.threadId, "非表示にするレス");
    const hidden = await owner.client.post(`/v1/posts/${reply.post.id}/hide`);
    expect(hidden.status).toBe(200);

    // 未ログイン
    expect((await anon.get(`/v1/boards/${board.board.slug}/hidden-posts`)).status).toBe(401);
    expect((await anon.get("/v1/admin/hidden-posts")).status).toBe(401);

    // 一般利用者（板スタッフでない）
    const general = await authedClient({ name: "general-user" });
    expect((await general.client.get(`/v1/boards/${board.board.slug}/hidden-posts`)).status).toBe(403);
    expect((await general.client.get("/v1/admin/hidden-posts")).status).toBe(403);

    // 他の板のスタッフ
    const other = await createBoard(owner.client, { name: "別の板" });
    await addStaff(owner.client, other.board.slug, { accountName: general.account.name, level: "moderator" });
    expect((await general.client.get(`/v1/boards/${board.board.slug}/hidden-posts`)).status).toBe(403);
    expect((await general.client.get(`/v1/boards/${other.board.slug}/hidden-posts`)).status).toBe(200);
    // サイト管理画面は板スタッフでは開けない
    expect((await general.client.get("/v1/admin/hidden-posts")).status).toBe(403);

    // その板のスタッフ
    const moderator = await authedClient({ name: "board-moderator" });
    await addStaff(owner.client, board.board.slug, { accountName: moderator.account.name, level: "moderator" });
    expect((await moderator.client.get(`/v1/boards/${board.board.slug}/hidden-posts`)).status).toBe(200);

    // サイト管理者
    expect((await owner.client.get(`/v1/boards/${board.board.slug}/hidden-posts`)).status).toBe(200);
    expect((await owner.client.get("/v1/admin/hidden-posts")).status).toBe(200);

    // 存在しない板
    expect((await owner.client.get("/v1/boards/no-such-board/hidden-posts")).status).toBe(404);
  });

  it("一覧は hidden=1 かつ deleted=0 だけを返し、した人・日時は監査ログから付く", async () => {
    const { owner, board, thread } = await setupBoard();
    const anon = new TestClient();
    const kept = await postReply(anon, thread.threadId, "あとで再表示するレス");
    const removed = await postReply(anon, thread.threadId, "削除するレス");
    const visible = await postReply(anon, thread.threadId, "非表示にしないレス");

    const moderator = await authedClient({ name: "hide-moderator" });
    await addStaff(owner.client, board.board.slug, { accountName: moderator.account.name, level: "moderator" });
    expect((await moderator.client.post(`/v1/posts/${kept.post.id}/hide`)).status).toBe(200);
    expect((await moderator.client.post(`/v1/posts/${removed.post.id}/hide`)).status).toBe(200);
    expect((await owner.client.delete(`/v1/posts/${removed.post.id}`)).status).toBe(200);

    const list = await moderator.client.get<{ items: HiddenPostItem[]; nextCursor: string | null }>(
      `/v1/boards/${board.board.slug}/hidden-posts`,
    );
    expect(list.status).toBe(200);
    if (!list.body.ok) throw new Error("hidden list failed");
    expect(list.body.data.items.map((item) => item.postId)).toEqual([kept.post.id]);
    const item = list.body.data.items[0]!;
    expect(item.num).toBe(kept.post.num);
    expect(item.threadId).toBe(thread.threadId);
    expect(item.threadTitle).toBe("非表示の受入スレ");
    expect(item.boardSlug).toBe(board.board.slug);
    expect(item.excerpt).toBe("あとで再表示するレス");
    expect(item.hiddenByName).toBe("hide-moderator");
    expect(item.hiddenAt).not.toBeNull();
    // 返してはいけない列（IP・端末・アカウント ID）が無い
    expect(Object.keys(item)).not.toContain("ipHash");
    expect(Object.keys(item)).not.toContain("deviceHash");
    expect(Object.keys(item)).not.toContain("accountId");
    expect(list.body.data.items.some((entry) => entry.postId === visible.post.id)).toBe(false);

    // 監査ログに post.hide が残る
    const audit = await env.DB.prepare(
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'post.hide' AND target = ?",
    )
      .bind(String(kept.post.id))
      .all<{ actor_type: string; actor_id: string; detail: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]!.actor_type).toBe("board_staff");
    expect(audit.results[0]!.actor_id).toBe(moderator.account.id);
    expect(JSON.parse(audit.results[0]!.detail)).toMatchObject({ postId: kept.post.id, source: "post_menu" });

    // 再表示すると一覧から消え、一般の人にも見える
    expect((await moderator.client.post(`/v1/posts/${kept.post.id}/restore`)).status).toBe(200);
    const after = await moderator.client.get<{ items: HiddenPostItem[] }>(`/v1/boards/${board.board.slug}/hidden-posts`);
    if (!after.body.ok) throw new Error("hidden list after restore failed");
    expect(after.body.data.items).toHaveLength(0);
    const threadView = await anon.get<{ posts: Array<{ id: number }> }>(`/v1/threads/${thread.threadId}?r=1-10`);
    if (!threadView.body.ok) throw new Error("thread failed");
    expect(threadView.body.data.posts.some((post) => post.id === kept.post.id)).toBe(true);

    const restoreAudit = await env.DB.prepare(
      "SELECT actor_id FROM audit_log WHERE action = 'post.restore' AND target = ?",
    )
      .bind(String(kept.post.id))
      .all<{ actor_id: string }>();
    expect(restoreAudit.results).toHaveLength(1);
    expect(restoreAudit.results[0]!.actor_id).toBe(moderator.account.id);
  });

  it("サイト管理画面は全板を返し、board で絞り込める・カーソルでページ送りできる", async () => {
    const { owner, board, thread } = await setupBoard();
    const second = await createBoard(owner.client, {
      name: "二つ目の板",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    });
    const secondThread = await createThread(owner.client, second.board.slug, { title: "二つ目のスレ", body: "本文" });

    const anon = new TestClient();
    const first = await postReply(anon, thread.threadId, "板1のレス1");
    const secondPost = await postReply(anon, thread.threadId, "板1のレス2");
    const other = await postReply(anon, secondThread.threadId, "板2のレス");
    for (const post of [first, secondPost, other]) {
      expect((await owner.client.post(`/v1/posts/${post.post.id}/hide`)).status).toBe(200);
    }

    const all = await owner.client.get<{ items: HiddenPostItem[]; nextCursor: string | null }>(
      "/v1/admin/hidden-posts?limit=2",
    );
    expect(all.status).toBe(200);
    if (!all.body.ok) throw new Error("admin hidden list failed");
    expect(all.body.data.items.map((item) => item.postId)).toEqual([other.post.id, secondPost.post.id]);
    expect(all.body.data.nextCursor).not.toBeNull();

    const next = await owner.client.get<{ items: HiddenPostItem[] }>(
      `/v1/admin/hidden-posts?limit=2&cursor=${encodeURIComponent(all.body.data.nextCursor!)}`,
    );
    if (!next.body.ok) throw new Error("admin hidden list page 2 failed");
    expect(next.body.data.items.map((item) => item.postId)).toEqual([first.post.id]);

    const filtered = await owner.client.get<{ items: HiddenPostItem[] }>(
      `/v1/admin/hidden-posts?board=${board.board.slug}`,
    );
    if (!filtered.body.ok) throw new Error("filtered hidden list failed");
    expect(filtered.body.data.items.map((item) => item.postId).sort()).toEqual([first.post.id, secondPost.post.id].sort());

    // 削除済みの板のレスもサイト管理者には見える
    expect((await owner.client.delete(`/v1/boards/${second.board.slug}?confirm=1`)).status).toBe(200);
    const deletedBoard = await owner.client.get<{ items: HiddenPostItem[] }>(
      `/v1/admin/hidden-posts?board=${second.board.slug}`,
    );
    if (!deletedBoard.body.ok) throw new Error("deleted board list failed");
    expect(deletedBoard.body.data.items.map((item) => item.postId)).toEqual([other.post.id]);
    expect(deletedBoard.body.data.items[0]!.boardStatus).toBe("deleted");
  });

  it("通報の処理から非表示にすると理由つきで監査ログに残り、一覧にも出る", async () => {
    const { owner, board, thread } = await setupBoard();
    const anon = new TestClient();
    const reported = await postReply(anon, thread.threadId, "通報から非表示にするレス");

    const created = await anon.post<{ id: string }>("/v1/reports", {
      boardSlug: board.board.slug,
      threadId: thread.threadId,
      posts: String(reported.post.num),
      reason: "spam",
      comment: "宣伝です",
      turnstileToken: "dummy-token",
    });
    expect(created.status).toBe(201);
    if (!created.body.ok) throw new Error("report create failed");
    const handled = await owner.client.post(`/v1/reports/${created.body.data.id}/handle`, {
      action: "hide",
      note: "通報により非表示",
    });
    expect(handled.status).toBe(200);

    const audit = await env.DB.prepare(
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'post.hide' AND target = ?",
    )
      .bind(String(reported.post.id))
      .first<{ actor_type: string; actor_id: string; detail: string }>();
    expect(audit?.actor_type).toBe("special_admin");
    expect(audit?.actor_id).toBe(owner.account.id);
    const detail = JSON.parse(audit!.detail) as Record<string, unknown>;
    expect(detail).toMatchObject({
      postId: reported.post.id,
      source: "report",
      reason: "spam",
      reasonLabel: "宣伝・スパム",
    });

    const list = await owner.client.get<{ items: HiddenPostItem[] }>("/v1/admin/hidden-posts");
    if (!list.body.ok) throw new Error("admin hidden list failed");
    const item = list.body.data.items.find((entry) => entry.postId === reported.post.id);
    expect(item?.hiddenByName).toBe("site-owner");
  });

  // レビュー第1回 M1: 本人が削除したレスは「再表示」できない（本文も残らない）ので一覧に出さない。
  it("本人が削除したレスは一覧に出ない", async () => {
    const { owner, board, thread } = await setupBoard();
    const anon = new TestClient();
    const post = await postReply(anon, thread.threadId, "本人が削除するレス");

    expect((await owner.client.post(`/v1/posts/${post.post.id}/hide`)).status).toBe(200);
    // 投稿した端末（oc_did）のまま本人削除する。deleted ではなく self_deleted になる。
    expect((await anon.delete(`/v1/posts/${post.post.id}`)).status).toBe(200);
    const row = await env.DB.prepare("SELECT hidden, deleted, self_deleted FROM posts WHERE id = ?")
      .bind(post.post.id)
      .first<{ hidden: number; deleted: number; self_deleted: number }>();
    expect(row).toMatchObject({ hidden: 1, deleted: 0, self_deleted: 1 });

    const list = await owner.client.get<{ items: HiddenPostItem[] }>(`/v1/boards/${board.board.slug}/hidden-posts`);
    if (!list.body.ok) throw new Error("hidden list failed");
    expect(list.body.data.items.some((entry) => entry.postId === post.post.id)).toBe(false);
  });

  // レビュー第1回 M2: 削除済みスレは削除済みの板と同じ 409 で凍結する。
  // 削除済みスレは GET /v1/threads/:id もスタッフに 409 を返すため、一覧にも出さない（K2）。
  it("削除済みスレのレスは非表示・再表示とも 409 で、一覧にも出ない", async () => {
    const { owner, board, thread } = await setupBoard();
    const anon = new TestClient();
    const post = await postReply(anon, thread.threadId, "削除スレに残るレス");

    expect((await owner.client.post(`/v1/posts/${post.post.id}/hide`)).status).toBe(200);
    expect((await owner.client.delete(`/v1/threads/${thread.threadId}`)).status).toBe(200);

    expect((await owner.client.post(`/v1/posts/${post.post.id}/restore`)).status).toBe(409);
    expect((await owner.client.post(`/v1/posts/${post.post.id}/hide`)).status).toBe(409);

    const list = await owner.client.get<{ items: HiddenPostItem[] }>(`/v1/boards/${board.board.slug}/hidden-posts`);
    if (!list.body.ok) throw new Error("hidden list failed");
    expect(list.body.data.items.some((entry) => entry.postId === post.post.id)).toBe(false);
  });

  // レビュー第1回 M5: 「非表示 → 再表示 → 再び非表示」で、した人・日時が最新の hide になる。
  it("再表示して再び非表示にすると、した人と日時は最新の操作になる", async () => {
    const { owner, board, thread } = await setupBoard();
    const anon = new TestClient();
    const post = await postReply(anon, thread.threadId, "何度も非表示にするレス");

    const first = await authedClient({ name: "hide-first" });
    const second = await authedClient({ name: "hide-second" });
    await addStaff(owner.client, board.board.slug, { accountName: first.account.name, level: "moderator" });
    await addStaff(owner.client, board.board.slug, { accountName: second.account.name, level: "moderator" });

    expect((await first.client.post(`/v1/posts/${post.post.id}/hide`)).status).toBe(200);
    const firstList = await first.client.get<{ items: HiddenPostItem[] }>(
      `/v1/boards/${board.board.slug}/hidden-posts`,
    );
    if (!firstList.body.ok) throw new Error("hidden list failed");
    const firstItem = firstList.body.data.items.find((entry) => entry.postId === post.post.id);
    expect(firstItem?.hiddenByName).toBe("hide-first");
    expect(firstItem?.hiddenAt).not.toBeNull();

    expect((await second.client.post(`/v1/posts/${post.post.id}/restore`)).status).toBe(200);
    expect((await second.client.post(`/v1/posts/${post.post.id}/hide`)).status).toBe(200);

    const latest = await first.client.get<{ items: HiddenPostItem[] }>(
      `/v1/boards/${board.board.slug}/hidden-posts`,
    );
    if (!latest.body.ok) throw new Error("hidden list failed");
    const latestItem = latest.body.data.items.find((entry) => entry.postId === post.post.id);
    expect(latestItem?.hiddenByName).toBe("hide-second");
    expect(latestItem?.hiddenAt).not.toBeNull();
    expect(latestItem!.hiddenAt!).toBeGreaterThanOrEqual(firstItem!.hiddenAt!);
  });
});