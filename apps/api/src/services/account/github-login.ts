// GitHub OAuth ログイン（未認証）。
// 連携（WP4 の /v1/github/oauth/*、要ログイン）と同じ OAuth App / state / PKCE を使い、
// 確認済みメールから「既存メールへの紐付け」または「新規アカウント作成」を行ってセッションを発行する。
// トークンの保存は WP4 の saveGithubLink に委譲する（暗号化・スコープ・レート情報の一元化）。

import {
  ApiError,
  ErrorCode,
  ulid,
  GITHUB_API_BASE,
  GITHUB_OAUTH_AUTHORIZE_URL,
  GITHUB_OAUTH_SCOPES,
  type Account,
} from "shared";
import type { Env } from "../../lib/env";
import { baseUrlOf, readWp4Secrets } from "../env-secrets";
import {
  createOAuthState,
  exchangeOAuthCode,
  isOAuthConfigured,
  resolveOAuthRedirectUri,
  verifyOAuthState,
} from "../github/oauth";
import { fetchGithubUser, fetchRateForToken, saveGithubLink } from "../github/service";
import { createSession } from "./session";
import { accountDto, getAccountRow } from "./view";

/** ログイン用 state を連携用 state と取り違えないための予約 accountId（ULID とは衝突しない）。 */
const LOGIN_STATE_ACCOUNT = "__github_login__";

/** ログインでは確認済みメールの取得が必要なため、連携スコープに user:email を足す。 */
const LOGIN_SCOPES = [...GITHUB_OAUTH_SCOPES, "user:email"];

export interface GithubLoginStartResult {
  authorizeUrl: string;
  state: string;
}

export function githubLoginAvailable(env: Env): boolean {
  return isOAuthConfigured(env);
}

/** 認可画面 URL を発行する（未認証）。redirect_uri は連携と同じ web の /account/github。 */
export async function startGithubLogin(env: Env, requestUrl: string): Promise<GithubLoginStartResult> {
  if (!isOAuthConfigured(env)) {
    throw new ApiError(
      500,
      ErrorCode.MISCONFIGURED,
      "GitHub OAuth App が未設定です（GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）",
    );
  }
  const redirectUri = resolveOAuthRedirectUri(env, requestUrl);
  const { state, challenge } = await createOAuthState(env, { accountId: LOGIN_STATE_ACCOUNT, redirectUri });
  const clientId = readWp4Secrets(env).GITHUB_CLIENT_ID;
  if (!clientId) throw new ApiError(500, ErrorCode.MISCONFIGURED, "GITHUB_CLIENT_ID が未設定です");

  const url = new URL(baseUrlOf(env, "GITHUB_OAUTH_AUTHORIZE_URL", GITHUB_OAUTH_AUTHORIZE_URL));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", LOGIN_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "true");
  return { authorizeUrl: url.toString(), state };
}

interface GithubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

/** トークンに紐づく確認済みメール（primary 優先）。取得できない場合は null。 */
async function fetchGithubPrimaryEmail(env: Env, token: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${baseUrlOf(env, "GITHUB_API_BASE", GITHUB_API_BASE)}/user/emails`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "open-clone/1.0",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const list = (await response.json().catch(() => null)) as GithubEmail[] | null;
  if (!Array.isArray(list)) return null;
  const primary = list.find((item) => item.primary === true && item.verified === true && item.email);
  const verified = list.find((item) => item.verified === true && item.email);
  return (primary ?? verified)?.email ?? null;
}

export interface GithubLoginOptions {
  code: string;
  state: string;
  userAgent?: string | null;
}

export interface GithubLoginOutcome {
  account: Account;
  expiresAt: number;
  created: boolean;
  linkedExisting: boolean;
  githubLogin: string;
  /** Cookie 設定用（レスポンスには含めない） */
  token: string;
}

/**
 * 認可コードを検証してログインする。
 * - 連携済み GitHub ユーザー → そのサイトアカウント
 * - 未連携 + 確認済みメールがサイトに存在 → そのアカウントへ紐付けてログイン
 * - 未連携 + メール未登録 → 新規アカウント作成（パスワードなし。以後は GitHub ログイン）
 */
export async function completeGithubLogin(
  env: Env,
  options: GithubLoginOptions,
): Promise<GithubLoginOutcome> {
  const verified = await verifyOAuthState(env, options.state);
  if (verified.accountId !== LOGIN_STATE_ACCOUNT) {
    throw ApiError.validation("この state は GitHub ログイン用ではありません");
  }

  const tokens = await exchangeOAuthCode(env, {
    code: options.code,
    verifier: verified.verifier,
    redirectUri: verified.redirectUri,
  });
  const profile = await fetchGithubUser(env, tokens.token);
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const linked = await db
    .prepare("SELECT account_id FROM github_links WHERE github_user_id = ?")
    .bind(profile.id)
    .first<{ account_id: string }>();

  let accountId = linked?.account_id ?? null;
  let created = false;
  let linkedExisting = false;

  if (!accountId) {
    const email = await fetchGithubPrimaryEmail(env, tokens.token);
    if (!email) {
      throw new ApiError(
        400,
        ErrorCode.VALIDATION,
        "GitHub の確認済みメールアドレスを取得できませんでした。メールでログインし、/account/github から連携してください",
      );
    }
    const existing = await db
      .prepare("SELECT id FROM accounts WHERE LOWER(email) = LOWER(?)")
      .bind(email)
      .first<{ id: string }>();
    if (existing) {
      accountId = existing.id;
      linkedExisting = true;
    } else {
      accountId = ulid();
      const name = (profile.name ?? profile.login).trim().slice(0, 64) || profile.login;
      await db.batch([
        db
          .prepare(
            "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, NULL, 'user', 'active', ?)",
          )
          .bind(accountId, name, email, now),
        db.prepare("INSERT INTO account_profiles (account_id, bio, updated_at) VALUES (?, '', ?)").bind(accountId, now),
      ]);
      created = true;
    }
    const rate = await fetchRateForToken(env, tokens.token);
    await saveGithubLink(env, {
      accountId,
      token: tokens.token,
      login: profile.login,
      userId: profile.id,
      avatarUrl: profile.avatarUrl,
      scopes: tokens.scopes.length > 0 ? tokens.scopes : profile.scopes,
      method: "oauth",
      rate,
    });
  }

  const row = await getAccountRow(db, accountId);
  if (!row) throw new Error("GitHub ログイン後のアカウント取得に失敗しました");
  if (row.status !== "active") {
    throw new ApiError(403, ErrorCode.BANNED, "このアカウントは利用停止中です");
  }

  const session = await createSession(db, row.id, options.userAgent ?? null);
  return {
    account: accountDto(row),
    expiresAt: session.expiresAt,
    created,
    linkedExisting,
    githubLogin: profile.login,
    token: session.token,
  };
}