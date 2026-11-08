// WP4 が参照する secret/vars の読み取り。
// `lib/env.ts`に WP4 固有キーを追加できないため、ここで安全に取り出す。
// 秘密の実体は Wrangler secret（本番） / `.dev.vars`（ローカル）にのみ置く。

import type { Env } from "../lib/env";

/** WP4 が追加で参照する環境変数名（リポジトリに値を置かない）。 */
export interface Wp4Secrets {
  /** GitHub OAuth App（public。authorize URL に載る） */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth App secret */
  GITHUB_CLIENT_SECRET?: string;
  /** OAuth callback の固定 URL（未設定ならリクエスト元から導出） */
  GITHUB_OAUTH_REDIRECT_URI?: string;
  /** サイト運営の GitHub リポジトリへ書き込む任意のサービス用トークン */
  GITHUB_SERVICE_TOKEN?: string;
  /** webhook（任意・運営側 GitHub App）の HMAC secret */
  GITHUB_WEBHOOK_SECRET?: string;
  /** Catbox アカウントの userhash（任意。設定すると匿名削除不可が緩和される） */
  CATBOX_USERHASH?: string;
  /** Cloudinary signed upload */
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;

  // ── 外部サービスの base URL（E2E スタブ差し替え用。未設定なら本番 URL） ──
  /** GitHub REST API のベース（既定 https://api.github.com） */
  GITHUB_API_BASE?: string;
  /** GitHub OAuth 認可画面（既定 https://github.com/login/oauth/authorize） */
  GITHUB_OAUTH_AUTHORIZE_URL?: string;
  /** GitHub OAuth トークン交換（既定 https://github.com/login/oauth/access_token） */
  GITHUB_OAUTH_TOKEN_URL?: string;
  /** Catbox アップロード API（既定 https://catbox.moe/user/api.php） */
  CATBOX_API_URL?: string;
  /** Litterbox アップロード API（既定 https://litterbox.catbox.moe/resources/internals/api.php） */
  LITTERBOX_API_URL?: string;
  /** Cloudinary API のベース（既定 https://api.cloudinary.com） */
  CLOUDINARY_API_BASE?: string;
}

/** 空文字は未設定として扱う（wrangler の空 var 対策）。 */
export function readEnvSecret(env: Env, name: keyof Wp4Secrets | string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 末尾スラッシュを落とした base URL（空文字・未設定は fallback）。 */
export function baseUrlOf(env: Env, name: keyof Wp4Secrets, fallback: string): string {
  const value = readEnvSecret(env, name);
  return value ? value.replace(/\/+$/, "") : fallback;
}

export function readWp4Secrets(env: Env): Wp4Secrets {
  return {
    GITHUB_CLIENT_ID: readEnvSecret(env, "GITHUB_CLIENT_ID"),
    GITHUB_CLIENT_SECRET: readEnvSecret(env, "GITHUB_CLIENT_SECRET"),
    GITHUB_OAUTH_REDIRECT_URI: readEnvSecret(env, "GITHUB_OAUTH_REDIRECT_URI"),
    GITHUB_SERVICE_TOKEN: readEnvSecret(env, "GITHUB_SERVICE_TOKEN"),
    GITHUB_WEBHOOK_SECRET: readEnvSecret(env, "GITHUB_WEBHOOK_SECRET"),
    CATBOX_USERHASH: readEnvSecret(env, "CATBOX_USERHASH"),
    CLOUDINARY_CLOUD_NAME: readEnvSecret(env, "CLOUDINARY_CLOUD_NAME"),
    CLOUDINARY_API_KEY: readEnvSecret(env, "CLOUDINARY_API_KEY"),
    CLOUDINARY_API_SECRET: readEnvSecret(env, "CLOUDINARY_API_SECRET"),
    GITHUB_API_BASE: readEnvSecret(env, "GITHUB_API_BASE"),
    GITHUB_OAUTH_AUTHORIZE_URL: readEnvSecret(env, "GITHUB_OAUTH_AUTHORIZE_URL"),
    GITHUB_OAUTH_TOKEN_URL: readEnvSecret(env, "GITHUB_OAUTH_TOKEN_URL"),
    CATBOX_API_URL: readEnvSecret(env, "CATBOX_API_URL"),
    LITTERBOX_API_URL: readEnvSecret(env, "LITTERBOX_API_URL"),
    CLOUDINARY_API_BASE: readEnvSecret(env, "CLOUDINARY_API_BASE"),
  };
}