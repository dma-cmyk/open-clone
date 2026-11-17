// パスワードを忘れたときの復旧（設計 50）の API テスト。
// ① 復旧コードでの再設定: 列挙対策（同じエラー）・試行制限・利用停止・単回使用・全セッション失効・TOTP 維持
// ② 運営（所有者）が発行する 1 回限りの再設定 URL: 権限・step-up・対象制限・ハッシュ保存・期限・失効・再発行

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { sha256Hex } from "shared";
import { network } from "./network";
import {
  bootstrapOwner,
  call,
  loginUser,
  registerUser,
  setSiteSetting,
  stepUp,
  totpCode,
  type OwnerSetup,
} from "./wp6-helpers";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** ロボット確認は毎回必須。テストでは siteverify を常に成功させる。 */
const TURNSTILE = { "x-turnstile-token": "test-turnstile-token" };

beforeEach(() => {
  network.use(http.post(SITEVERIFY, () => HttpResponse.json({ success: true })));
});

let owner: OwnerSetup;
beforeAll(async () => {
  owner = await bootstrapOwner("owner-reset@example.com");
});

async function registerWithCodes(
  email: string,
  password: string,
  ip: string,
): Promise<{ accountId: string; cookie: string; codes: string[] }> {
  const registered = await registerUser(email, password, "復旧テスト", ip);
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const cookie = registered.sessionCookie!;
  const codes = await call<{ recoveryCodes: string[] }>("POST", "/v1/auth/recovery-codes/regenerate", {
    cookie,
    body: { password },
  });
  expect(codes.status).toBe(200);
  return { accountId: registered.data!.account.id, cookie, codes: codes.data!.recoveryCodes };
}

async function isAuthenticated(cookie: string): Promise<boolean> {
  const session = await call<{ authenticated: boolean }>("GET", "/v1/auth/session", { cookie });
  return session.data?.authenticated === true;
}

describe("復旧コードでパスワードを再設定（①）", () => {
  it("成功→コード消費→古いパスワード無効→全セッション失効→新パスワードでログイン", async () => {
    const email = "reset-basic@example.com";
    const oldPassword = "old-password-1234";
    const { cookie, codes } = await registerWithCodes(email, oldPassword, "10.40.0.1");
    // 別セッション（全失効の確認用）
    const second = await loginUser(email, oldPassword, undefined, "10.40.0.2");
    const secondCookie = second.sessionCookie!;
    expect(await isAuthenticated(secondCookie)).toBe(true);

    const reset = await call<{ reset: boolean; recoveryRemaining: number }>("POST", "/v1/auth/password-reset", {
      body: { email, code: codes[0]!, newPassword: "brand-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.40.0.3",
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.data?.reset).toBe(true);
    expect(reset.data?.recoveryRemaining).toBe(9);
    // 自動ログインはしない
    expect(reset.sessionCookie).toBeNull();

    // 全セッション失効（登録時のセッションも、別セッションも）
    expect(await isAuthenticated(cookie)).toBe(false);
    expect(await isAuthenticated(secondCookie)).toBe(false);

    // 古いパスワードは使えず、新しいパスワードでログインできる
    expect((await loginUser(email, oldPassword, undefined, "10.40.0.4")).status).toBe(401);
    expect((await loginUser(email, "brand-new-password-1234", undefined, "10.40.0.5")).status).toBe(200);

    // 同じコードの再利用は不可
    const reuse = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: codes[0]!, newPassword: "another-password-1234" },
      headers: TURNSTILE,
      ip: "10.40.0.6",
    });
    expect(reuse.status).toBe(400);
    expect(reuse.errorCode).toBe("RESET_INVALID");
  });

  it("存在しないメールと誤ったコードは同じエラー（列挙しない）", async () => {
    const email = "reset-enum@example.com";
    await registerWithCodes(email, "enum-password-1234", "10.41.0.1");
    const wrongCode = "AAAAAA-BBBBBB-CCCCCC-DDDDDD";

    const wrongCodeResult = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: wrongCode, newPassword: "enum-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.41.0.2",
    });
    const unknownEmailResult = await call("POST", "/v1/auth/password-reset", {
      body: { email: "nobody-reset@example.com", code: wrongCode, newPassword: "enum-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.41.0.3",
    });
    expect(wrongCodeResult.status).toBe(400);
    expect(unknownEmailResult.status).toBe(400);
    expect(wrongCodeResult.errorCode).toBe("RESET_INVALID");
    expect(unknownEmailResult.errorCode).toBe("RESET_INVALID");
    expect(unknownEmailResult.body.ok).toBe(false);
    expect(wrongCodeResult.body.ok).toBe(false);
    if (!wrongCodeResult.body.ok && !unknownEmailResult.body.ok) {
      expect(unknownEmailResult.body.message).toBe(wrongCodeResult.body.message);
    }
  });

  it("ロボット確認は毎回必須（30 分省略の対象外）", async () => {
    const email = "reset-turnstile@example.com";
    const { codes } = await registerWithCodes(email, "ts-password-1234", "10.42.0.1");
    const noToken = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: codes[0]!, newPassword: "ts-new-password-1234" },
      ip: "10.42.0.2",
    });
    expect(noToken.status).toBe(400);
    expect(noToken.errorCode).toBe("TURNSTILE_FAILED");
  });

  it("試行回数の上限で 429（失敗はログイン失敗と同じ枠で数える）", async () => {
    const email = "reset-limit@example.com";
    await registerWithCodes(email, "limit-password-1234", "10.43.0.1");
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      const attempt = await call("POST", "/v1/auth/password-reset", {
        body: { email, code: `AAAAAA-BBBBBB-CCCCCC-DDDDD${i}`, newPassword: "limit-new-password-1234" },
        headers: TURNSTILE,
        ip: "10.43.0.2",
      });
      last = attempt.status;
    }
    expect(last).toBe(429);
  });

  it("利用停止中のアカウントは再設定できない（正しいコードでのみ状態を返す）", async () => {
    const email = "reset-suspended@example.com";
    const { accountId, codes } = await registerWithCodes(email, "susp-password-1234", "10.44.0.1");
    await env.DB.prepare("UPDATE accounts SET status = 'suspended' WHERE id = ?").bind(accountId).run();

    // 誤ったコードでは利用停止を明かさない（存在しないメールと同じ RESET_INVALID）
    const wrong = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: "AAAAAA-BBBBBB-CCCCCC-DDDDDD", newPassword: "susp-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.44.0.2",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.errorCode).toBe("RESET_INVALID");

    // 正しいコードでは 403 BANNED。コードは消費されない。
    const banned = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: codes[0]!, newPassword: "susp-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.44.0.3",
    });
    expect(banned.status).toBe(403);
    expect(banned.errorCode).toBe("BANNED");
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM recovery_codes WHERE account_id = ? AND used_at IS NULL",
    )
      .bind(accountId)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(10);

    // 停止が解けたら同じコードで再設定できる
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").bind(accountId).run();
    const ok = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: codes[0]!, newPassword: "susp-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.44.0.4",
    });
    expect(ok.status).toBe(200);
  });

  it("TOTP を設定している人は TOTP を残す（次のログインで TOTP が必要）", async () => {
    const email = "reset-totp@example.com";
    const password = "totp-password-1234";
    const registered = await registerUser(email, password, "TOTP 復旧", "10.45.0.1");
    const cookie = registered.sessionCookie!;
    const setup = await call<{ secret: string }>("POST", "/v1/auth/totp/setup", { cookie, body: {} });
    const secret = setup.data!.secret;
    const enabled = await call<{ recoveryCodes: string[] }>("POST", "/v1/auth/totp/enable", {
      cookie,
      body: { code: await totpCode(secret) },
    });
    const recoveryCode = enabled.data!.recoveryCodes[0]!;

    const reset = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: recoveryCode, newPassword: "totp-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.45.0.2",
    });
    expect(reset.status).toBe(200);

    // TOTP は残っている
    const totpRow = await env.DB.prepare("SELECT verified FROM account_totp WHERE account_id = ?")
      .bind(registered.data!.account.id)
      .first<{ verified: number }>();
    expect(totpRow?.verified).toBe(1);

    // 復旧コードだけではログインできない（TOTP が要る）
    expect((await loginUser(email, "totp-new-password-1234", undefined, "10.45.0.3")).status).toBe(401);
    const withTotp = await loginUser(email, "totp-new-password-1234", await totpCode(secret), "10.45.0.4");
    expect(withTotp.status).toBe(200);
  });

  it("メールの大文字・小文字を変えても対象単位の試行制限を迂回できない（照合と同じ正規化）", async () => {
    const email = "reset-case@example.com";
    const mixed = "Reset-Case@Example.COM";
    await registerWithCodes(email, "case-password-1234", "10.47.0.1");

    // 大文字違いでも同じアカウントを引ける（既存のログインを壊さない）
    const login = await loginUser(mixed, "case-password-1234", undefined, "10.47.0.2");
    expect(login.status).toBe(200);

    // 誤ったコードを大文字違いのメールで 10 回。IP は毎回変えてログイン枠を避け、
    // 対象単位の枠だけが共有されることを確かめる。
    const variants = [email, mixed, "RESET-CASE@example.com"];
    for (let i = 0; i < 10; i += 1) {
      const attempt = await call("POST", "/v1/auth/password-reset", {
        body: {
          email: variants[i % variants.length]!,
          code: `AAAAAA-BBBBBB-CCCCCC-DDDDD${i}`,
          newPassword: "case-new-password-1234",
        },
        headers: TURNSTILE,
        ip: `10.47.1.${i + 1}`,
      });
      expect(attempt.status).toBe(400);
      expect(attempt.errorCode).toBe("RESET_INVALID");
    }
    const blocked = await call("POST", "/v1/auth/password-reset", {
      body: { email, code: "AAAAAA-BBBBBB-CCCCCC-DDDDDD", newPassword: "case-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.47.2.1",
    });
    expect(blocked.status).toBe(429);
  });

  it("復旧コードの作成・作り直しは再認証が必要（TOTP 未設定なら現在のパスワード）", async () => {
    const email = "reset-regen@example.com";
    const password = "regen-password-1234";
    const registered = await registerUser(email, password, "復旧作成", "10.46.0.1");
    const cookie = registered.sessionCookie!;

    expect((await call("POST", "/v1/auth/recovery-codes/regenerate", { body: {} })).status).toBe(401);
    const noProof = await call("POST", "/v1/auth/recovery-codes/regenerate", { cookie, body: {} });
    expect(noProof.status).toBe(403);
    expect(noProof.errorCode).toBe("STEP_UP_REQUIRED");
    const wrongPassword = await call("POST", "/v1/auth/recovery-codes/regenerate", {
      cookie,
      body: { password: "wrong-password-1234" },
    });
    expect(wrongPassword.status).toBe(400);
    const created = await call<{ recoveryCodes: string[] }>("POST", "/v1/auth/recovery-codes/regenerate", {
      cookie,
      body: { password },
    });
    expect(created.status).toBe(200);
    expect(created.data?.recoveryCodes).toHaveLength(10);
  });
});

describe("運営による再設定 URL（②）", () => {
  it("所有者 + step-up で発行し、ハッシュだけを保存し、1 回使うと全セッションが失効する", async () => {
    const email = "operator-target@example.com";
    const oldPassword = "operator-old-1234";
    const user = await registerWithCodes(email, oldPassword, "10.50.0.1");
    const userSession = await loginUser(email, oldPassword, undefined, "10.50.0.2");
    const userCookie = userSession.sessionCookie!;

    await stepUp(owner.cookie, owner.secret);
    const issued = await call<{
      id: string;
      accountId: string;
      email: string;
      token: string;
      url: string;
      mailtoUrl: string;
      expiresAt: number;
    }>("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.50.0.3",
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(issued.data!.token).toMatch(/^oc_pwr_/);
    expect(issued.data!.url).toContain("/account/password-reset/confirm?token=");
    expect(issued.data!.mailtoUrl.startsWith("mailto:")).toBe(true);
    expect(issued.data!.email).toBe(email);

    // DB には生トークンを保存しない（SHA-256 ハッシュのみ）
    const row = await env.DB.prepare("SELECT token_hash FROM password_reset_tokens WHERE id = ?")
      .bind(issued.data!.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(issued.data!.token);
    expect(row?.token_hash).toBe(await sha256Hex(issued.data!.token));

    const consumed = await call<{ reset: boolean }>("POST", "/v1/auth/password-reset/operator", {
      body: { token: issued.data!.token, newPassword: "operator-new-1234" },
      headers: TURNSTILE,
      ip: "10.50.0.4",
    });
    expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);
    expect(consumed.data?.reset).toBe(true);
    expect(await isAuthenticated(userCookie)).toBe(false);
    expect((await loginUser(email, oldPassword, undefined, "10.50.0.5")).status).toBe(401);
    expect((await loginUser(email, "operator-new-1234", undefined, "10.50.0.6")).status).toBe(200);

    // 使用済み URL の再利用は不可
    const reuse = await call("POST", "/v1/auth/password-reset/operator", {
      body: { token: issued.data!.token, newPassword: "operator-reuse-1234" },
      headers: TURNSTILE,
      ip: "10.50.0.7",
    });
    expect(reuse.status).toBe(400);
    expect(reuse.errorCode).toBe("RESET_INVALID");

    // 監査ログ
    const audits = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE target = ? AND action IN ('admin.password_reset_issued', 'auth.password_reset_operator')",
    )
      .bind(user.accountId)
      .all<{ action: string }>();
    const actions = audits.results.map((entry) => entry.action).sort();
    expect(actions).toContain("admin.password_reset_issued");
    expect(actions).toContain("auth.password_reset_operator");
  });

  it("発行は所有者だけ・step-up 必須。所有者/特別管理人には発行できない", async () => {
    const email = "operator-perm@example.com";
    const user = await registerWithCodes(email, "perm-password-1234", "10.51.0.1");

    // 一般ユーザーは発行できない
    const asUser = await call("POST", "/v1/admin/password-resets", {
      cookie: user.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.51.0.2",
    });
    expect(asUser.status).toBe(403);

    // step-up が無ければ 403 STEP_UP_REQUIRED
    await env.DB.prepare("DELETE FROM session_stepup").run();
    const noStepUp = await call("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.51.0.3",
    });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.errorCode).toBe("STEP_UP_REQUIRED");

    await stepUp(owner.cookie, owner.secret);
    // 所有者自身には発行できない
    const toOwner = await call("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: owner.accountId },
      headers: TURNSTILE,
      ip: "10.51.0.4",
    });
    expect(toOwner.status).toBe(403);

    // 特別管理人には発行できない
    const specialAdminId = "01JG0RESETSPECIALADMIN0000";
    await env.DB.prepare(
      "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, NULL, 'special_admin', 'active', ?)",
    )
      .bind(specialAdminId, "特別管理人", "operator-special@example.com", Math.floor(Date.now() / 1000))
      .run();
    const toSpecial = await call("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: specialAdminId },
      headers: TURNSTILE,
      ip: "10.51.0.5",
    });
    expect(toSpecial.status).toBe(403);
  });

  it("再発行で旧 URL が失効する・手動失効できる", async () => {
    const email = "operator-reissue@example.com";
    const user = await registerWithCodes(email, "reissue-password-1234", "10.52.0.1");
    await stepUp(owner.cookie, owner.secret);

    const first = await call<{ id: string; token: string }>("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.52.0.2",
    });
    expect(first.status).toBe(201);
    const second = await call<{ id: string; token: string }>("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.52.0.3",
    });
    expect(second.status).toBe(201);

    const oldUrl = await call("POST", "/v1/auth/password-reset/operator", {
      body: { token: first.data!.token, newPassword: "reissue-old-1234" },
      headers: TURNSTILE,
      ip: "10.52.0.4",
    });
    expect(oldUrl.status).toBe(400);
    expect(oldUrl.errorCode).toBe("RESET_INVALID");

    // 未使用一覧には新しい 1 件だけ
    const list = await call<{ items: Array<{ id: string }> }>(
      "GET",
      `/v1/admin/password-resets?accountId=${user.accountId}`,
      { cookie: owner.cookie },
    );
    expect(list.status).toBe(200);
    expect(list.data?.items.map((item) => item.id)).toEqual([second.data!.id]);

    // 手動失効すると使えない
    const revoked = await call("POST", `/v1/admin/password-resets/${second.data!.id}/revoke`, {
      cookie: owner.cookie,
    });
    expect(revoked.status).toBe(200);
    const revokedAgain = await call("POST", `/v1/admin/password-resets/${second.data!.id}/revoke`, {
      cookie: owner.cookie,
    });
    expect(revokedAgain.status).toBe(404);
    const afterRevoke = await call("POST", "/v1/auth/password-reset/operator", {
      body: { token: second.data!.token, newPassword: "reissue-new-1234" },
      headers: TURNSTILE,
      ip: "10.52.0.5",
    });
    expect(afterRevoke.status).toBe(400);
  });

  it("期限切れ URL は使えない（使用済み・失効と同じ案内）", async () => {
    const email = "operator-expired@example.com";
    const user = await registerWithCodes(email, "expired-password-1234", "10.53.0.1");
    await stepUp(owner.cookie, owner.secret);
    const issued = await call<{ id: string; token: string }>("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.53.0.2",
    });
    expect(issued.status).toBe(201);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE password_reset_tokens SET expires_at = ? WHERE id = ?")
      .bind(now - 1, issued.data!.id)
      .run();
    const expired = await call("POST", "/v1/auth/password-reset/operator", {
      body: { token: issued.data!.token, newPassword: "expired-new-1234" },
      headers: TURNSTILE,
      ip: "10.53.0.3",
    });
    expect(expired.status).toBe(400);
    expect(expired.errorCode).toBe("RESET_INVALID");
  });

  it("ロボット確認は必須・推測したトークンは同じ案内", async () => {
    const noToken = await call("POST", "/v1/auth/password-reset/operator", {
      body: { token: "oc_pwr_unknown-token-value-for-test", newPassword: "unknown-new-1234" },
      ip: "10.54.0.1",
    });
    expect(noToken.status).toBe(400);
    expect(noToken.errorCode).toBe("TURNSTILE_FAILED");

    const unknown = await call("POST", "/v1/auth/password-reset/operator", {
      body: { token: "oc_pwr_unknown-token-value-for-test", newPassword: "unknown-new-1234" },
      headers: TURNSTILE,
      ip: "10.54.0.2",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.errorCode).toBe("RESET_INVALID");
  });

  it("発行後に特別管理人へ昇格したアカウントには古い URL を使えない", async () => {
    const email = "operator-promoted@example.com";
    const user = await registerWithCodes(email, "promote-password-1234", "10.55.0.1");
    await stepUp(owner.cookie, owner.secret);
    const issued = await call<{ token: string }>("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.55.0.2",
    });
    expect(issued.status).toBe(201);
    await env.DB.prepare("UPDATE accounts SET role = 'special_admin' WHERE id = ?").bind(user.accountId).run();
    const refused = await call("POST", "/v1/auth/password-reset/operator", {
      body: { token: issued.data!.token, newPassword: "promote-new-1234" },
      headers: TURNSTILE,
      ip: "10.55.0.3",
    });
    expect(refused.status).toBe(403);
  });

  it("URL での再設定の成功応答にメール・ID などの個人情報を含めない", async () => {
    const email = "operator-pii@example.com";
    const user = await registerWithCodes(email, "pii-password-1234", "10.56.0.1");
    await stepUp(owner.cookie, owner.secret);
    const issued = await call<{ token: string }>("POST", "/v1/admin/password-resets", {
      cookie: owner.cookie,
      body: { accountId: user.accountId },
      headers: TURNSTILE,
      ip: "10.56.0.2",
    });
    expect(issued.status).toBe(201);
    const consumed = await call<{ reset: boolean; accountName: string }>("POST", "/v1/auth/password-reset/operator", {
      body: { token: issued.data!.token, newPassword: "pii-new-password-1234" },
      headers: TURNSTILE,
      ip: "10.56.0.3",
    });
    expect(consumed.status).toBe(200);
    // 画面が必要とする表示名だけ（メール・ID・ロール・アカウント DTO は返さない）
    expect(consumed.data).toEqual({ reset: true, accountName: "復旧テスト" });
    const text = JSON.stringify(consumed.body);
    expect(text).not.toContain(email);
    expect(text).not.toContain(user.accountId);
    expect(text).not.toContain('"account"');
  });

  it("公開サイト情報に運営の連絡先を出す（未設定なら null）", async () => {
    await setSiteSetting("site.operator_contact", "");
    const empty = await call<{ operatorContact: string | null }>("GET", "/v1/meta/site");
    expect(empty.status).toBe(200);
    expect(empty.data?.operatorContact).toBeNull();

    await stepUp(owner.cookie, owner.secret);
    const updated = await call("PUT", "/v1/admin/site-config", {
      cookie: owner.cookie,
      body: { "site.operator_contact": "support@example.com" },
    });
    expect(updated.status).toBe(200);
    const info = await call<{ operatorContact: string | null }>("GET", "/v1/meta/site");
    expect(info.data?.operatorContact).toBe("support@example.com");
  });
});