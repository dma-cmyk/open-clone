// WP6: 登録/ログイン/ログアウト/セッション/パスワード/TOTP/リカバリー/レート制限の統合テスト。

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  call,
  loginUser,
  registerUser,
  setSiteSetting,
  totpCode,
} from "./wp6-helpers";

const totpRequiredDetails = z.object({ totpRequired: z.boolean() });
const remainingDetails = z.object({ remaining: z.number().int() });

describe("登録・ログイン・セッション", () => {
  it("登録→セッション→ログアウト→ログインのライフサイクル", async () => {
    const email = "user1@example.com";
    const registered = await registerUser(email, "password-1234", "ユーザー1", "10.10.0.1");
    expect(registered.status).toBe(201);
    expect(registered.data?.account.role).toBe("user");
    expect(registered.sessionCookie).toMatch(/^oc_sess=/);

    const session = await call<{ authenticated: boolean; account: { email: string }; totp: { enabled: boolean } }>(
      "GET",
      "/v1/auth/session",
      { cookie: registered.sessionCookie },
    );
    expect(session.status).toBe(200);
    expect(session.data?.authenticated).toBe(true);
    expect(session.data?.account.email).toBe(email);
    expect(session.data?.totp.enabled).toBe(false);

    const anon = await call("GET", "/v1/auth/session");
    expect(anon.data).toEqual({ authenticated: false });

    const logout = await call("POST", "/v1/auth/logout", { cookie: registered.sessionCookie });
    expect(logout.status).toBe(200);

    const afterLogout = await call("GET", "/v1/auth/session", { cookie: registered.sessionCookie });
    expect(afterLogout.data).toEqual({ authenticated: false });

    const wrong = await loginUser(email, "wrong-password", undefined, "10.10.0.1");
    expect(wrong.status).toBe(401);
    expect(wrong.errorCode).toBe("UNAUTHORIZED");

    const login = await loginUser(email, "password-1234", undefined, "10.10.0.1");
    expect(login.status).toBe(200);
    expect(login.sessionCookie).toMatch(/^oc_sess=/);
  });

  it("重複メールは 409・入力不正は 400", async () => {
    const email = "dup@example.com";
    expect((await registerUser(email, "password-1234", "重複", "10.10.0.2")).status).toBe(201);
    const dup = await registerUser(email, "password-1234", "重複2", "10.10.0.2");
    expect(dup.status).toBe(409);
    expect(dup.errorCode).toBe("CONFLICT");

    const invalid = await call("POST", "/v1/auth/register", {
      body: { name: "", email: "not-an-email", password: "short" },
      ip: "10.10.0.3",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.errorCode).toBe("VALIDATION");
  });

  it("パスワード変更で他のセッションが失効する", async () => {
    const email = "pwchange@example.com";
    const first = await registerUser(email, "oldpass-1234", "変更", "10.10.0.4");
    const second = await loginUser(email, "oldpass-1234", undefined, "10.10.0.4");
    expect(first.sessionCookie).toBeTruthy();
    expect(second.sessionCookie).toBeTruthy();

    const wrong = await call("POST", "/v1/accounts/me/password", {
      cookie: first.sessionCookie,
      body: { currentPassword: "bad", newPassword: "newpass-5678" },
    });
    expect(wrong.status).toBe(400);

    const changed = await call<{ changed: boolean; revokedSessions: number }>(
      "POST",
      "/v1/accounts/me/password",
      { cookie: first.sessionCookie, body: { currentPassword: "oldpass-1234", newPassword: "newpass-5678" } },
    );
    expect(changed.status).toBe(200);
    expect(changed.data?.revokedSessions).toBe(1);

    const secondSession = await call("GET", "/v1/auth/session", { cookie: second.sessionCookie });
    expect(secondSession.data).toEqual({ authenticated: false });
    expect((await loginUser(email, "oldpass-1234", undefined, "10.10.0.4")).status).toBe(401);
    expect((await loginUser(email, "newpass-5678", undefined, "10.10.0.4")).status).toBe(200);
  });

  it("ログイン試行の上限で 429", async () => {
    await setSiteSetting("security.require_turnstile", "off");
    const email = "ratelimit@example.com";
    expect((await registerUser(email, "password-1234", "RL", "10.10.1.1")).status).toBe(201);
    for (let i = 0; i < 10; i++) {
      const attempt = await loginUser(email, "wrong-password", undefined, "10.10.1.1");
      expect(attempt.status).toBe(401);
    }
    const limited = await loginUser(email, "password-1234", undefined, "10.10.1.1");
    expect(limited.status).toBe(429);
    expect(limited.errorCode).toBe("RATE_LIMITED");
  });

  it("Turnstile 要求（always）でトークンなし登録が拒否される", async () => {
    await setSiteSetting("security.require_turnstile", "always");
    const rejected = await registerUser("turnstile@example.com", "password-1234", "TS", "10.10.2.1");
    expect(rejected.status).toBe(400);
    expect(rejected.errorCode).toBe("TURNSTILE_FAILED");

    // 3 回失敗後のログインでも要求される
    await setSiteSetting("security.require_turnstile", "auto");
    const email = "turnstile-login@example.com";
    expect((await registerUser(email, "password-1234", "TS2", "10.10.2.2")).status).toBe(201);
    for (let i = 0; i < 3; i++) {
      expect((await loginUser(email, "wrong", undefined, "10.10.2.2")).status).toBe(401);
    }
    const login = await loginUser(email, "password-1234", undefined, "10.10.2.2");
    expect(login.status).toBe(400);
    expect(login.errorCode).toBe("TURNSTILE_FAILED");
    await setSiteSetting("security.require_turnstile", "auto");
  });

  it("登録の日次上限（同一 IP）で 429", async () => {
    await setSiteSetting("security.require_turnstile", "off");
    for (let i = 0; i < 5; i++) {
      const result = await registerUser(`ip-limit-${i}@example.com`, "password-1234", `IP${i}`, "10.10.3.1");
      expect(result.status).toBe(201);
    }
    const blocked = await registerUser("ip-limit-5@example.com", "password-1234", "IP5", "10.10.3.1");
    expect(blocked.status).toBe(429);
    expect(blocked.errorCode).toBe("RATE_LIMITED");
  });
});

describe("TOTP", () => {
  it("セットアップ→QR URI→有効化→ログイン要求→無効化", async () => {
    await setSiteSetting("security.require_turnstile", "off");
    const email = "totp@example.com";
    const registered = await registerUser(email, "password-1234", "TOTP", "10.20.0.1");
    const cookie = registered.sessionCookie!;

    const setup = await call<{ secret: string; otpauthUri: string }>("POST", "/v1/auth/totp/setup", {
      cookie,
      body: {},
    });
    expect(setup.status).toBe(200);
    const secret = setup.data!.secret;
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(setup.data!.otpauthUri).toContain("otpauth://totp/OpenClone:");
    expect(setup.data!.otpauthUri).toContain("period=30");
    expect(setup.data!.otpauthUri).toContain("digits=6");
    expect(setup.data!.otpauthUri).toContain("issuer=OpenClone");
    expect(setup.data!.otpauthUri).toContain(`secret=${secret}`);

    const wrongEnable = await call("POST", "/v1/auth/totp/enable", {
      cookie,
      body: { code: "000000" },
    });
    expect(wrongEnable.status).toBe(400);
    expect(wrongEnable.errorCode).toBe("TOTP_INVALID");

    const enabled = await call<{ recoveryCodes: string[] }>("POST", "/v1/auth/totp/enable", {
      cookie,
      body: { code: await totpCode(secret) },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.data!.recoveryCodes).toHaveLength(10);

    const status = await call<{ enabled: boolean; recoveryRemaining: number }>("GET", "/v1/auth/totp/status", {
      cookie,
    });
    expect(status.data?.enabled).toBe(true);
    expect(status.data?.recoveryRemaining).toBe(10);

    // ログアウト後のログインは TOTP 必須
    await call("POST", "/v1/auth/logout", { cookie });
    const noCode = await loginUser(email, "password-1234", undefined, "10.20.0.1");
    expect(noCode.status).toBe(401);
    expect(noCode.errorCode).toBe("TOTP_REQUIRED");
    if (noCode.body.ok) throw new Error("expected TOTP_REQUIRED");
    expect(totpRequiredDetails.parse(noCode.body.details).totpRequired).toBe(true);

    const invalid = await loginUser(email, "password-1234", "000000", "10.20.0.1");
    expect(invalid.status).toBe(401);
    expect(invalid.errorCode).toBe("TOTP_INVALID");

    // ±1 窓（前の窓のコード）を許容する
    const previousWindow = await loginUser(email, "password-1234", await totpCode(secret, -1), "10.20.0.1");
    expect(previousWindow.status).toBe(200);

    // 任意 TOTP なので本人は無効化できる
    const disabled = await call("POST", "/v1/auth/totp/disable", {
      cookie: previousWindow.sessionCookie,
      body: { code: await totpCode(secret) },
    });
    expect(disabled.status).toBe(200);
    const loginWithout = await loginUser(email, "password-1234", undefined, "10.20.0.1");
    expect(loginWithout.status).toBe(200);
  });

  it("5 回失敗で 15 分ロック", async () => {
    await setSiteSetting("security.require_turnstile", "off");
    const email = "totplock@example.com";
    const registered = await registerUser(email, "password-1234", "Lock", "10.21.0.1");
    const cookie = registered.sessionCookie!;
    const setup = await call<{ secret: string }>("POST", "/v1/auth/totp/setup", { cookie, body: {} });
    const secret = setup.data!.secret;
    await call("POST", "/v1/auth/totp/enable", { cookie, body: { code: await totpCode(secret) } });
    await call("POST", "/v1/auth/logout", { cookie });

    for (let i = 0; i < 4; i++) {
      const attempt = await loginUser(email, "password-1234", "000000", "10.21.0.1");
      expect(attempt.status).toBe(401);
      if (attempt.body.ok) throw new Error("expected TOTP_INVALID");
      expect(remainingDetails.parse(attempt.body.details).remaining).toBe(4 - i);
    }
    const fifth = await loginUser(email, "password-1234", "000000", "10.21.0.1");
    expect(fifth.status).toBe(429);
    expect(fifth.errorCode).toBe("TOTP_LOCKED");
    const lockedButCorrect = await loginUser(email, "password-1234", await totpCode(secret), "10.21.0.1");
    expect(lockedButCorrect.status).toBe(429);
    expect(lockedButCorrect.errorCode).toBe("TOTP_LOCKED");
  });

  it("同じタイムステップの TOTP コードは再利用できない（M-4）", async () => {
    await setSiteSetting("security.require_turnstile", "off");
    const email = "totpreplay@example.com";
    const registered = await registerUser(email, "password-1234", "Replay", "10.23.0.1");
    const cookie = registered.sessionCookie!;
    const setup = await call<{ secret: string }>("POST", "/v1/auth/totp/setup", { cookie, body: {} });
    const secret = setup.data!.secret;
    await call("POST", "/v1/auth/totp/enable", { cookie, body: { code: await totpCode(secret) } });
    await call("POST", "/v1/auth/logout", { cookie });

    const code = await totpCode(secret);
    const first = await loginUser(email, "password-1234", code, "10.23.0.1");
    expect(first.status).toBe(200);

    const replay = await loginUser(email, "password-1234", code, "10.23.0.1");
    expect(replay.status).toBe(401);
    expect(replay.errorCode).toBe("TOTP_INVALID");

    // 次の窓のコードは使える（恒久ロックではない）
    const next = await loginUser(email, "password-1234", await totpCode(secret, 1), "10.23.0.1");
    expect(next.status).toBe(200);
  });

  it("リカバリーコードで復旧（単回使用）", async () => {
    await setSiteSetting("security.require_turnstile", "off");
    const email = "recovery@example.com";
    const registered = await registerUser(email, "password-1234", "Rec", "10.22.0.1");
    const cookie = registered.sessionCookie!;
    const setup = await call<{ secret: string }>("POST", "/v1/auth/totp/setup", { cookie, body: {} });
    const secret = setup.data!.secret;
    const enabled = await call<{ recoveryCodes: string[] }>("POST", "/v1/auth/totp/enable", {
      cookie,
      body: { code: await totpCode(secret) },
    });
    const recoveryCode = enabled.data!.recoveryCodes[0]!;
    await call("POST", "/v1/auth/logout", { cookie });

    const recovered = await call<{
      totpSetupRequired: boolean;
      recoveryRemaining: number;
      account: { email: string };
    }>("POST", "/v1/auth/recovery", {
      body: { email, password: "password-1234", code: recoveryCode },
      ip: "10.22.0.1",
    });
    expect(recovered.status).toBe(200);
    expect(recovered.data?.totpSetupRequired).toBe(false);
    expect(recovered.data?.recoveryRemaining).toBe(9);
    expect(recovered.sessionCookie).toMatch(/^oc_sess=/);

    const reuse = await call("POST", "/v1/auth/recovery", {
      body: { email, password: "password-1234", code: recoveryCode },
      ip: "10.22.0.1",
    });
    expect(reuse.status).toBe(400);
    expect(reuse.errorCode).toBe("TOTP_INVALID");

    const login = await loginUser(email, "password-1234", undefined, "10.22.0.1");
    expect(login.status).toBe(200);
  });
});