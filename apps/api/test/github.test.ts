// WP4: GitHub 連携の統合テスト（GitHub API / OAuth トークン交換は MSW でモック）。
// 観点: OAuth state（改竄・期限・アカウント束縛）、トークンの AES-GCM 暗号化保存、PAT 登録、
//       Gist / リポジトリ操作、レート残ガード、監査ログ、未連携 403 + 連携誘導、webhook 署名検証。

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { hmacSha256Hex } from "shared";
import { network } from "./network";
import {
  ORIGIN,
  apiFetch,
  createTestAccount,
  readJson,
  resetWp4State,
  type ApiEnvelope,
  type TestAccount,
} from "./wp4-helpers";
import { decryptSecret, encryptSecret } from "../src/services/github/crypto";
import { buildAuthorizeUrl, createOAuthState, verifyOAuthState } from "../src/services/github/oauth";
import {
  createGist,
  githubClient,
  readGithubLinkStatus,
  resolveGithubConnection,
} from "../src/services/github/service";

const OAUTH_TOKEN = "gho_test_access_token_1234567890";
const PAT = "github_pat_test_1234567890abcdef";

interface LinkStatusData {
  linked: boolean;
  login: string | null;
  userId: number | null;
  method: "oauth" | "pat" | null;
  scopes: string[];
  linkedAt: number | null;
  oauthAvailable: boolean;
  rate: { limit: number; remaining: number; reset: number } | null;
}

interface GistData {
  id: string;
  htmlUrl: string;
  public: boolean;
  files: Array<{ filename: string; size: number; rawUrl: string | null }>;
}

function githubUser(login = "e2e-user", id = 424242) {
  return {
    login,
    id,
    node_id: `node-${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}`,
    name: "E2E User",
    type: "User",
  };
}

function rateLimitBody(remaining = 4999) {
  return {
    resources: {
      core: { limit: 5000, remaining, reset: Math.floor(Date.now() / 1000) + 3600, used: 5000 - remaining },
    },
    rate: { limit: 5000, remaining, reset: Math.floor(Date.now() / 1000) + 3600, used: 5000 - remaining },
  };
}

function gistBody(id = "gist-abc") {
  return {
    id,
    description: "oc test",
    public: false,
    html_url: `https://gist.github.com/e2e-user/${id}`,
    created_at: "2026-11-08T00:00:00Z",
    updated_at: "2026-11-08T00:00:00Z",
    files: {
      "hello.txt": {
        filename: "hello.txt",
        size: 12,
        raw_url: `https://gist.githubusercontent.com/e2e-user/${id}/raw/hello.txt`,
        content: "hello world\n",
      },
    },
  };
}

/** OAuth 用の MSW ハンドラ一式（トークン交換・ユーザー・レート）。 */
function mockGithubOAuth(options: { userLogin?: string; userId?: number } = {}) {
  const calls: string[] = [];
  network.use(
    http.post("https://github.com/login/oauth/access_token", async ({ request }) => {
      calls.push("token");
      const body = new URLSearchParams(await request.text());
      if (body.get("code") === "bad-code") {
        return HttpResponse.json({ error: "bad_verification_code" }, { status: 200 });
      }
      return HttpResponse.json({
        access_token: OAUTH_TOKEN,
        token_type: "bearer",
        scope: "gist,public_repo",
      });
    }),
    http.get("https://api.github.com/user", () =>
      HttpResponse.json(githubUser(options.userLogin, options.userId), {
        headers: { "x-oauth-scopes": "gist, public_repo" },
      }),
    ),
    http.get("https://api.github.com/rate_limit", () => HttpResponse.json(rateLimitBody())),
  );
  return calls;
}

/** 連携済みアカウントを API 経由で作る（PAT フロー）。 */
async function linkWithPat(account: TestAccount): Promise<void> {
  network.use(
    http.get("https://api.github.com/user", () =>
      HttpResponse.json(githubUser(), { headers: { "x-oauth-scopes": "" } }),
    ),
    http.get("https://api.github.com/rate_limit", () => HttpResponse.json(rateLimitBody())),
  );
  const response = await apiFetch("/v1/github/link/pat", { cookie: account.cookie, body: { token: PAT } });
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await resetWp4State();
});

describe("トークン暗号化（AES-256-GCM）", () => {
  it("暗号化→復号で元に戻り、平文を含まない", async () => {
    const encrypted = await encryptSecret(OAUTH_TOKEN, env.ENC_KEY);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain(OAUTH_TOKEN);
    expect(await decryptSecret(encrypted, env.ENC_KEY)).toBe(OAUTH_TOKEN);

    // iv は毎回異なる（同じ平文でも暗号文が違う）
    const again = await encryptSecret(OAUTH_TOKEN, env.ENC_KEY);
    expect(again).not.toBe(encrypted);
  });

  it("改竄・別鍵では復号に失敗する", async () => {
    const encrypted = await encryptSecret(OAUTH_TOKEN, env.ENC_KEY);
    const parts = encrypted.split(":");
    const tampered = [parts[0], parts[1], `${parts[2]!.slice(0, -2)}AA`].join(":");
    await expect(decryptSecret(tampered, env.ENC_KEY)).rejects.toThrow();
    await expect(decryptSecret(encrypted, "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")).rejects.toThrow();
  });
});

describe("OAuth state", () => {
  it("作成した state を検証でき、PKCE verifier が復元される", async () => {
    const created = await createOAuthState(env, {
      accountId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      redirectUri: "http://localhost:3000/account/github",
    });
    expect(created.state).toContain(".");
    expect(created.challenge).not.toBe(created.verifier);

    const verified = await verifyOAuthState(env, created.state);
    expect(verified.accountId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(verified.verifier).toBe(created.verifier);
    expect(verified.redirectUri).toBe("http://localhost:3000/account/github");
  });

  it("署名改竄・期限切れは 400 で拒否する", async () => {
    const created = await createOAuthState(env, {
      accountId: "acct",
      redirectUri: "http://localhost:3000/account/github",
    });
    const [encoded, signature] = created.state.split(".");
    const tampered = `${encoded}.${signature!.slice(0, -2)}AA`;
    await expect(verifyOAuthState(env, tampered)).rejects.toMatchObject({ status: 400 });

    const stale = await createOAuthState(env, {
      accountId: "acct",
      redirectUri: "http://localhost:3000/account/github",
      now: Math.floor(Date.now() / 1000) - 700,
    });
    await expect(verifyOAuthState(env, stale.state)).rejects.toThrow(/有効期限/);
  });

  it("認可 URL に PKCE(S256)・scope・client_id が入る", () => {
    const url = new URL(
      buildAuthorizeUrl(env, {
        state: "state-value",
        challenge: "challenge-value",
        redirectUri: "http://localhost:3000/account/github",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-github-client-id");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")).toBe("public_repo gist");
  });
});

describe("OAuth 連携フロー（モック GitHub）", () => {
  it("start → callback でトークンを暗号化保存し、状態 API が連携済みを返す", async () => {
    const calls = mockGithubOAuth();
    const account = await createTestAccount();

    const start = await apiFetch("/v1/github/oauth/start", { method: "GET", cookie: account.cookie });
    expect(start.status).toBe(200);
    const startBody = await readJson<ApiEnvelope<{ authorizeUrl: string; state: string }>>(start);
    expect(startBody.data!.authorizeUrl).toContain("https://github.com/login/oauth/authorize");
    const { state } = startBody.data!;

    const callback = await apiFetch("/v1/github/oauth/callback", {
      cookie: account.cookie,
      body: { code: "good-code", state },
    });
    expect(callback.status).toBe(200);
    const linked = (await readJson<ApiEnvelope<LinkStatusData>>(callback)).data!;
    expect(linked.linked).toBe(true);
    expect(linked.login).toBe("e2e-user");
    expect(linked.method).toBe("oauth");
    expect(linked.scopes).toEqual(["gist", "public_repo"]);
    expect(linked.rate?.remaining).toBe(4999);
    expect(calls).toContain("token");

    // 平文トークンは D1 に存在せず、復号すると元に戻る
    const row = await env.DB.prepare("SELECT token_enc, method FROM github_links WHERE account_id = ?")
      .bind(account.accountId)
      .first<{ token_enc: string; method: string }>();
    expect(row!.method).toBe("oauth");
    expect(row!.token_enc.startsWith("v1:")).toBe(true);
    expect(row!.token_enc).not.toContain(OAUTH_TOKEN);
    expect(await decryptSecret(row!.token_enc, env.ENC_KEY)).toBe(OAUTH_TOKEN);

    // 監査ログ（github_ops_log）
    const ops = await env.DB.prepare("SELECT op, status FROM github_ops_log WHERE account_id = ? ORDER BY created_at")
      .bind(account.accountId)
      .all<{ op: string; status: string }>();
    expect(ops.results.map((entry) => entry.op)).toContain("link.oauth");
    expect(ops.results.every((entry) => entry.status === "ok")).toBe(true);

    // state の再利用はできない（別アカウントで使うと 403）
    const other = await createTestAccount();
    const replay = await apiFetch("/v1/github/oauth/callback", {
      cookie: other.cookie,
      body: { code: "good-code", state },
    });
    expect(replay.status).toBe(403);
  });

  it("不正な認可コードは 400、同じ GitHub ユーザーの二重連携は 409", async () => {
    mockGithubOAuth();
    const account = await createTestAccount();
    const start = await readJson<ApiEnvelope<{ state: string }>>(
      await apiFetch("/v1/github/oauth/start", { method: "GET", cookie: account.cookie }),
    );
    const bad = await apiFetch("/v1/github/oauth/callback", {
      cookie: account.cookie,
      body: { code: "bad-code", state: start.data!.state },
    });
    expect(bad.status).toBe(400);

    const start2 = await readJson<ApiEnvelope<{ state: string }>>(
      await apiFetch("/v1/github/oauth/start", { method: "GET", cookie: account.cookie }),
    );
    const ok = await apiFetch("/v1/github/oauth/callback", {
      cookie: account.cookie,
      body: { code: "good-code", state: start2.data!.state },
    });
    expect(ok.status).toBe(200);

    const other = await createTestAccount();
    const start3 = await readJson<ApiEnvelope<{ state: string }>>(
      await apiFetch("/v1/github/oauth/start", { method: "GET", cookie: other.cookie }),
    );
    const conflict = await apiFetch("/v1/github/oauth/callback", {
      cookie: other.cookie,
      body: { code: "good-code", state: start3.data!.state },
    });
    expect(conflict.status).toBe(409);
  });

  it("未認証の start は 401", async () => {
    const response = await apiFetch("/v1/github/oauth/start", { method: "GET" });
    expect(response.status).toBe(401);
  });
});

describe("PAT 連携", () => {
  it("PAT を登録すると暗号化保存され、解除で消える", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);

    const status = await readJson<ApiEnvelope<LinkStatusData>>(
      await apiFetch("/v1/github/link", { method: "GET", cookie: account.cookie }),
    );
    expect(status.data!.linked).toBe(true);
    expect(status.data!.method).toBe("pat");
    expect(status.data!.login).toBe("e2e-user");

    const row = await env.DB.prepare("SELECT token_enc FROM github_links WHERE account_id = ?")
      .bind(account.accountId)
      .first<{ token_enc: string }>();
    expect(row!.token_enc).not.toContain(PAT);
    expect(await decryptSecret(row!.token_enc, env.ENC_KEY)).toBe(PAT);

    const unlink = await apiFetch("/v1/github/link", { method: "DELETE", cookie: account.cookie });
    expect(unlink.status).toBe(200);
    expect((await readJson<ApiEnvelope<LinkStatusData>>(unlink)).data!.linked).toBe(false);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM github_links WHERE account_id = ?")
      .bind(account.accountId)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("無効なトークンは 400、短すぎる形式は 400", async () => {
    const account = await createTestAccount();
    network.use(http.get("https://api.github.com/user", () => new HttpResponse("bad credentials", { status: 401 })));
    const invalid = await apiFetch("/v1/github/link/pat", { cookie: account.cookie, body: { token: PAT } });
    expect(invalid.status).toBe(400);

    const tooShort = await apiFetch("/v1/github/link/pat", { cookie: account.cookie, body: { token: "short" } });
    expect(tooShort.status).toBe(400);
  });
});

describe("未連携ユーザー", () => {
  it("Gist 操作は 403 + 連携誘導 details", async () => {
    const account = await createTestAccount();
    const response = await apiFetch("/v1/github/files/gists", { cookie: account.cookie, body: {} });
    expect(response.status).toBe(403);
    const body = await readJson<ApiEnvelope<unknown>>(response);
    expect(body.code).toBe("FORBIDDEN");
    expect(body.details).toMatchObject({ linkRequired: true, linkUrl: "/account/github" });
  });

  it("サービス層の resolveGithubConnection も連携誘導する", async () => {
    const account = await createTestAccount();
    await expect(resolveGithubConnection(env, account.accountId)).rejects.toMatchObject({ status: 403 });
  });
});

describe("Gist / リポジトリ操作（連携済み）", () => {
  it("Gist を作成し、監査ログに記録する", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);
    let captured: Record<string, unknown> | null = null;
    network.use(
      http.post("https://api.github.com/gists", async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(gistBody(), { status: 201 });
      }),
    );

    const response = await apiFetch("/v1/github/files/gists", {
      cookie: account.cookie,
      body: {
        description: "oc test",
        public: false,
        files: { "hello.txt": { content: "hello world\n" } },
      },
    });
    expect(response.status).toBe(201);
    const gist = (await readJson<ApiEnvelope<GistData>>(response)).data!;
    expect(gist.id).toBe("gist-abc");
    expect(gist.htmlUrl).toBe("https://gist.github.com/e2e-user/gist-abc");
    expect(gist.files[0]!.filename).toBe("hello.txt");
    expect(captured).toMatchObject({ public: false, files: { "hello.txt": { content: "hello world\n" } } });

    const op = await env.DB.prepare(
      "SELECT op, status, ref FROM github_ops_log WHERE account_id = ? AND op = 'gist.create'",
    )
      .bind(account.accountId)
      .first<{ op: string; status: string; ref: string | null }>();
    expect(op!.status).toBe("ok");
  });

  it("Gist の一覧・更新・削除が通り、全て監査ログに残る", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);
    let patched: Record<string, unknown> | null = null;
    network.use(
      http.get("https://api.github.com/gists", () =>
        HttpResponse.json([gistBody("gist-1"), gistBody("gist-2")]),
      ),
      http.patch("https://api.github.com/gists/gist-1", async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(gistBody("gist-1"));
      }),
      http.delete("https://api.github.com/gists/gist-2", () => new HttpResponse(null, { status: 204 })),
      http.get("https://api.github.com/gists/gist-1", () => HttpResponse.json(gistBody("gist-1"))),
    );

    const list = await readJson<ApiEnvelope<{ items: Array<{ id: string }> }>>(
      await apiFetch("/v1/github/files/gists", { method: "GET", cookie: account.cookie }),
    );
    expect(list.data!.items.map((item) => item.id)).toEqual(["gist-1", "gist-2"]);

    const updated = await apiFetch("/v1/github/files/gists/gist-1", {
      method: "PATCH",
      cookie: account.cookie,
      body: { description: "renamed", files: { "hello.txt": { content: "updated" }, "old.txt": null } },
    });
    expect(updated.status).toBe(200);
    expect(patched).toMatchObject({ description: "renamed", files: { "hello.txt": { content: "updated" }, "old.txt": null } });

    const single = await readJson<ApiEnvelope<{ id: string; files: Array<{ filename: string }> }>>(
      await apiFetch("/v1/github/files/gists/gist-1", { method: "GET", cookie: account.cookie }),
    );
    expect(single.data!.id).toBe("gist-1");
    expect(single.data!.files[0]!.filename).toBe("hello.txt");

    const deleted = await apiFetch("/v1/github/files/gists/gist-2", { method: "DELETE", cookie: account.cookie });
    expect(deleted.status).toBe(200);

    const ops = await env.DB.prepare(
      "SELECT op FROM github_ops_log WHERE account_id = ? AND op IN ('gist.list','gist.update','gist.delete','gist.get')",
    )
      .bind(account.accountId)
      .all<{ op: string }>();
    expect(ops.results.map((entry) => entry.op)).toEqual(
      expect.arrayContaining(["gist.list", "gist.update", "gist.delete", "gist.get"]),
    );
  });

  it("Gist の 1MB 超は送信前に 400 で拒否する", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);
    let called = false;
    network.use(
      http.post("https://api.github.com/gists", () => {
        called = true;
        return HttpResponse.json(gistBody(), { status: 201 });
      }),
    );
    const big = "a".repeat(1024 * 1024 + 1);
    const response = await apiFetch("/v1/github/files/gists", {
      cookie: account.cookie,
      body: { public: false, files: { "big.txt": { content: big } } },
    });
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("レート残が安全マージン以下なら 429 で停止し、上流を呼ばない", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);
    await env.DB.prepare(
      "UPDATE github_links SET rate_limit = 5000, rate_remaining = 5, rate_reset = ? WHERE account_id = ?",
    )
      .bind(Math.floor(Date.now() / 1000) + 3600, account.accountId)
      .run();

    let called = false;
    network.use(
      http.post("https://api.github.com/gists", () => {
        called = true;
        return HttpResponse.json(gistBody(), { status: 201 });
      }),
    );
    const response = await apiFetch("/v1/github/files/gists", {
      cookie: account.cookie,
      body: { public: false, files: { "a.txt": { content: "x" } } },
    });
    expect(response.status).toBe(429);
    expect(called).toBe(false);
    const blocked = await env.DB.prepare(
      "SELECT status FROM github_ops_log WHERE account_id = ? AND status = 'blocked' ORDER BY created_at DESC",
    )
      .bind(account.accountId)
      .first<{ status: string }>();
    expect(blocked!.status).toBe("blocked");
  });

  it("リポジトリへコンテンツを base64 で push し、取得できる", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);
    const base64 = Buffer.from("export const x = 1;\n", "utf8").toString("base64");
    let putBody: Record<string, unknown> | null = null;

    network.use(
      http.put("https://api.github.com/repos/e2e-user/demo/contents/src/x.ts", async ({ request }) => {
        putBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            content: {
              sha: "newsha",
              size: 19,
              path: "src/x.ts",
              html_url: "https://github.com/e2e-user/demo/blob/main/src/x.ts",
            },
            commit: { sha: "commit-sha" },
          },
          { status: 201 },
        );
      }),
      http.get("https://api.github.com/repos/e2e-user/demo/contents/src/x.ts", () =>
        HttpResponse.json({ sha: "newsha", size: 19, path: "src/x.ts", encoding: "base64", content: base64 }),
      ),
      http.get("https://api.github.com/user/repos", () =>
        HttpResponse.json([
          {
            id: 1,
            name: "demo",
            full_name: "e2e-user/demo",
            private: false,
            html_url: "https://github.com/e2e-user/demo",
            default_branch: "main",
            permissions: { push: true },
          },
        ]),
      ),
      http.get("https://api.github.com/rate_limit", () => HttpResponse.json(rateLimitBody())),
    );

    const push = await readJson<ApiEnvelope<{ sha: string; commitSha: string | null }>>(
      await apiFetch("/v1/github/files/repo/e2e-user/demo/content", {
        method: "PUT",
        cookie: account.cookie,
        body: { path: "src/x.ts", content: "export const x = 1;\n", message: "add x" },
      }),
    );
    expect(push.data!.sha).toBe("newsha");
    expect(push.data!.commitSha).toBe("commit-sha");
    expect(putBody).toMatchObject({ message: "add x", content: base64 });

    const file = await readJson<ApiEnvelope<{ content: string | null; sha: string }>>(
      await apiFetch("/v1/github/files/repo/e2e-user/demo/content?path=src%2Fx.ts", {
        method: "GET",
        cookie: account.cookie,
      }),
    );
    expect(file.data!.content).toBe("export const x = 1;\n");

    const repos = await readJson<ApiEnvelope<{ items: Array<{ fullName: string }> }>>(
      await apiFetch("/v1/github/files/repos", { method: "GET", cookie: account.cookie }),
    );
    expect(repos.data!.items[0]!.fullName).toBe("e2e-user/demo");

    const rate = await readJson<ApiEnvelope<{ remaining: number; limit: number }>>(
      await apiFetch("/v1/github/files/rate", { method: "GET", cookie: account.cookie }),
    );
    expect(rate.data!.limit).toBe(5000);
  });

  it("1MB 超のリポジトリ書き込みは 413 で拒否する", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);
    const response = await apiFetch("/v1/github/files/repo/e2e-user/demo/content", {
      method: "PUT",
      cookie: account.cookie,
      body: { path: "big.txt", content: "a".repeat(1024 * 1024 + 1), message: "too big" },
    });
    expect(response.status).toBe(413);
  });

  it("createGist は連携クライアント経由で呼べる（WP3 連携点）", async () => {
    const account = await createTestAccount();
    await linkWithPat(account);
    network.use(
      http.post("https://api.github.com/gists", () => HttpResponse.json(gistBody("g-1"), { status: 201 })),
    );
    const client = await githubClient(env, account.accountId);
    const result = await createGist(client, {
      description: "text attach",
      public: false,
      files: { "note.txt": { content: "hello" } },
    });
    expect(result.id).toBe("g-1");
    expect(await readGithubLinkStatus(env, account.accountId)).not.toBeNull();
  });
});

describe("webhook（運営側 GitHub App・任意）", () => {
  it("正しい署名なら受理し、同じ delivery は重複登録しない", async () => {
    const raw = JSON.stringify({ action: "opened", issue: { number: 1 } });
    const signature = `sha256=${await hmacSha256Hex("test-github-webhook-secret", raw)}`;
    const post = () =>
      SELF.fetch("http://worker.test/v1/github/hooks/github", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "x-hub-signature-256": signature,
          "x-github-delivery": "delivery-1",
          "x-github-event": "issues",
          "content-type": "application/json",
        },
        body: raw,
      });

    const first = await post();
    expect(first.status).toBe(200);
    const body = (await readJson<ApiEnvelope<{ received: boolean; action: string }>>(first)).data!;
    expect(body.received).toBe(true);
    expect(body.action).toBe("opened");

    const second = await post();
    expect(second.status).toBe(200);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM github_webhook_events WHERE delivery_id = ?")
      .bind("delivery-1")
      .first<{ n: number }>();
    expect(rows!.n).toBe(1);
    const op = await env.DB.prepare("SELECT op FROM github_ops_log WHERE op = 'webhook.issues'").first<{ op: string }>();
    expect(op!.op).toBe("webhook.issues");
  });

  it("署名が違えば 401", async () => {
    const response = await SELF.fetch("http://worker.test/v1/github/hooks/github", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "x-hub-signature-256": "sha256=deadbeef",
        "x-github-delivery": "delivery-bad",
        "x-github-event": "issues",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(response.status).toBe(401);
  });
});
