// Origin / CSRF 防御ミドルウェア。
// 全 mutation（POST/PUT/DELETE/PATCH）で Origin を検証し、CORS もここで制御する。

import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { ApiError, SESSION_COOKIE } from "shared";
import type { AppEnv } from "../env";

function allowedOrigins(env: AppEnv["Bindings"]): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const MUTATION_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  DELETE: true,
  PATCH: true,
};

/**
 * Bearer 認証だけで動く MCP レーン（報告書29 決定1）。完全一致のみ。
 * ブラウザからの Cookie 認証経路（/v1/*）は対象にしない。
 */
const BEARER_MCP_PATHS: Record<string, true> = {
  "/mcp": true,
  "/mcp/legacy": true,
  "/mcp-plugin": true,
  "/mcp-plugin/legacy": true,
};

/**
 * GitHub webhook 用のパス（F8）。完全一致のみ。
 */
const GITHUB_WEBHOOK_PATHS: Record<string, true> = {
  "/v1/plugins/hooks/github": true,
  "/v1/github/hooks/github": true,
};

function matchesNonBrowserLane(c: Context<AppEnv>, paths: Record<string, true>): boolean {
  if (getCookie(c, SESSION_COOKIE)) return false;
  return paths[new URL(c.req.url).pathname] === true;
}

/**
 * Origin なしでも許可してよい「非ブラウザの Bearer MCP 呼び出し」か。
 * - `Authorization: Bearer <token>` がある（トークンの正当性は後段の認証が判定する）
 * - セッション Cookie を送っていない（Cookie 認証の CSRF 防御を維持する）
 * - パスが MCP レーンの完全一致（`/mcp-plugin/` や `/mcp-plugin/xxx` は対象外）
 */
function isBearerMcpLane(c: Context<AppEnv>): boolean {
  const authorization = c.req.header("authorization")?.trim() ?? "";
  return /^Bearer\s+\S+$/i.test(authorization) && matchesNonBrowserLane(c, BEARER_MCP_PATHS);
}

/**
 * Origin なしでも許可してよい「GitHub webhook」か。
 * - `x-hub-signature-256` がある（署名の正当性は後段のハンドラが判定する）
 * - セッション Cookie を送っていない（Cookie 認証の CSRF 防御を維持する）
 * - パスが webhook 2 パスの完全一致
 */
function isGithubWebhook(c: Context<AppEnv>): boolean {
  const signature = c.req.header("x-hub-signature-256")?.trim() ?? "";
  return signature.length > 0 && matchesNonBrowserLane(c, GITHUB_WEBHOOK_PATHS);
}

/**
 * mutation の Origin を許可リストと照合する。
 * proxy モード（同一オリジン）では Origin は web と同じになり、直接モードでは許可リストに登録する。
 * Origin が存在しない（curl 等）場合は `ALLOWED_ORIGINS` に `*` を含めるか ENVIRONMENT=development の場合のみ許可。
 */
export const originGuard = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  const env = c.env;

  // プリフライトは常に許可（CORS レスポンスのみ返す）
  if (method === "OPTIONS") {
    await next();
    return;
  }

  if (MUTATION_METHODS[method]) {
    const origin = c.req.header("Origin");
    const allowed = allowedOrigins(env);
    const isDev = env.ENVIRONMENT === "development";
    const allowAll = allowed.includes("*");

    if (origin) {
      if (!allowAll && !allowed.includes(origin)) {
        throw new ApiError(403, "BAD_ORIGIN", `Origin '${origin}' は許可されていません`);
      }
    } else {
      // Origin なし mutation はブラウザ経由では発生しない（curl / サーバ間）。
      // 本番では拒否、開発時のみ許可する。
      // 例外は Bearer 認証の MCP レーン（報告書29 決定1）と署名付きの GitHub webhook だけ。
      // どちらもトークン・署名自体が認証であり CSRF は成立しない。正当性は後段が判定する。
      if (!isDev && !allowAll && !isBearerMcpLane(c) && !isGithubWebhook(c)) {
        throw new ApiError(403, "BAD_ORIGIN", "Origin ヘッダが必要です");
      }
    }
  }

  await next();
});

/**
 * CORS ヘッダを付与する（直接モード用。proxy モードでは同一オリジンのため不要だが、付けても害はない）。
 * Cookie を使うため `Access-Control-Allow-Credentials: true` とし、Allow-Origin はリクエスト Origin を反射する。
 */
export const corsHeaders = createMiddleware<AppEnv>(async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = allowedOrigins(c.env);

  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-turnstile-token, X-Pet-Api-Key");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    c.header("Vary", "Origin");
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});

/**
 * Web のオリジン（発行したパスワード再設定 URL の組み立てに使う）。
 * Origin → Referer → ALLOWED_ORIGINS の先頭の順で決める。
 */
export function requestOrigin(c: {
  req: { header(name: string): string | undefined };
  env: AppEnv["Bindings"];
}): string {
  const origin = c.req.header("origin");
  if (origin) return origin;
  const referer = c.req.header("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // fall through
    }
  }
  return (c.env.ALLOWED_ORIGINS ?? "").split(",")[0]?.trim() ?? "";
}
