// WP6: GitHub OAuth ログイン（未認証）の統合テスト。
// 観点: 認可 URL（PKCE/state/scope）、確認済みメールでの新規作成、既存メールへの紐付け、
//       連携済み GitHub ユーザーの再ログイン、連携用 state の流用拒否、メール未取得時の拒否。

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { network } from "./network";
import { call, countRows, registerUser } from "./wp6-helpers";
import { createOAuthState } from "../src/services/github/oauth";

const GITHUB_USER_ID = 777001;

interface LoginStart {
  authorizeUrl: string;
  state: string;
}

interface LoginResult {
  account: { id: string; email: string | null; role: string };
  expiresAt: number;
  created: boolean;
  linkedExisting: boolean;
  githubLogin: string;
}

function mockGithub(options: { email?: string | null; login?: string; userId?: number } = {}) {
  const login = options.login ?? "octo-e2e";
  const userId = options.userId ?? GITHUB_USER_ID;
  const email = options.email === undefined ? "octo@example.com" : options.email;
  network.use(
    http.post("https://github.com/login/oauth/access_token", async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("code") === "bad-code") {
        return HttpResponse.json({ error: "bad_verification_code" });
      }
      return HttpResponse.json({
        access_token: "gho_login_test_token",
        token_type: "bearer",
        scope: "gist,public_repo,user:email",
      });
    }),
    http.get("https://api.github.com/user", () =>
      HttpResponse.json(
        { login, id: userId, avatar_url: `https://avatars.githubusercontent.com/u/${userId}`, name: "Octo E2E" },
        { headers: { "x-oauth-scopes": "gist, public_repo, user:email" } },
      ),
    ),
    http.get("https://api.github.com/user/emails", () =>
      HttpResponse.json(email ? [{ email, primary: true, verified: true }] : []),
    ),
    http.get("https://api.github.com/rate_limit", () =>
      HttpResponse.json({
        resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } },
      }),
    ),
  );
}

async function startLogin(): Promise<LoginStart> {
  const started = await call<LoginStart>("GET", "/v1/auth/github/start");
  expect(started.status).toBe(200);
  return started.data!;
}

describe("GitHub OAuth ログイン", () => {
  it("認可 URL は PKCE/state と user:email スコープを含み、確認済みメールで新規アカウントを作成する", async () => {
    mockGithub({ email: "octo-new@example.com", userId: 777001 });
    const started = await startLogin();
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-github-client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/account/github");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["public_repo", "gist", "user:email"]),
    );

    const loggedIn = await call<LoginResult>("POST", "/v1/auth/github/callback", {
      body: { code: "good-code", state: started.state },
    });
    expect(loggedIn.status).toBe(200);
    expect(loggedIn.data?.created).toBe(true);
    expect(loggedIn.data?.linkedExisting).toBe(false);
    expect(loggedIn.data?.account.email).toBe("octo-new@example.com");
    expect(loggedIn.data?.account.role).toBe("user");
    expect(loggedIn.data?.githubLogin).toBe("octo-e2e");
    expect(loggedIn.sessionCookie).toMatch(/^oc_sess=/);

    const session = await call<{ authenticated: boolean; account: { id: string } }>("GET", "/v1/auth/session", {
      cookie: loggedIn.sessionCookie,
    });
    expect(session.data?.authenticated).toBe(true);
    expect(session.data?.account.id).toBe(loggedIn.data!.account.id);

    expect(await countRows("SELECT COUNT(*) AS n FROM github_links WHERE github_user_id = ?", GITHUB_USER_ID)).toBe(1);
    expect(
      await countRows("SELECT COUNT(*) AS n FROM github_links WHERE account_id = ?", loggedIn.data!.account.id),
    ).toBe(1);
  });

  it("既存メールのアカウントへ紐付けてログインし、再ログインでは同じアカウントを返す", async () => {
    mockGithub({ email: "existing@example.com", userId: 777002 });
    const existing = await registerUser("existing@example.com", "password-1234", "既存ユーザー", "10.20.0.1");
    expect(existing.status).toBe(201);
    const existingId = existing.data!.account.id;

    const first = await startLogin();
    const linked = await call<LoginResult>("POST", "/v1/auth/github/callback", {
      body: { code: "good-code", state: first.state },
    });
    expect(linked.status).toBe(200);
    expect(linked.data?.created).toBe(false);
    expect(linked.data?.linkedExisting).toBe(true);
    expect(linked.data?.account.id).toBe(existingId);

    // 同じ GitHub ユーザーで再度ログイン（state は毎回新規）
    const second = await startLogin();
    const again = await call<LoginResult>("POST", "/v1/auth/github/callback", {
      body: { code: "good-code", state: second.state },
    });
    expect(again.status).toBe(200);
    expect(again.data?.created).toBe(false);
    expect(again.data?.linkedExisting).toBe(false);
    expect(again.data?.account.id).toBe(existingId);
    expect(await countRows("SELECT COUNT(*) AS n FROM accounts WHERE email = ?", "existing@example.com")).toBe(1);
  });

  it("連携用 state（accountId 付き）をログインに流用できない", async () => {
    mockGithub();
    const account = await registerUser("link-state@example.com", "password-1234", "連携ユーザー", "10.20.0.2");
    const linkState = await createOAuthState(env, {
      accountId: account.data!.account.id,
      redirectUri: "http://localhost:3000/account/github",
    });
    const rejected = await call("POST", "/v1/auth/github/callback", {
      body: { code: "good-code", state: linkState.state },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.errorCode).toBe("VALIDATION");
  });

  it("確認済みメールが取得できない場合はアカウントを作らず 400", async () => {
    mockGithub({ email: null, userId: 777004 });
    const started = await startLogin();
    const rejected = await call("POST", "/v1/auth/github/callback", {
      body: { code: "good-code", state: started.state },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.errorCode).toBe("VALIDATION");
    expect(await countRows("SELECT COUNT(*) AS n FROM accounts WHERE email = ?", "octo-noemail@example.com")).toBe(0);
  });

  it("不正な認可コードは 400（アカウントを作らない）", async () => {
    mockGithub({ userId: 777005 });
    const started = await startLogin();
    const rejected = await call("POST", "/v1/auth/github/callback", {
      body: { code: "bad-code", state: started.state },
    });
    expect(rejected.status).toBe(400);
    expect(await countRows("SELECT COUNT(*) AS n FROM github_links WHERE github_user_id = ?", 777005)).toBe(0);
  });
});