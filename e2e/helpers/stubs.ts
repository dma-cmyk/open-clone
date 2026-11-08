// 外部サービススタブのテスト側クライアント。
// 実体は scripts/stub-server.mjs（Playwright webServer が自動起動する）。
// WP3/WP4/WP5 の spec はこのモジュールでスタブの状態を操作・検証できる。

export const STUB_BASE = process.env.E2E_STUB_URL ?? "http://127.0.0.1:8898";

export interface StubRequestLog {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  at: number;
}

/** スタブが受けたリクエストログを消す。テスト間の独立性のため beforeEach で呼ぶ。 */
export async function resetStubs(): Promise<void> {
  const res = await fetch(`${STUB_BASE}/__reset`, { method: "POST" });
  if (!res.ok) throw new Error(`stub reset failed: ${res.status}`);
}

/** スタブが受けたリクエストログを取得する（監査・疎通確認用）。 */
export async function stubRequests(): Promise<StubRequestLog[]> {
  const res = await fetch(`${STUB_BASE}/__requests`);
  if (!res.ok) throw new Error(`stub requests failed: ${res.status}`);
  const body = (await res.json()) as { ok: boolean; requests: StubRequestLog[] };
  return body.requests;
}

/** スタブ上の URL を組み立てる。 */
export function stubUrl(path: string): string {
  return `${STUB_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** 実 API のエンドポイントに対応するスタブ URL（WP 側の base URL 差し替え用）。 */
export const STUB_ENDPOINTS = {
  catbox: "/user/api.php",
  cloudinary: "/v1_1",
  githubApi: "/api/v3",
  githubOAuthToken: "/login/oauth/access_token",
  turnstileSiteverify: "/turnstile/v0/siteverify",
} as const;

/** Turnstile 公式テストキー（常に成功）と、スタブで失敗させるトークン。 */
export const TURNSTILE = {
  siteKey: "1x00000000000000000000AA",
  secretKey: "1x0000000000000000000000000000000AA",
  successToken: "1x00000000000000000000AA",
  failureToken: "e2e-fail-token",
} as const;

/** GitHub OAuth のスタブ値（WP4 のテストで利用）。 */
export const GITHUB_STUB = {
  clientId: "e2e-github-client-id",
  clientSecret: "e2e-github-client-secret",
  accessToken: "gho_e2e_dummy_token",
  login: "e2e-user",
} as const;