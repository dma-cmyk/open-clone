// F3・F4・F5・F6（API）・F10 の受け入れ条件テスト。
// 先に失敗を観測してから本体を修正し、その後すべて通ることを確認する。

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TestClient, authedClient, createBoard, createThread, postReply, resetWorld } from "./wp1/helpers";
import { bootstrapOwner, call, createSpecialAdmin, loginUser, stepUp, totpCode } from "./wp6-helpers";
import { api, createAgent } from "./ai-helpers";

function clientFromCookie(cookie: string): TestClient {
  const client = new TestClient();
  const match = /oc_sess=([^;]+)/.exec(cookie);
  if (!match) throw new Error(`missing oc_sess cookie: ${cookie}`);
  client.setCookie("oc_sess", match[1]!);
  return client;
}

async function resetAll() {
  await resetWorld();
  for (const table of [
    "ai_audit",
    "ai_queue",
    "ai_agents",
    "ai_policies",
    "ai_rate_counters",
    "plugin_net_log",
    "plugin_reviews",
    "plugin_versions",
    "plugin_installs",
    "plugins",
    "special_admin_state",
    "account_totp",
    "recovery_codes",
    "session_stepup",
    "invites",
    "suspensions",
    "auth_attempts",
    "audit_log",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

describe("F3/F4/F5/F6/F10 権限と監査ログ", () => {
  beforeEach(async () => {
    await resetAll();
  });

  it("受け入れ① (F3): 停止した特別管理人は再ログイン後も全権限で 403・担当板スタッフは維持・復旧後に再び操作できる", async () => {
    const owner = await bootstrapOwner("owner-f3@example.com");
    const ownerClient = clientFromCookie(owner.cookie);
    const sa = await createSpecialAdmin(owner, "sa-f3@example.com");
    const saBeforeStop = clientFromCookie(sa.cookie);

    const boardOwner = await authedClient({ name: "board-owner-f3" });
    const dev = await authedClient({ name: "plugin-dev-f3" });

    // 他人の板（通常板）とスレ・レス・通報・既存のサイト全体 BAN を用意
    const otherBoard = await createBoard(boardOwner.client, {
      settings: { turnstile: "off", cooldownSeconds: 0 },
    });
    const threadPosts = await createThread(boardOwner.client, otherBoard.board.slug, {
      title: "F3 対象スレ1",
      body: ">>1 本文",
    });
    const threadForDelete = await createThread(boardOwner.client, otherBoard.board.slug, {
      title: "F3 削除対象スレ",
      body: ">>1 本文",
    });
    const replyDirect = await postReply(boardOwner.client, threadPosts.threadId, "非表示/削除テスト用レス");
    const replyReport = await postReply(boardOwner.client, threadPosts.threadId, "通報処理テスト用レス");

    const reporter = new TestClient();
    const reportRes = await reporter.post<{ id: string }>("/v1/reports", {
      boardSlug: otherBoard.board.slug,
      threadId: threadPosts.threadId,
      posts: String(replyReport.post.num),
      reason: "spam",
      comment: "F3 通報",
      turnstileToken: "dummy-token",
    });
    expect(reportRes.status).toBe(201);
    if (!reportRes.body.ok) throw new Error("report failed");
    const reportId = reportRes.body.data.id;

    // 事前作成したサイト全体 BAN（停止中の解除テスト用）
    const preSiteBan = await ownerClient.post<{ id: string }>(`/v1/boards/${otherBoard.board.slug}/bans`, {
      identity: "deadbeef00001111",
      kind: "device",
      reason: "事前サイトBAN",
      durationHours: 24,
      site: true,
    });
    expect(preSiteBan.status).toBe(201);
    if (!preSiteBan.body.ok) throw new Error("preSiteBan failed");
    const preSiteBanId = preSiteBan.body.data.id;

    // 自分が board_staff (moderator) に割り当てられている別板を用意（停止中も残るべき権限）
    const assignedBoard = await createBoard(boardOwner.client, {
      settings: { turnstile: "off", cooldownSeconds: 0 },
    });
    await env.DB.prepare(
      "INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, 'moderator', ?, ?)",
    )
      .bind(assignedBoard.board.id, sa.id, boardOwner.account.id, Math.floor(Date.now() / 1000))
      .run();
    const assignedThread = await createThread(boardOwner.client, assignedBoard.board.slug, {
      title: "F3 担当板スレ",
      body: ">>1",
    });
    const assignedReply = await postReply(boardOwner.client, assignedThread.threadId, "担当板の非表示対象");

    // 審査待ちプラグインを用意（サイト公開申請）
    const pluginCreate = await dev.client.post<{ id: string }>("/v1/plugins", {
      manifest: {
        name: "f3-review-plugin",
        version: "1.0.0",
        summary: "F3 test plugin",
        description: "desc",
        scope: ["personal", "board", "site"],
        permissions: ["ui:slot"],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: ["thread-post-inline"],
        hooks: [],
      },
      code: 'register({ slots: { "thread-post-inline": (c) => ({ html: c.post.body }) } });',
      visibility: "public",
    });
    expect(pluginCreate.status).toBe(201);
    if (!pluginCreate.body.ok) throw new Error("plugin create failed");
    const pluginId = pluginCreate.body.data.id;
    const pluginPub = await dev.client.post(`/v1/plugins/${pluginId}/publish`, {
      scopes: ["personal", "board", "site"],
      visibility: "public",
    });
    expect(pluginPub.status).toBe(200);

    // 停止前にサイト AI エージェントも 1 体作成（委譲者の停止無効化を検証）
    const saAgent = await createAgent(sa.cookie, {
      name: "f3-sa-site-agent",
      ownerType: "site",
      allowedBoards: "*",
      riskCap: "high",
    });
    expect(saAgent.id).toBeTruthy();

    // 停止前は操作可能であることをざっと確認
    expect((await saBeforeStop.get<{ canManage: boolean }>(`/v1/boards/${otherBoard.board.slug}`)).body).toMatchObject({
      ok: true,
      data: { canManage: true },
    });

    // 所有者が特別管理人を停止する
    await stepUp(owner.cookie, owner.secret);
    const stopped = await call<{ stopped: boolean }>("POST", `/v1/admin/special-admins/${sa.id}/stop`, {
      cookie: owner.cookie,
      body: { reason: "受入テスト停止" },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.data?.stopped).toBe(true);

    // 停止された特別管理人がログインし直す
    await env.DB.prepare("UPDATE account_totp SET last_used_step = NULL WHERE account_id = ?").bind(sa.id).run();
    const relogin = await loginUser(sa.email, sa.password, await totpCode(sa.secret), "10.30.0.1");
    expect(relogin.status).toBe(200);
    expect(relogin.sessionCookie).toBeTruthy();
    const saStopped = clientFromCookie(relogin.sessionCookie!);

    // 表示は「特別管理人（停止中）」のまま維持する
    const meRes = await saStopped.get<{ profile: { role: string } }>("/v1/accounts/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.ok && meRes.body.data.profile.role).toBe("special_admin");

    const sessRes = await saStopped.get<{ account: { role: string }; specialAdminStopped: boolean }>("/v1/auth/session");
    expect(sessRes.status).toBe(200);
    expect(sessRes.body.ok && sessRes.body.data.account.role).toBe("special_admin");
    expect(sessRes.body.ok && sessRes.body.data.specialAdminStopped).toBe(true);

    // 他人の板の板詳細も一般扱い（canManage: false, staffLevel: null）
    const otherBoardRes = await saStopped.get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${otherBoard.board.slug}`,
    );
    expect(otherBoardRes.status).toBe(200);
    expect(otherBoardRes.body.ok && otherBoardRes.body.data.canManage).toBe(false);
    expect(otherBoardRes.body.ok && otherBoardRes.body.data.staffLevel).toBeNull();

    // 停止中に全て 403 になるべき操作群
    expect((await saStopped.post(`/v1/posts/${replyDirect.post.id}/hide`)).status).toBe(403);
    expect((await saStopped.delete(`/v1/posts/${replyDirect.post.id}`)).status).toBe(403);
    expect((await saStopped.delete(`/v1/threads/${threadForDelete.threadId}`)).status).toBe(403);
    expect((await saStopped.post(`/v1/reports/${reportId}/handle`, { action: "hide", note: "stop" })).status).toBe(403);
    expect(
      (
        await saStopped.post(`/v1/boards/${otherBoard.board.slug}/bans`, {
          identity: "deadbeef99990000",
          kind: "device",
          reason: "stop site ban",
          durationHours: 24,
          site: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (await saStopped.delete(`/v1/boards/${otherBoard.board.slug}/bans/${preSiteBanId}`)).status,
    ).toBe(403);

    // プラグインレビュー / ネット監査ログ / AI 管理・委譲キーも 403
    expect((await saStopped.get("/v1/plugins/reviews?status=pending&scope=site")).status).toBe(403);
    expect(
      (
        await saStopped.post(`/v1/plugins/${pluginId}/review`, {
          decision: "approve",
          scope: "site",
          note: "stopped",
        })
      ).status,
    ).toBe(403);
    expect((await saStopped.get("/v1/plugin-net/log")).status).toBe(403);
    expect((await saStopped.get("/v1/ai/metrics")).status).toBe(403);
    expect(
      (
        await saStopped.post("/v1/ai/agents", {
          name: "blocked-agent",
          ownerType: "site",
          allowedBoards: "*",
          riskCap: "low",
        })
      ).status,
    ).toBe(403);
    const delegatedAct = await api(`/v1/ai/posts/${replyDirect.post.id}/hide`, {
      method: "POST",
      key: saAgent.apiKey,
      body: { reason: "delegator stopped" },
    });
    expect(delegatedAct.status).toBe(403);

    // 自身の board_staff 権限は維持される（担当板ではモデレーターとして非表示可能）
    const assignedDetail = await saStopped.get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${assignedBoard.board.slug}`,
    );
    expect(assignedDetail.status).toBe(200);
    expect(assignedDetail.body.ok && assignedDetail.body.data.canManage).toBe(false);
    expect(assignedDetail.body.ok && assignedDetail.body.data.staffLevel).toBe("moderator");
    expect((await saStopped.post(`/v1/posts/${assignedReply.post.id}/hide`)).status).toBe(200);

    // 復旧すると再びすべて操作できる
    await stepUp(owner.cookie, owner.secret);
    const restored = await call<{ restored: boolean }>("POST", `/v1/admin/special-admins/${sa.id}/restore`, {
      cookie: owner.cookie,
    });
    expect(restored.status).toBe(200);

    await env.DB.prepare("UPDATE account_totp SET last_used_step = NULL WHERE account_id = ?").bind(sa.id).run();
    const reloginRestored = await loginUser(sa.email, sa.password, await totpCode(sa.secret), "10.30.0.2");
    expect(reloginRestored.status).toBe(200);
    const saRestored = clientFromCookie(reloginRestored.sessionCookie!);

    const sessAfter = await saRestored.get<{ specialAdminStopped: boolean }>("/v1/auth/session");
    expect(sessAfter.status).toBe(200);
    expect(sessAfter.body.ok && sessAfter.body.data.specialAdminStopped).toBe(false);

    const restoredBoardDetail = await saRestored.get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${otherBoard.board.slug}`,
    );
    expect(restoredBoardDetail.status).toBe(200);
    expect(restoredBoardDetail.body.ok && restoredBoardDetail.body.data.canManage).toBe(true);
    expect(restoredBoardDetail.body.ok && restoredBoardDetail.body.data.staffLevel).toBe("admin");

    expect((await saRestored.post(`/v1/posts/${replyDirect.post.id}/hide`)).status).toBe(200);
    expect((await saRestored.delete(`/v1/posts/${replyDirect.post.id}`)).status).toBe(200);
    expect((await saRestored.post(`/v1/reports/${reportId}/handle`, { action: "delete", note: "restored" })).status).toBe(200);
    const createdSiteBan = await saRestored.post<{ id: string }>(`/v1/boards/${otherBoard.board.slug}/bans`, {
      identity: "deadbeef99990000",
      kind: "device",
      reason: "restored site ban",
      durationHours: 24,
      site: true,
    });
    expect(createdSiteBan.status).toBe(201);
    expect(
      (await saRestored.delete(`/v1/boards/${otherBoard.board.slug}/bans/${preSiteBanId}`)).status,
    ).toBe(200);
    expect((await saRestored.delete(`/v1/threads/${threadForDelete.threadId}`)).status).toBe(200);
    expect((await saRestored.get("/v1/plugins/reviews?status=pending&scope=site")).status).toBe(200);
    expect(
      (
        await saRestored.post(`/v1/plugins/${pluginId}/review`, {
          decision: "approve",
          scope: "site",
          note: "restored ok",
        })
      ).status,
    ).toBe(200);
    expect((await saRestored.get("/v1/plugin-net/log")).status).toBe(200);
    expect((await saRestored.get("/v1/ai/metrics")).status).toBe(200);
  });

  it("受け入れ② (F4): 板 A のモデレーターは板 B のアク禁を解除できず、自板の解除は監査ログに残る", async () => {
    const owner = await authedClient({ name: "f4-owner" });
    const mod = await authedClient({ name: "f4-mod" });

    const boardA = await createBoard(owner.client, { slug: "f4-board-a" });
    const boardB = await createBoard(owner.client, { slug: "f4-board-b" });

    await env.DB.prepare(
      "INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, 'moderator', ?, ?)",
    )
      .bind(boardA.board.id, mod.account.id, owner.account.id, Math.floor(Date.now() / 1000))
      .run();

    const banA = await owner.client.post<{ id: string }>(`/v1/boards/${boardA.board.slug}/bans`, {
      identity: "aaaaaaaa11111111",
      kind: "device",
      reason: "板A",
      durationHours: 24,
    });
    expect(banA.status).toBe(201);
    if (!banA.body.ok) throw new Error("banA failed");

    const banB = await owner.client.post<{ id: string }>(`/v1/boards/${boardB.board.slug}/bans`, {
      identity: "bbbbbbbb22222222",
      kind: "device",
      reason: "板B",
      durationHours: 24,
    });
    expect(banB.status).toBe(201);
    if (!banB.body.ok) throw new Error("banB failed");

    // 他板の BAN ID を自板 A 経由で指定しても解除できない（404）
    const crossLift = await mod.client.delete(`/v1/boards/${boardA.board.slug}/bans/${banB.body.data.id}`);
    expect(crossLift.status).toBe(404);

    // 板Bの BAN は残っている
    const banBStillThere = await env.DB.prepare("SELECT id FROM board_bans WHERE id = ?")
      .bind(banB.body.data.id)
      .first<{ id: string }>();
    expect(banBStillThere?.id).toBe(banB.body.data.id);

    // 自板 A の BAN 解除は 200 で、ban.lift が audit_log に残る
    const ownLift = await mod.client.delete(`/v1/boards/${boardA.board.slug}/bans/${banA.body.data.id}`);
    expect(ownLift.status).toBe(200);

    const audit = await env.DB.prepare(
      "SELECT actor_type, actor_id, target, detail FROM audit_log WHERE action = 'ban.lift' AND target = ?",
    )
      .bind("aaaaaaaa11111111")
      .first<{ actor_type: string; actor_id: string; target: string; detail: string }>();
    expect(audit).toBeTruthy();
    expect(audit?.actor_type).toBe("board_staff");
    expect(audit?.actor_id).toBe(mod.account.id);
    expect(JSON.parse(audit!.detail)).toMatchObject({
      banId: banA.body.data.id,
      boardId: boardA.board.id,
      kind: "device",
    });
  });

  it("受け入れ③ (F5): スタッフのレス削除（メニュー・通報）とスレ削除が監査ログに残り、本人削除は残らない", async () => {
    const owner = await authedClient({ name: "f5-owner" });
    const deputy = await authedClient({ name: "f5-deputy" });
    const poster = await authedClient({ name: "f5-poster" });

    const board = await createBoard(owner.client, {
      settings: { allowThreadDelete: true, selfEditWindowMinutes: 60, turnstile: "off", cooldownSeconds: 0 },
    });
    await env.DB.prepare(
      "INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, 'deputy', ?, ?)",
    )
      .bind(board.board.id, deputy.account.id, owner.account.id, Math.floor(Date.now() / 1000))
      .run();

    const t1 = await createThread(owner.client, board.board.slug, { title: "F5 スレ1", body: ">>1" });
    const menuPost = await postReply(poster.client, t1.threadId, "メニューから削除対象");
    const reportPost = await postReply(poster.client, t1.threadId, "通報から削除対象");
    const selfPost = await postReply(poster.client, t1.threadId, "本人削除対象");

    const tStaff = await createThread(poster.client, board.board.slug, { title: "スタッフ削除スレ", body: ">>1" });
    const tSelf = await createThread(poster.client, board.board.slug, { title: "本人削除スレ", body: ">>1" });

    // 通報作成
    const repRes = await new TestClient().post<{ id: string }>("/v1/reports", {
      boardSlug: board.board.slug,
      threadId: t1.threadId,
      posts: String(reportPost.post.num),
      reason: "abuse",
      comment: "F5",
      turnstileToken: "dummy-token",
    });
    expect(repRes.status).toBe(201);
    if (!repRes.body.ok) throw new Error("report failed");

    // 1. スタッフによるメニューからのレス削除 -> post.delete
    expect((await deputy.client.delete(`/v1/posts/${menuPost.post.id}`)).status).toBe(200);
    const menuAudit = await env.DB.prepare(
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'post.delete' AND target = ?",
    )
      .bind(String(menuPost.post.id))
      .first<{ actor_type: string; actor_id: string; detail: string }>();
    expect(menuAudit).toBeTruthy();
    expect(menuAudit?.actor_type).toBe("board_staff");
    expect(menuAudit?.actor_id).toBe(deputy.account.id);
    expect(JSON.parse(menuAudit!.detail)).toMatchObject({ postId: menuPost.post.id, source: "post_menu" });

    // 2. スタッフによる通報処理からのレス削除 -> post.delete
    expect(
      (await deputy.client.post(`/v1/reports/${repRes.body.data.id}/handle`, { action: "delete", note: "F5削除" }))
        .status,
    ).toBe(200);
    const reportAudit = await env.DB.prepare(
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'post.delete' AND target = ?",
    )
      .bind(String(reportPost.post.id))
      .first<{ actor_type: string; actor_id: string; detail: string }>();
    expect(reportAudit).toBeTruthy();
    expect(reportAudit?.actor_type).toBe("board_staff");
    expect(reportAudit?.actor_id).toBe(deputy.account.id);
    expect(JSON.parse(reportAudit!.detail)).toMatchObject({
      postId: reportPost.post.id,
      source: "report",
      reportId: repRes.body.data.id,
    });

    // 3. スタッフによるスレ削除 -> thread.delete
    expect((await deputy.client.delete(`/v1/threads/${tStaff.threadId}`)).status).toBe(200);
    const threadAudit = await env.DB.prepare(
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'thread.delete' AND target = ?",
    )
      .bind(String(tStaff.threadId))
      .first<{ actor_type: string; actor_id: string; detail: string }>();
    expect(threadAudit).toBeTruthy();
    expect(threadAudit?.actor_type).toBe("board_staff");
    expect(threadAudit?.actor_id).toBe(deputy.account.id);

    // 4. 本人によるレス削除・スレ削除は監査ログを残さない
    expect((await poster.client.delete(`/v1/posts/${selfPost.post.id}`)).status).toBe(200);
    expect((await poster.client.delete(`/v1/threads/${tSelf.threadId}`)).status).toBe(200);
    const selfPostAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'post.delete' AND target = ?",
    )
      .bind(String(selfPost.post.id))
      .first<{ n: number }>();
    expect(selfPostAudit?.n).toBe(0);
    const selfThreadAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'thread.delete' AND target = ?",
    )
      .bind(String(tSelf.threadId))
      .first<{ n: number }>();
    expect(selfThreadAudit?.n).toBe(0);
  });

  it("受け入れ④ (F10): スレ主が自分だけで書き足したスレは本人削除でき、他人のレスがあれば 403", async () => {
    const owner = await authedClient({ name: "f10-board-owner" });
    const threadOwner = await authedClient({ name: "f10-thread-owner" });
    const otherUser = await authedClient({ name: "f10-other" });

    const board = await createBoard(owner.client, {
      settings: { allowThreadDelete: true, selfEditWindowMinutes: 60, turnstile: "off", cooldownSeconds: 0 },
    });

    // 1. ログイン中のスレ主が自分だけでレスを追記 → 本人削除できる
    const selfOnlyAccount = await createThread(threadOwner.client, board.board.slug, {
      title: "自分だけ追記（アカウント）",
      body: ">>1",
    });
    await postReply(threadOwner.client, selfOnlyAccount.threadId, ">>2 自分で追記");
    const delSelfAccount = await threadOwner.client.delete(`/v1/threads/${selfOnlyAccount.threadId}`);
    expect(delSelfAccount.status).toBe(200);
    expect(delSelfAccount.body.ok && delSelfAccount.body.data).toMatchObject({ deleted: true, selfDeleted: true });

    // 2. 匿名端末のスレ主が同一端末 Cookie で自分だけ追記 → 本人削除できる
    const anonOwner = new TestClient();
    const selfOnlyAnon = await createThread(anonOwner, board.board.slug, {
      title: "自分だけ追記（匿名）",
      body: ">>1",
    });
    await postReply(anonOwner, selfOnlyAnon.threadId, ">>2 匿名で自分追記");
    const delSelfAnon = await anonOwner.delete(`/v1/threads/${selfOnlyAnon.threadId}`);
    expect(delSelfAnon.status).toBe(200);
    expect(delSelfAnon.body.ok && delSelfAnon.body.data).toMatchObject({ deleted: true, selfDeleted: true });

    // 3. 他人のレスがあるスレ → 本人削除は 403
    const withOther = await createThread(threadOwner.client, board.board.slug, {
      title: "他人のレスあり",
      body: ">>1",
    });
    await postReply(otherUser.client, withOther.threadId, ">>2 他人のレス");
    const delWithOther = await threadOwner.client.delete(`/v1/threads/${withOther.threadId}`);
    expect(delWithOther.status).toBe(403);
  });

  it("F6 API: 板詳細 GET /v1/boards/:slug がスタッフ階級 (staffLevel) を正しく返す", async () => {
    const owner = await authedClient({ name: "f6-owner" });
    const deputy = await authedClient({ name: "f6-deputy" });
    const mod = await authedClient({ name: "f6-mod" });
    const plain = await authedClient({ name: "f6-plain" });
    const board = await createBoard(owner.client);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, 'deputy', ?, ?)",
    )
      .bind(board.board.id, deputy.account.id, owner.account.id, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO board_staff (board_id, account_id, level, by_account_id, created_at) VALUES (?, ?, 'moderator', ?, ?)",
    )
      .bind(board.board.id, mod.account.id, owner.account.id, now)
      .run();

    const ownerRes = await owner.client.get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${board.board.slug}`,
    );
    expect(ownerRes.body.ok && ownerRes.body.data).toMatchObject({ canManage: true, staffLevel: "admin" });

    const deputyRes = await deputy.client.get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${board.board.slug}`,
    );
    expect(deputyRes.body.ok && deputyRes.body.data).toMatchObject({ canManage: false, staffLevel: "deputy" });

    const modRes = await mod.client.get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${board.board.slug}`,
    );
    expect(modRes.body.ok && modRes.body.data).toMatchObject({ canManage: false, staffLevel: "moderator" });

    const plainRes = await plain.client.get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${board.board.slug}`,
    );
    expect(plainRes.body.ok && plainRes.body.data).toMatchObject({ canManage: false, staffLevel: null });

    const anonRes = await new TestClient().get<{ canManage: boolean; staffLevel: string | null }>(
      `/v1/boards/${board.board.slug}`,
    );
    expect(anonRes.body.ok && anonRes.body.data).toMatchObject({ canManage: false, staffLevel: null });
  });
});
