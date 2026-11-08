// Next.js 設定。静的エクスポートとローカル rewrites プロキシ。
// `output:'export'` では rewrites はビルドに含められないため、開発サーバー専用のフェーズ分岐を使う。
// 本番の API 中継は vercel.json の rewrites（外部オリジン）で行う（Functions 不使用）。

import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:8787";

/**
 * web のセキュリティヘッダー。
 * CSP は「Next dev の HMR」「Turnstile」「プラグイン sandbox iframe」を壊さない範囲で許可する:
 * - script: 自オリジン + Turnstile。`unsafe-eval` は許可しない（本番も同じ方針）。
 * - connect: 自オリジン + ws/wss（HMR・Realtime）+ HTTPS（直接モードの API）。
 * - frame: Turnstile と、sandbox iframe（srcdoc/blob/data）。
 * - frame-ancestors 'none' でクリックジャッキングを拒否。
 */
const WEB_CSP = [
  "default-src 'self'",
  // プラグイン sandbox iframe は srcdoc + blob: スクリプトで動く。srcdoc iframe は
  // 親ページの CSP を継承するため、script-src に blob: が無いと iframe 内のコードが
  // 実行されない（E2E plugin/sandbox-security で実測）。
  "script-src 'self' 'unsafe-inline' blob: https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https:",
  "frame-src 'self' blob: data: https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: WEB_CSP },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// Next dev（Turbopack）は開発時のみ eval を使う（React の callstack 再構築）。
// 本番 CSP は据え置き、dev だけ `unsafe-eval` を許可してオーバーレイの Console Error を出さない。
// 併せて dev のみローカルスタブ（E2E のアップロード結果 http://127.0.0.1:<port>）の画像/動画を許可する。
// 本番の添付 URL は https のみで、この緩和は開発サーバーに限られる。
const DEV_CSP = WEB_CSP.replace(
  "script-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
)
  .replace("img-src 'self' data: blob: https:", "img-src 'self' data: blob: https: http://127.0.0.1:*")
  .replace("media-src 'self' blob: https:", "media-src 'self' blob: https: http://127.0.0.1:*");

const DEV_SECURITY_HEADERS = SECURITY_HEADERS.map((header) =>
  header.key === "Content-Security-Policy" ? { ...header, value: DEV_CSP } : header,
);

export default function nextConfig(phase: string): NextConfig {
  const base: NextConfig = {
    images: { unoptimized: true },
    // shared は TS ソースをそのまま提供するためトランスパイルが必要
    transpilePackages: ["shared"],
    // 同じ作業ツリーで複数の `next dev`（E2E と手元の dev）を並行させるため、
    // distDir を環境変数で分離できるようにする。Next の dev ロックは distDir 配下
    // （<distDir>/lock）なので、別 distDir なら衝突しない。
    distDir: process.env.NEXT_DIST_DIR ?? ".next",
  };

  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      ...base,
      // dev では `output:'export'` を付けない。付けると catch-all `[...path]` の静的列挙が強制され、
      // `/b/<slug>` や `/b/<slug>/t/<id>` への直リンクが 500 になる（クライアント遷移なら動くが直リンクが壊れる）。
      // 本番は下の production 分岐で `output:'export'` を維持し、vercel.json の rewrites で index.html を返す。
      // `headers()` は静的エクスポートでは使えないため dev のみ。本番は apps/web/vercel.json が付与する。
      async headers() {
        return [{ source: "/:path*", headers: DEV_SECURITY_HEADERS }];
      },
      async rewrites() {
        return [
          // /api/v1/health → http://127.0.0.1:8787/v1/health
          { source: "/api/v1/:path*", destination: `${API_ORIGIN}/v1/:path*` },
          // /api/meta/health → http://127.0.0.1:8787/v1/meta/health（互換）
          { source: "/api/:path*", destination: `${API_ORIGIN}/v1/:path*` },
        ];
      },
    };
  }

  // 本番（build / export）は静的エクスポート。API 中継は vercel.json の rewrites。
  return { ...base, output: "export" };
}
