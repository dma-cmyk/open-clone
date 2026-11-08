// GitHub OAuth App（Web flow + PKCE）の state とコード交換。
//
// - state は「HMAC 署名付きの自己完結トークン」。payload に accountId・nonce・PKCE verifier（AES-GCM 暗号化）・
//   有効期限・redirect_uri を含めるため、コールバックはセッションと状態だけで検証できる。
// - 認可コードは GitHub 側で単回使用のため、state のリプレイでトークンが二重取得されることはない。
// - client_secret は Worker からのみ送る（ブラウザに露出しない）。

import { ApiError, ErrorCode, hmacSha256Hex, randomToken, sha256, timingSafeEqual } from "shared";
import {
  GITHUB_OAUTH_AUTHORIZE_URL,
  GITHUB_OAUTH_SCOPES,
  GITHUB_OAUTH_STATE_TTL_SECONDS,
  GITHUB_OAUTH_TOKEN_URL,
} from "shared/schemas/github";
import type { Env } from "../../lib/env";
import { baseUrlOf, readWp4Secrets } from "../env-secrets";
import { decryptSecret, encryptSecret } from "./crypto";
import { fromBase64Url, toBase64Url } from "../uploads/util";

interface OAuthStatePayload {
  /** account id */
  a: string;
  /** nonce */
  n: string;
  /** 有効期限（Unix seconds） */
  e: number;
  /** 暗号化した PKCE code_verifier */
  v: string;
  /** 認可時と同じ redirect_uri（GitHub の検証要件） */
  r: string;
}

export interface OAuthStartResult {
  state: string;
  verifier: string;
  challenge: string;
  redirectUri: string;
}

export function isOAuthConfigured(env: Env): boolean {
  const secrets = readWp4Secrets(env);
  return Boolean(secrets.GITHUB_CLIENT_ID && secrets.GITHUB_CLIENT_SECRET);
}

/** OAuth App の callback URI。未設定ならリクエスト元オリジンの `/account/github`（WP6 のルート）。 */
export function resolveOAuthRedirectUri(env: Env, requestUrl: string): string {
  const configured = readWp4Secrets(env).GITHUB_OAUTH_REDIRECT_URI;
  if (configured) return configured;
  return `${new URL(requestUrl).origin}/account/github`;
}

export async function createOAuthState(
  env: Env,
  input: { accountId: string; redirectUri: string; now?: number },
): Promise<OAuthStartResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const verifier = randomToken(32);
  const challenge = toBase64Url(await sha256(verifier));
  const payload: OAuthStatePayload = {
    a: input.accountId,
    n: randomToken(12),
    e: now + GITHUB_OAUTH_STATE_TTL_SECONDS,
    v: await encryptSecret(verifier, env.ENC_KEY),
    r: input.redirectUri,
  };
  const encoded = toBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256Hex(env.ENC_KEY, encoded);
  return { state: `${encoded}.${signature}`, verifier, challenge, redirectUri: input.redirectUri };
}

export interface VerifiedOAuthState {
  accountId: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

/** state を検証して payload を返す。改竄・期限切れ・形式不良は 400。 */
export async function verifyOAuthState(
  env: Env,
  state: string,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedOAuthState> {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) throw ApiError.validation("OAuth state の形式が不正です");

  const expected = await hmacSha256Hex(env.ENC_KEY, encoded);
  if (!timingSafeEqual(expected, signature)) {
    throw ApiError.validation("OAuth state の署名が一致しません");
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as OAuthStatePayload;
  } catch {
    throw ApiError.validation("OAuth state を解釈できません");
  }
  if (
    typeof payload.a !== "string" ||
    typeof payload.v !== "string" ||
    typeof payload.r !== "string" ||
    typeof payload.e !== "number"
  ) {
    throw ApiError.validation("OAuth state の内容が不正です");
  }
  if (payload.e <= now) throw ApiError.validation("OAuth state の有効期限が切れています");

  return {
    accountId: payload.a,
    verifier: await decryptSecret(payload.v, env.ENC_KEY),
    redirectUri: payload.r,
    expiresAt: payload.e,
  };
}

export function buildAuthorizeUrl(
  env: Env,
  input: { state: string; challenge: string; redirectUri: string },
): string {
  const clientId = readWp4Secrets(env).GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new ApiError(500, ErrorCode.MISCONFIGURED, "GitHub OAuth App が未設定です（GITHUB_CLIENT_ID）");
  }
  const url = new URL(baseUrlOf(env, "GITHUB_OAUTH_AUTHORIZE_URL", GITHUB_OAUTH_AUTHORIZE_URL));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", GITHUB_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

export interface OAuthTokenResult {
  token: string;
  scopes: string[];
  tokenType: string;
}

/** 認可コードをアクセストークンに交換する（PKCE verifier 付き）。 */
export async function exchangeOAuthCode(
  env: Env,
  input: { code: string; verifier: string; redirectUri: string },
): Promise<OAuthTokenResult> {
  const secrets = readWp4Secrets(env);
  if (!secrets.GITHUB_CLIENT_ID || !secrets.GITHUB_CLIENT_SECRET) {
    throw new ApiError(500, ErrorCode.MISCONFIGURED, "GitHub OAuth App が未設定です");
  }
  const form = new URLSearchParams({
    client_id: secrets.GITHUB_CLIENT_ID,
    client_secret: secrets.GITHUB_CLIENT_SECRET,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });

  let response: Response;
  try {
    response = await fetch(baseUrlOf(env, "GITHUB_OAUTH_TOKEN_URL", GITHUB_OAUTH_TOKEN_URL), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "open-clone/1.0",
      },
      body: form.toString(),
    });
  } catch {
    throw new ApiError(502, ErrorCode.BAD_GATEWAY, "GitHub のトークン交換に接続できませんでした");
  }

  const body = (await response.json().catch(() => null)) as
    | { access_token?: string; token_type?: string; scope?: string; error?: string; error_description?: string }
    | null;

  if (!response.ok || !body?.access_token) {
    if (body?.error === "bad_verification_code") {
      throw ApiError.validation("GitHub の認可コードが無効です（期限切れの可能性）");
    }
    throw new ApiError(
      502,
      ErrorCode.BAD_GATEWAY,
      `GitHub のトークン交換に失敗しました${body?.error ? `（${body.error}）` : ""}`,
    );
  }

  return {
    token: body.access_token,
    tokenType: body.token_type ?? "bearer",
    scopes: (body.scope ?? "").split(/[,\s]+/).filter(Boolean),
  };
}