// Worker のバインディング/環境変数の型。
// `wrangler types` で再生成せず、CONTRACTS.md §4 の契約として手動管理する（全 WP が参照）。

export interface Env {
  // --- bindings ---
  DB: D1Database;
  REALTIME: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  AI_GATE: DurableObjectNamespace;

  // --- vars ---
  ENVIRONMENT: string; // "development" | "production"
  ALLOWED_ORIGINS: string; // カンマ区切り

  // --- secrets (.dev.vars / wrangler secret) ---
  ID_SALT: string;
  ENC_KEY: string;
  OWNER_BOOTSTRAP_KEY: string;
  TURNSTILE_SECRET_KEY?: string;
  /** ローカル/E2E スタブ用の siteverify URL 上書き（未設定なら本番）。 */
  TURNSTILE_VERIFY_URL?: string;
  /**
   * 読み取り系 IP 窓の上限倍率（E2E 専用。未設定 = 1 で本番の RATE_LIMITS そのまま）。
   * E2E は全ブラウザ操作が 127.0.0.1 に集約されるため、`start-api.sh` が E2E 実行時のみ 10 を渡す。
   */
  RATE_LIMIT_READ_MULTIPLIER?: string;

  // --- WP4（アップローダ / GitHub 連携）任意キー ---
  // 実行時は `services/env-secrets.ts` の `readEnvSecret()` / `baseUrlOf()` が読む。
  // 未設定でも動作する（GitHub 連携は PAT のみ案内、Cloudinary は一覧で利用不可になる）。
  /** GitHub OAuth App（public。authorize URL に載る） */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth App secret */
  GITHUB_CLIENT_SECRET?: string;
  /** OAuth callback の固定 URL（未設定ならリクエスト元オリジン + /account/github） */
  GITHUB_OAUTH_REDIRECT_URI?: string;
  /** 運営側 GitHub App の webhook HMAC secret */
  GITHUB_WEBHOOK_SECRET?: string;
  /** プラグイン配布リポジトリ用 webhook の専用 HMAC secret（未設定なら GITHUB_WEBHOOK_SECRET → ID_SALT） */
  GITHUB_PLUGIN_HOOK_SECRET?: string;
  /** サイト運営リポジトリへ書き込む任意のサービス用トークン */
  GITHUB_SERVICE_TOKEN?: string;
  /** Catbox アカウントの userhash（任意） */
  CATBOX_USERHASH?: string;
  /** Cloudinary signed upload */
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;

  // --- 外部サービスの base URL（E2E スタブ差し替え用。未設定なら本番 URL） ---
  GITHUB_API_BASE?: string;
  GITHUB_OAUTH_AUTHORIZE_URL?: string;
  GITHUB_OAUTH_TOKEN_URL?: string;
  CATBOX_API_URL?: string;
  LITTERBOX_API_URL?: string;
  CLOUDINARY_API_BASE?: string;
}

import type { AppRequestContext } from "shared";

/** Hono ルート/ミドルウェアのジェネリクス。`c.get("reqCtx")` で共通コンテキストにアクセス。 */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    reqCtx: AppRequestContext;
  };
};
