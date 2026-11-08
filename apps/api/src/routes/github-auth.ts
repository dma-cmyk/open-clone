// GitHub 連携（OAuth App Web flow + PKCE / fine-grained PAT 持込み / 連携解除）。
// マウント: `/v1/github/oauth/*` と `/v1/github/link*`（どちらも同じアプリ）。

import { Hono } from "hono";
import { ApiError, ErrorCode, ok, type AppRequestContext, type AuthAccount } from "shared";
import { githubOauthCallbackSchema, githubPatSchema, type GithubLinkStatus } from "shared/schemas/github";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requireAuth } from "../lib/middleware/auth";
import { writeAudit } from "../lib/audit";
import {
  deleteGithubLink,
  fetchGithubUser,
  fetchRateForToken,
  logGithubOp,
  readGithubLinkStatus,
  saveGithubLink,
} from "../services/github/service";
import {
  buildAuthorizeUrl,
  createOAuthState,
  exchangeOAuthCode,
  isOAuthConfigured,
  resolveOAuthRedirectUri,
  verifyOAuthState,
} from "../services/github/oauth";

const app = new Hono<AppEnv>();

function currentAccount(c: { get(key: "reqCtx"): AppRequestContext }): AuthAccount {
  const session = getReqCtx(c).session;
  if (!session) throw ApiError.unauthorized();
  return session.account;
}

async function statusFor(env: AppEnv["Bindings"], accountId: string): Promise<GithubLinkStatus> {
  const row = await readGithubLinkStatus(env, accountId);
  return {
    linked: row !== null,
    login: row?.login ?? null,
    userId: row?.userId ?? null,
    avatarUrl: row?.avatarUrl ?? null,
    method: row?.method ?? null,
    scopes: row?.scopes ?? [],
    linkedAt: row?.linkedAt ?? null,
    rate: row?.rate ?? null,
    oauthAvailable: isOAuthConfigured(env),
  };
}

/** 1 GitHub アカウントを複数のサイトアカウントに紐付けさせない（トークン共有の混乱を防ぐ）。 */
async function assertGithubUserAvailable(
  env: AppEnv["Bindings"],
  githubUserId: number,
  accountId: string,
): Promise<void> {
  const existing = await env.DB.prepare("SELECT account_id FROM github_links WHERE github_user_id = ?")
    .bind(githubUserId)
    .first<{ account_id: string }>();
  if (existing && existing.account_id !== accountId) {
    throw ApiError.conflict("この GitHub アカウントは別のサイトアカウントに連携済みです");
  }
}

// ───────────────────────── 状態 ─────────────────────────

app.get("/", requireAuth, async (c) => {
  const account = currentAccount(c);
  return c.json(ok(await statusFor(c.env, account.id)));
});

// ───────────────────────── OAuth App（state + PKCE） ─────────────────────────

app.get("/start", requireAuth, async (c) => {
  const account = currentAccount(c);
  if (!isOAuthConfigured(c.env)) {
    throw new ApiError(
      500,
      ErrorCode.MISCONFIGURED,
      "GitHub OAuth App が未設定です。fine-grained PAT での連携を使用してください",
    );
  }
  // フロント（web）のオリジンを優先する（API ドメインではなく SPA の /account/github へ戻す）
  const requestUrl = c.req.header("Origin") ?? c.req.url;
  const redirectUri = resolveOAuthRedirectUri(c.env, requestUrl);
  const { state, challenge } = await createOAuthState(c.env, { accountId: account.id, redirectUri });
  const authorizeUrl = buildAuthorizeUrl(c.env, { state, challenge, redirectUri });
  return c.json(ok({ authorizeUrl, state }));
});

app.post("/callback", requireAuth, async (c) => {
  const account = currentAccount(c);
  const input = githubOauthCallbackSchema.parse(await c.req.json());

  const verified = await verifyOAuthState(c.env, input.state);
  if (verified.accountId !== account.id) {
    throw ApiError.forbidden("OAuth state がこのアカウントのものではありません");
  }

  const tokens = await exchangeOAuthCode(c.env, {
    code: input.code,
    verifier: verified.verifier,
    redirectUri: verified.redirectUri,
  });
  const profile = await fetchGithubUser(c.env, tokens.token);
  await assertGithubUserAvailable(c.env, profile.id, account.id);
  const rate = await fetchRateForToken(c.env, tokens.token);

  await saveGithubLink(c.env, {
    accountId: account.id,
    token: tokens.token,
    login: profile.login,
    userId: profile.id,
    avatarUrl: profile.avatarUrl,
    scopes: tokens.scopes.length > 0 ? tokens.scopes : profile.scopes,
    method: "oauth",
    rate,
  });

  await logGithubOp(c.env.DB, {
    accountId: account.id,
    op: "link.oauth",
    ref: profile.login,
    status: "ok",
    detail: { scopes: tokens.scopes },
  });
  await writeAudit(c.env.DB, {
    actorType: account.role === "owner" ? "owner" : account.role === "special_admin" ? "special_admin" : "account",
    actorId: account.id,
    action: "github.link",
    target: profile.login,
    detail: { method: "oauth" },
  });

  return c.json(ok(await statusFor(c.env, account.id)));
});

// ───────────────────────── PAT（fine-grained 持込みフォールバック） ─────────────────────────

app.post("/pat", requireAuth, async (c) => {
  const account = currentAccount(c);
  const input = githubPatSchema.parse(await c.req.json());

  const profile = await fetchGithubUser(c.env, input.token);
  await assertGithubUserAvailable(c.env, profile.id, account.id);
  const rate = await fetchRateForToken(c.env, input.token);

  await saveGithubLink(c.env, {
    accountId: account.id,
    token: input.token,
    login: profile.login,
    userId: profile.id,
    avatarUrl: profile.avatarUrl,
    // fine-grained PAT は x-oauth-scopes を返さないため、空なら未確認として扱う
    scopes: profile.scopes,
    method: "pat",
    rate,
  });

  await logGithubOp(c.env.DB, {
    accountId: account.id,
    op: "link.pat",
    ref: profile.login,
    status: "ok",
    detail: { scopes: profile.scopes },
  });
  await writeAudit(c.env.DB, {
    actorType: account.role === "owner" ? "owner" : account.role === "special_admin" ? "special_admin" : "account",
    actorId: account.id,
    action: "github.link",
    target: profile.login,
    detail: { method: "pat" },
  });

  return c.json(ok(await statusFor(c.env, account.id)));
});

// ───────────────────────── 解除 ─────────────────────────

app.delete("/", requireAuth, async (c) => {
  const account = currentAccount(c);
  const existing = await readGithubLinkStatus(c.env, account.id);
  if (!existing) return c.json(ok(await statusFor(c.env, account.id)));

  await deleteGithubLink(c.env, account.id);
  await logGithubOp(c.env.DB, {
    accountId: account.id,
    op: "link.delete",
    ref: existing.login,
    status: "ok",
  });
  await writeAudit(c.env.DB, {
    actorType: account.role === "owner" ? "owner" : account.role === "special_admin" ? "special_admin" : "account",
    actorId: account.id,
    action: "github.unlink",
    target: existing.login,
  });

  return c.json(ok(await statusFor(c.env, account.id)));
});

export default app;