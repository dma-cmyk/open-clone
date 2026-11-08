// セキュリティヘッダー。
// API は JSON / テキスト（compat）のみを返すため、CSP は最小構成にする。
// 注意: ここで付けるヘッダーは「全レスポンス」に効く（404 / onError の envelope も含む）。

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

/** API 向け最小 CSP。HTML を返さないので script/style は全面禁止でよい。 */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const BASE_HEADERS: Array<[string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Frame-Options", "DENY"],
  ["Content-Security-Policy", API_CSP],
];

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  const res = c.res;
  // 101 Switching Protocols（WebSocket 昇格）はヘッダーが immutable で、Response の作り直しも不可。
  // 昇格レスポンスにはヘッダーを足さない。
  if (res.status === 101) return;

  // ルートが設定した Cache-Control（プラグインコードの immutable 等）は尊重し、
  // 未設定の API 応答だけ no-store にする。compat はクライアント側キャッシュを許す。
  const cacheControl =
    res.headers.get("Cache-Control") ??
    (c.req.path.startsWith("/compat") ? null : "no-store");

  const apply = (headers: Headers): void => {
    for (const [key, value] of BASE_HEADERS) headers.set(key, value);
    if (cacheControl) headers.set("Cache-Control", cacheControl);
  };

  try {
    apply(res.headers);
  } catch {
    // 上流 fetch の応答などでヘッダーが immutable な場合は、本文を保ったまま作り直す。
    const headers = new Headers(res.headers);
    apply(headers);
    c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
});