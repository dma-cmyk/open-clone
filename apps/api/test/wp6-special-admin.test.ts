// WP6: 特別管理人就任フローの受入テスト（所有者ブートストラップ→招待→就任→TOTP→復旧→停止→復旧）。

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bootstrapOwner,
  call,
  countRows,
  loginUser,
  registerUser,
  stepUp,
  totpCode,
} from "./wp6-helpers";

const stopReasonDetails = z.object({ reason: z.string() });

describe("特別管理人 就任フロー", () => {
  it("ブートストラップ→招待→就任→TOTP ログイン→リカバリー→停止/復旧→TOTP リセットと再招待", async () => {
    // --- 所有者ブートストラップ ---
    // 所有者の有無は未認証で公開しない（報告書 24 L-3）。status は廃止され 404。
    const statusBefore = await call("GET", "/v1/admin/owner/setup/status");
    expect(statusBefore.status).toBe(404);

    const owner = await bootstrapOwner("owner-root@example.com");
    expect(owner.recoveryCodes).toHaveLength(10);

    const statusAfter = await call("GET", "/v1/admin/owner/setup/status");
    expect(statusAfter.status).toBe(404);

    const secondBootstrap = await call("POST", "/v1/admin/owner/setup", {
      body: {
        bootstrapKey: "test-owner-key",
        name: "2人目",
        email: "owner2@example.com",
        password: "ownerpass-1234",
        totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
        totpCode: "000000",
      },
      ip: "10.0.0.9",
    });
    expect(secondBootstrap.status).toBe(409);
    expect(secondBootstrap.errorCode).toBe("OWNER_SETUP_CLOSED");

    // --- 招待キー発行（owner のみ） ---
    const rejectedIssue = await call("POST", "/v1/admin/invites", {
      body: { kind: "special_admin" },
      ip: "10.0.0.3",
    });
    expect(rejectedIssue.status).toBe(401);

    await stepUp(owner.cookie, owner.secret);
    const issued = await call<{ id: string; key: string; acceptPath: string; expiresAt: number }>(
      "POST",
      "/v1/admin/invites",
      {
        cookie: owner.cookie,
        body: { kind: "special_admin", note: "特別管理人（DM で送付）" },
        ip: "10.0.0.1",
      },
    );
    expect(issued.status).toBe(201);
    expect(issued.data?.key).toMatch(/^oc_inv_/);
    expect(issued.data?.acceptPath).toContain("/admin/invites/accept?key=");

    // 就任前は管理人として一切存在・表示されない
    expect(await countRows("SELECT COUNT(*) AS n FROM accounts WHERE role = 'special_admin'")).toBe(0);
    const usersBefore = await call<{ items: unknown[]; total: number }>(
      "GET",
      "/v1/admin/users?role=special_admin",
      { cookie: owner.cookie },
    );
    expect(usersBefore.data?.total).toBe(0);

    // 招待一覧は owner のみ・pending は owner にだけ見える
    const invites = await call<{ items: { id: string; state: string }[] }>("GET", "/v1/admin/invites", {
      cookie: owner.cookie,
    });
    expect(invites.data?.items[0]?.state).toBe("pending");
    expect((await call("GET", "/v1/admin/invites")).status).toBe(401);

    // --- 就任フォーム（TOTP 必須登録） ---
    const inspect = await call<{ valid: boolean; kind: string; note: string | null }>(
      "GET",
      `/v1/admin/invites/inspect?key=${encodeURIComponent(issued.data!.key)}`,
    );
    expect(inspect.data?.valid).toBe(true);
    expect(inspect.data?.kind).toBe("special_admin");
    expect(inspect.data?.note).toContain("特別管理人");

    const prepared = await call<{ secret: string; otpauthUri: string }>(
      "POST",
      "/v1/admin/invites/prepare-totp",
      { body: { key: issued.data!.key }, ip: "10.0.0.2" },
    );
    expect(prepared.data?.otpauthUri).toContain("otpauth://totp/OpenClone:");

    const acceptBody = {
      key: issued.data!.key,
      name: "特別管理人テスト",
      email: "special-admin@example.com",
      password: "specialpass-1234",
      totpSecret: prepared.data!.secret,
      totpCode: await totpCode(prepared.data!.secret),
    };
    const accepted = await call<{
      account: { id: string; role: string };
      recoveryCodes: string[];
      boardAssignment: unknown;
    }>("POST", "/v1/admin/invites/accept", { body: acceptBody, ip: "10.0.0.2" });
    expect(accepted.status).toBe(201);
    expect(accepted.data?.account.role).toBe("special_admin");
    expect(accepted.data?.recoveryCodes).toHaveLength(10);
    expect(accepted.data?.boardAssignment).toBeNull();
    const saId = accepted.data!.account.id;
    const saCookie = accepted.sessionCookie!;
    const recoveryCodes = accepted.data!.recoveryCodes;

    // キーの再利用は拒否
    const reuse = await call("POST", "/v1/admin/invites/accept", { body: acceptBody, ip: "10.0.0.2" });
    expect(reuse.status).toBe(400);
    expect(reuse.errorCode).toBe("INVITE_INVALID");
    expect(await countRows("SELECT COUNT(*) AS n FROM accounts WHERE role = 'special_admin'")).toBe(1);

    // --- 特別管理人セッションと権限境界 ---
    const saSession = await call<{
      authenticated: boolean;
      account: { role: string };
      totp: { enabled: boolean; required: boolean };
      specialAdminStopped: boolean;
    }>("GET", "/v1/auth/session", { cookie: saCookie });
    expect(saSession.data?.account.role).toBe("special_admin");
    expect(saSession.data?.totp.enabled).toBe(true);
    expect(saSession.data?.specialAdminStopped).toBe(false);

    // 所有者専用 API は叩けない
    expect((await call("POST", "/v1/admin/invites", { cookie: saCookie, body: { kind: "special_admin" } })).status).toBe(403);
    expect((await call("GET", "/v1/admin/special-admins", { cookie: saCookie })).status).toBe(403);
    expect((await call("GET", `/v1/admin/users/${owner.accountId}`, { cookie: saCookie })).status).toBe(403);
    expect(
      (await call("PUT", "/v1/admin/site-config", { cookie: saCookie, body: { "site.name": "乗っ取り" } })).status,
    ).toBe(403);
    // 運用 API（全板横断）は使える
    const usersAsSa = await call<{ items: unknown[] }>("GET", "/v1/admin/users", { cookie: saCookie });
    expect(usersAsSa.status).toBe(200);

    // 自分の操作ログのみ閲覧（所有者のブートストラップ・招待発行は見えない）
    const saAudit = await call<{ items: { actorId: string | null; action: string }[] }>(
      "GET",
      "/v1/admin/audit",
      { cookie: saCookie },
    );
    expect(saAudit.status).toBe(200);
    expect(saAudit.data!.items.every((item) => item.actorId === saId)).toBe(true);
    expect(saAudit.data!.items.some((item) => item.action === "admin.invite_accept")).toBe(true);
    expect(saAudit.data!.items.some((item) => item.action === "admin.owner_bootstrap")).toBe(false);

    // --- TOTP ログイン ---
    await call("POST", "/v1/auth/logout", { cookie: saCookie });
    const noTotp = await loginUser("special-admin@example.com", "specialpass-1234", undefined, "10.0.0.4");
    expect(noTotp.status).toBe(401);
    expect(noTotp.errorCode).toBe("TOTP_REQUIRED");
    const saLogin = await loginUser(
      "special-admin@example.com",
      "specialpass-1234",
      await totpCode(prepared.data!.secret),
      "10.0.0.4",
    );
    expect(saLogin.status).toBe(200);
    let currentSaCookie = saLogin.sessionCookie!;

    // --- リカバリーコードで復旧 ---
    await call("POST", "/v1/auth/logout", { cookie: currentSaCookie });
    const recovered = await call<{
      totpSetupRequired: boolean;
      recoveryRemaining: number;
    }>("POST", "/v1/auth/recovery", {
      body: { email: "special-admin@example.com", password: "specialpass-1234", code: recoveryCodes[0]! },
      ip: "10.0.0.5",
    });
    expect(recovered.status).toBe(200);
    expect(recovered.data?.totpSetupRequired).toBe(true);
    expect(recovered.data?.recoveryRemaining).toBe(9);
    currentSaCookie = recovered.sessionCookie!;

    // TOTP 未再登録のうちは高リスク操作（step-up 必須）が拒否される
    await registerUser("victim@example.com", "password-1234", "対象者", "10.0.0.6");
    const victimId = (
      await call<{ items: { id: string }[] }>("GET", "/v1/admin/users?q=victim@example.com", {
        cookie: currentSaCookie,
      })
    ).data!.items[0]!.id;
    const blockedMutation = await call("POST", "/v1/admin/suspensions", {
      cookie: currentSaCookie,
      body: { accountId: victimId, scope: "site", reason: "テスト" },
    });
    expect(blockedMutation.status).toBe(403);
    expect(blockedMutation.errorCode).toBe("STEP_UP_REQUIRED");

    // TOTP を再登録 → 新しいリカバリーコード → step-up → 操作可能
    const setup = await call<{ secret: string }>("POST", "/v1/auth/totp/setup", { cookie: currentSaCookie, body: {} });
    const newSecret = setup.data!.secret;
    const enabled = await call<{ recoveryCodes: string[] }>("POST", "/v1/auth/totp/enable", {
      cookie: currentSaCookie,
      body: { code: await totpCode(newSecret) },
    });
    expect(enabled.data?.recoveryCodes).toHaveLength(10);
    const steppedUp = await stepUp(currentSaCookie, newSecret);
    expect(steppedUp.status).toBe(200);
    const suspended = await call<{ id: string; active: boolean }>("POST", "/v1/admin/suspensions", {
      cookie: currentSaCookie,
      body: { accountId: victimId, scope: "site", reason: "荒らし" },
    });
    expect(suspended.status).toBe(201);
    expect(suspended.data?.active).toBe(true);
    await call("POST", `/v1/admin/suspensions/${suspended.data!.id}/lift`, { cookie: currentSaCookie });

    // --- 所有者による権限停止 ---
    await stepUp(owner.cookie, owner.secret);
    const stopped = await call<{ stopped: boolean; revokedSessions: number }>(
      "POST",
      `/v1/admin/special-admins/${saId}/stop`,
      { cookie: owner.cookie, body: { reason: "権限の一時停止" } },
    );
    expect(stopped.status).toBe(200);
    expect(stopped.data?.stopped).toBe(true);
    expect(stopped.data?.revokedSessions).toBeGreaterThanOrEqual(1);

    // 停止でセッションが失効し、再ログインしても管理 API は拒否される
    const revokedSession = await call<{ authenticated: boolean }>("GET", "/v1/auth/session", {
      cookie: currentSaCookie,
    });
    expect(revokedSession.data).toEqual({ authenticated: false });

    const saRelogin = await loginUser(
      "special-admin@example.com",
      "specialpass-1234",
      // 直前の stepUp で現在窓のコードを消費済みのため、次の窓のコードを使う（M-4）。
      await totpCode(newSecret, 1),
      "10.0.0.4",
    );
    expect(saRelogin.status).toBe(200);
    currentSaCookie = saRelogin.sessionCookie!;
    const denied = await call("GET", "/v1/admin/users", { cookie: currentSaCookie });
    expect(denied.status).toBe(403);
    if (denied.body.ok) throw new Error("expected FORBIDDEN");
    expect(stopReasonDetails.parse(denied.body.details).reason).toBe("special_admin_stopped");

    // 所有者は停止・復旧できる（最終権限）
    await stepUp(owner.cookie, owner.secret);
    const restored = await call("POST", `/v1/admin/special-admins/${saId}/restore`, { cookie: owner.cookie });
    expect(restored.status).toBe(200);
    expect((await call("GET", "/v1/admin/users", { cookie: currentSaCookie })).status).toBe(200);

    // --- 所有者による TOTP リセット + 再招待 ---
    await stepUp(owner.cookie, owner.secret);
    const reset = await call<{ invite: { key: string } | null; sessionsRevoked: number }>(
      "POST",
      `/v1/admin/special-admins/${saId}/totp-reset`,
      { cookie: owner.cookie, body: { reinvite: true, note: "TOTP 端末紛失" } },
    );
    expect(reset.status).toBe(200);
    expect(reset.data?.invite?.key).toMatch(/^oc_inv_/);
    expect(reset.data?.sessionsRevoked).toBeGreaterThanOrEqual(0);

    const passwordOnly = await loginUser("special-admin@example.com", "specialpass-1234", undefined, "10.0.0.7");
    expect(passwordOnly.status).toBe(200);
    const reloginSession = await call<{ totpSetupRequired: boolean }>("GET", "/v1/auth/session", {
      cookie: passwordOnly.sessionCookie,
    });
    expect(reloginSession.data?.totpSetupRequired).toBe(true);

    const reprepare = await call<{ secret: string }>("POST", "/v1/admin/invites/prepare-totp", {
      body: { key: reset.data!.invite!.key },
    });
    const reaccepted = await call<{ account: { id: string; role: string }; recoveryCodes: string[] }>(
      "POST",
      "/v1/admin/invites/accept",
      {
        body: {
          key: reset.data!.invite!.key,
          name: "特別管理人テスト",
          email: "special-admin@example.com",
          password: "specialpass-9999",
          totpSecret: reprepare.data!.secret,
          totpCode: await totpCode(reprepare.data!.secret),
        },
        ip: "10.0.0.8",
      },
    );
    expect(reaccepted.status).toBe(201);
    expect(reaccepted.data?.account.id).toBe(saId);
    expect(reaccepted.data?.recoveryCodes).toHaveLength(10);

    const relogin = await loginUser(
      "special-admin@example.com",
      "specialpass-9999",
      await totpCode(reprepare.data!.secret),
      "10.0.0.9",
    );
    expect(relogin.status).toBe(200);

    // 所有者は存在し続け、最終権限を維持する
    const ownerSession = await call<{ account: { role: string } }>("GET", "/v1/auth/session", {
      cookie: owner.cookie,
    });
    expect(ownerSession.data?.account.role).toBe("owner");
    expect(await countRows("SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner'")).toBe(1);
  });
});
