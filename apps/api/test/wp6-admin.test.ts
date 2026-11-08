// WP6: 管理画面 API（サイト設定・ユーザー・規制・監査ログ・概要）の統合テスト。
// 同一ファイル内のテストは D1 を共有するため、所有者は beforeAll で 1 回だけ作成する。

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapOwner,
  call,
  createSpecialAdmin,
  loginUser,
  registerUser,
  stepUp,
  totpCode,
  type OwnerSetup,
} from "./wp6-helpers";

let owner: OwnerSetup;

beforeAll(async () => {
  owner = await bootstrapOwner("owner-admin@example.com");
});

describe("管理 API", () => {
  it("サイト設定の取得・更新（owner + step-up）と監査ログ", async () => {
    const initial = await call<Record<string, unknown>>("GET", "/v1/admin/site-config", {
      cookie: owner.cookie,
    });
    expect(initial.status).toBe(200);
    expect(initial.data?.["site.name"]).toBe("おーぷんクローン");
    expect(initial.data?.["security.require_turnstile"]).toBe("auto");

    // 別セッション（TOTP ログイン）を作り、step-up 付与を消して再認証必須を確認する
    const ownerLogin = await call("POST", "/v1/auth/login", {
      body: {
        email: "owner-admin@example.com",
        password: "ownerpass-1234",
        totpCode: await totpCode(owner.secret),
      },
      ip: "10.30.0.1",
    });
    expect(ownerLogin.status).toBe(200);
    const freshCookie = ownerLogin.sessionCookie!;

    await env.DB.prepare("DELETE FROM session_stepup").run();
    const noStepUp = await call("PUT", "/v1/admin/site-config", {
      cookie: freshCookie,
      body: { "site.name": "拒否される名前" },
    });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.errorCode).toBe("STEP_UP_REQUIRED");

    expect((await stepUp(freshCookie, owner.secret)).status).toBe(200);
    const updated = await call<Record<string, unknown>>("PUT", "/v1/admin/site-config", {
      cookie: freshCookie,
      body: { "site.name": "テスト掲示板", "registration.open": false, "security.login_max_failures": 8 },
    });
    expect(updated.status).toBe(200);
    expect(updated.data?.["site.name"]).toBe("テスト掲示板");
    expect(updated.data?.["registration.open"]).toBe(false);
    expect(updated.data?.["security.login_max_failures"]).toBe(8);

    const blockedRegister = await registerUser("closed@example.com", "password-1234", "停止中", "10.30.0.2");
    expect(blockedRegister.status).toBe(403);

    // 後続テストのため登録を再開する
    const reopened = await call<Record<string, unknown>>("PUT", "/v1/admin/site-config", {
      cookie: freshCookie,
      body: { "registration.open": true },
    });
    expect(reopened.data?.["registration.open"]).toBe(true);

    const audit = await call<{ items: { action: string; actorId: string | null }[] }>(
      "GET",
      "/v1/admin/audit?action=admin.site_config_update",
      { cookie: freshCookie },
    );
    expect(audit.status).toBe(200);
    expect(audit.data?.items[0]?.action).toBe("admin.site_config_update");
    expect(audit.data?.items[0]?.actorId).toBe(owner.accountId);
  });

  it("ユーザー一覧・停止・解除・所有者保護", async () => {
    const victim = await registerUser("target@example.com", "password-1234", "対象者", "10.31.0.1");
    expect(victim.status).toBe(201);
    expect(victim.sessionCookie).toBeTruthy();
    const victimId = (await call<{ profile: { id: string } }>("GET", "/v1/accounts/me", { cookie: victim.sessionCookie })).data!.profile.id;

    const users = await call<{ items: { id: string; email: string | null; status: string }[]; total: number }>(
      "GET",
      "/v1/admin/users?q=target@example.com",
      { cookie: owner.cookie },
    );
    expect(users.status).toBe(200);
    expect(users.data?.total).toBe(1);
    expect(users.data?.items[0]?.id).toBe(victimId);

    // 一般ユーザーは管理 API を叩けない
    expect((await call("GET", "/v1/admin/users", { cookie: victim.sessionCookie })).status).toBe(403);

    // 所有者は停止できない
    await stepUp(owner.cookie, owner.secret);
    const ownerSuspend = await call("POST", "/v1/admin/suspensions", {
      cookie: owner.cookie,
      body: { accountId: owner.accountId, scope: "site", reason: "テスト" },
    });
    expect(ownerSuspend.status).toBe(403);

    const created = await call<{ id: string; accountId: string; scope: string; active: boolean }>(
      "POST",
      "/v1/admin/suspensions",
      { cookie: owner.cookie, body: { accountId: victimId, scope: "site", reason: "スパム" } },
    );
    expect(created.status).toBe(201);
    expect(created.data?.active).toBe(true);

    // 既存セッションが失効し、ログインも拒否される
    const sessionAfter = await call<{ authenticated: boolean }>("GET", "/v1/auth/session", {
      cookie: victim.sessionCookie,
    });
    expect(sessionAfter.data).toEqual({ authenticated: false });
    const banned = await loginUser("target@example.com", "password-1234", undefined, "10.31.0.1");
    expect(banned.status).toBe(403);
    expect(banned.errorCode).toBe("BANNED");

    const activeList = await call<{ items: { id: string }[] }>("GET", "/v1/admin/suspensions?active=1", {
      cookie: owner.cookie,
    });
    expect(activeList.data?.items.some((item) => item.id === created.data!.id)).toBe(true);

    // 解除するとログイン可能に戻る
    const lifted = await call("POST", `/v1/admin/suspensions/${created.data!.id}/lift`, {
      cookie: owner.cookie,
    });
    expect(lifted.status).toBe(200);
    const relogin = await loginUser("target@example.com", "password-1234", undefined, "10.31.0.1");
    expect(relogin.status).toBe(200);

    const overview = await call<{ accounts: number; activeSuspensions: number; ownerExists: boolean }>(
      "GET",
      "/v1/admin/overview",
      { cookie: owner.cookie },
    );
    expect(overview.status).toBe(200);
    expect(overview.data!.accounts).toBeGreaterThanOrEqual(2);
    expect(overview.data!.activeSuspensions).toBe(0);
    expect(overview.data!.ownerExists).toBe(true);
  });

  it("板スコープの規制は boardId 必須", async () => {
    await stepUp(owner.cookie, owner.secret);
    const invalid = await call("POST", "/v1/admin/suspensions", {
      cookie: owner.cookie,
      body: { email: "banned@example.com", scope: "board", reason: "荒らし" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.errorCode).toBe("VALIDATION");

    const created = await call<{ scope: string; boardId: number }>("POST", "/v1/admin/suspensions", {
      cookie: owner.cookie,
      body: { email: "banned@example.com", scope: "board", boardId: 12, reason: "荒らし" },
    });
    expect(created.status).toBe(201);
    expect(created.data?.boardId).toBe(12);
  });

  it("特別管理人の停止は所有者専用・停止理由が返る", async () => {
    const sa = await createSpecialAdmin(owner, "special-admin-guard@example.com");

    const denied = await call("POST", `/v1/admin/special-admins/${sa.id}/stop`, {
      cookie: sa.cookie,
      body: { reason: "自分では止められない" },
    });
    expect(denied.status).toBe(403);

    await stepUp(owner.cookie, owner.secret);
    const stopped = await call("POST", `/v1/admin/special-admins/${sa.id}/stop`, {
      cookie: owner.cookie,
      body: { reason: "規程違反" },
    });
    expect(stopped.status).toBe(200);

    const list = await call<{ items: { id: string; stopReason: string | null; stoppedAt: number | null }[] }>(
      "GET",
      "/v1/admin/special-admins",
      { cookie: owner.cookie },
    );
    expect(list.data?.items[0]?.stopReason).toBe("規程違反");
    expect(list.data?.items[0]?.stoppedAt).not.toBeNull();

    await stepUp(owner.cookie, owner.secret);
    const restored = await call("POST", `/v1/admin/special-admins/${sa.id}/restore`, { cookie: owner.cookie });
    expect(restored.status).toBe(200);
    const saRelogin = await loginUser(sa.email, sa.password, await totpCode(sa.secret), "10.31.0.9");
    expect(saRelogin.status).toBe(200);
    expect((await call("GET", "/v1/admin/users", { cookie: saRelogin.sessionCookie })).status).toBe(200);

    // 監査ログに停止・復旧が記録される
    const audit = await call<{ items: { action: string }[] }>(
      "GET",
      "/v1/admin/audit?action=admin.special_admin_",
      { cookie: owner.cookie },
    );
    const actions = audit.data!.items.map((item) => item.action);
    expect(actions).toContain("admin.special_admin_stop");
    expect(actions).toContain("admin.special_admin_restore");
  });
});