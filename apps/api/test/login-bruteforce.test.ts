// F2: ログインのアカウント（メール）単位の失敗回数による Turnstile 必須化。
// IP を変えながら 15 分に 10 回を超えて失敗すると、以降の試行は IP に関係なく Turnstile が必須になる（アカウントロックはしない）。

import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { network } from "./network";
import { call, loginUser, registerUser, setSiteSetting } from "./wp6-helpers";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VALID_TOKEN = "valid-turnstile-token";

describe("F2: メール単位の失敗回数による Turnstile 必須化", () => {
  beforeEach(async () => {
    await setSiteSetting("security.require_turnstile", "auto");
    network.use(
      http.post(SITEVERIFY, async ({ request }) => {
        const form = await request.formData();
        const token = form.get("response");
        return HttpResponse.json({ success: token === VALID_TOKEN });
      }),
    );
  });

  it("③ IP を変えながら 10 回失敗すると、11 回目は別 IP でも Turnstile 必須になる（大文字・小文字を区別しない）", async () => {
    const email = "bf-target@example.com";
    const registered = await registerUser(email, "correct-pass-1234", "標的", "10.60.0.1");
    expect(registered.status).toBe(201);

    // 10 個の異なる IP から 1 回ずつ失敗させる（IP+メール窓では毎回 failures=0 < 3）
    const variants = [email, "BF-TARGET@example.com", "Bf-Target@Example.COM"];
    for (let i = 0; i < 10; i += 1) {
      const attempt = await loginUser(variants[i % variants.length]!, "wrong-pass", undefined, `10.60.1.${i + 1}`);
      expect(attempt.status, `attempt ${i + 1}`).toBe(401);
      expect(attempt.errorCode).toBe("UNAUTHORIZED");
    }

    // 11 回目は別 IP・正しいパスワードでも Turnstile トークンなしは 400 TURNSTILE_FAILED
    const withoutToken = await loginUser(email, "correct-pass-1234", undefined, "10.60.1.99");
    expect(withoutToken.status).toBe(400);
    expect(withoutToken.errorCode).toBe("TURNSTILE_FAILED");

    // 大文字・小文字を変えても別 IP で Turnstile が必須のまま
    const mixedCaseWithoutToken = await loginUser("BF-Target@example.com", "correct-pass-1234", undefined, "10.60.1.100");
    expect(mixedCaseWithoutToken.status).toBe(400);
    expect(mixedCaseWithoutToken.errorCode).toBe("TURNSTILE_FAILED");

    // 不正な Turnstile トークンも 400 TURNSTILE_FAILED
    const invalidToken = await call("POST", "/v1/auth/login", {
      body: { email, password: "correct-pass-1234" },
      headers: { "x-turnstile-token": "rejected-token" },
      ip: "10.60.1.101",
    });
    expect(invalidToken.status).toBe(400);
    expect(invalidToken.errorCode).toBe("TURNSTILE_FAILED");
  });

  it("④ アカウントロックはせず、正しいパスワードと有効な Turnstile トークンでログインできる", async () => {
    const email = "bf-unlock@example.com";
    const registered = await registerUser(email, "correct-pass-1234", "本人", "10.60.2.1");
    expect(registered.status).toBe(201);

    for (let i = 0; i < 10; i += 1) {
      const attempt = await loginUser(email, "wrong-pass", undefined, `10.60.2.${i + 10}`);
      expect(attempt.status).toBe(401);
    }

    // トークンなしは拒否
    const blocked = await loginUser(email, "correct-pass-1234", undefined, "10.60.2.99");
    expect(blocked.status).toBe(400);
    expect(blocked.errorCode).toBe("TURNSTILE_FAILED");

    // 本人が別 IP から正しいパスワード + 有効な Turnstile トークンで送ればログインできる
    const ok = await call<{ account: { email: string } }>("POST", "/v1/auth/login", {
      body: { email, password: "correct-pass-1234" },
      headers: { "x-turnstile-token": VALID_TOKEN },
      ip: "10.60.2.100",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.data?.account.email).toBe(email);
    expect(ok.sessionCookie).toMatch(/^oc_sess=/);
  });

  it("存在しないメールでも同じように数え、11 回目は別 IP でも Turnstile 必須になる（アカウント有無を漏らさない）", async () => {
    const email = "bf-nonexistent@example.com";

    for (let i = 0; i < 10; i += 1) {
      const attempt = await loginUser(email, "wrong-pass", undefined, `10.60.3.${i + 1}`);
      expect(attempt.status, `attempt ${i + 1}`).toBe(401);
      expect(attempt.errorCode).toBe("UNAUTHORIZED");
    }

    const withoutToken = await loginUser(email, "wrong-pass", undefined, "10.60.3.99");
    expect(withoutToken.status).toBe(400);
    expect(withoutToken.errorCode).toBe("TURNSTILE_FAILED");

    // 有効トークン付きなら既存アカウントのパスワード誤りと同じ 401 UNAUTHORIZED を返す
    const withToken = await call("POST", "/v1/auth/login", {
      body: { email, password: "wrong-pass" },
      headers: { "x-turnstile-token": VALID_TOKEN },
      ip: "10.60.3.100",
    });
    expect(withToken.status).toBe(401);
    expect(withToken.errorCode).toBe("UNAUTHORIZED");
  });

  it("15 分より前の失敗はカウントされず、同一 IP 窓の 429 制限も維持される", async () => {
    const email = "bf-window@example.com";
    expect((await registerUser(email, "correct-pass-1234", "窓確認", "10.60.4.1")).status).toBe(201);

    // 10 回異なる IP から失敗させる
    for (let i = 0; i < 10; i += 1) {
      expect((await loginUser(email, "wrong-pass", undefined, `10.60.4.${i + 10}`)).status).toBe(401);
    }
    expect((await loginUser(email, "correct-pass-1234", undefined, "10.60.4.99")).status).toBe(400);

    // 記録時刻を 15 分以上前（16 分前）に巻き戻すと、別 IP からのトークンなしログインが通る
    const sixteenMinutesAgo = Math.floor(Date.now() / 1000) - 16 * 60;
    await env.DB.prepare("UPDATE auth_attempts SET created_at = ?").bind(sixteenMinutesAgo).run();
    const afterWindow = await loginUser(email, "correct-pass-1234", undefined, "10.60.4.100");
    expect(afterWindow.status).toBe(200);

    // 同一 IP の 10 回上限（429 RATE_LIMITED）も維持される
    const sameIp = "10.60.4.200";
    for (let i = 0; i < 10; i += 1) {
      const attempt = await call("POST", "/v1/auth/login", {
        body: { email, password: "wrong-pass" },
        headers: i >= 3 ? { "x-turnstile-token": VALID_TOKEN } : {},
        ip: sameIp,
      });
      expect(attempt.status, `sameIp ${i + 1}`).toBe(401);
    }
    const rateLimited = await call("POST", "/v1/auth/login", {
      body: { email, password: "correct-pass-1234" },
      headers: { "x-turnstile-token": VALID_TOKEN },
      ip: sameIp,
    });
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.errorCode).toBe("RATE_LIMITED");
  });
});
