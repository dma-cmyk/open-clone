// 環境変数の共有型・キー名定数。

/** web (Next.js) の公開環境変数。`NEXT_PUBLIC_` 接頭辞付きのみクライアントに埋め込まれる */
export interface PublicWebEnv {
  /** 直接モード時の API オリジン。未設定なら同一オリジン `/api/v1`（rewrites プロキシ） */
  NEXT_PUBLIC_API_BASE?: string;
  NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
}

/** Turnstile 公式テストキー（ローカル開発・CI 用。公開値） */
export const TURNSTILE_TEST_KEYS = {
  /** 常に成功する site key */
  siteKey: "1x00000000000000000000AA",
  /** 常に成功する secret key */
  secretKey: "1x0000000000000000000000000000000AA",
} as const;
