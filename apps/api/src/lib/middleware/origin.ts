// Origin / CSRF 防御ミドルウェア。
// 全 mutation（POST/PUT/DELETE/PATCH）で Origin を検証し、CORS もここで制御する。

import { createMiddleware } from "hono/factory";
import { ApiError } from "shared";
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
      if (!isDev && !allowAll) {
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
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-turnstile-token");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    c.header("Vary", "Origin");
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});
