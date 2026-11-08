// 開発サーバー用の受け皿。`next dev` では任意のパスがこのシェルにマッチし、
// クライアント側で `/b/:slug` や `/b/:slug/t/:id` を解決する（本番は vercel.json の rewrite が index.html を返す）。
import { AppShell } from "../_shell/app-shell";

export function generateStaticParams() {
  // 静的エクスポートではサンプル 1 件のみ生成する（実 URL は rewrite + クライアントルーティング）。
  return [{ path: ["_shell"] }];
}

export default function CatchAllPage() {
  return <AppShell />;
}