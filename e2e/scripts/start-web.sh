#!/usr/bin/env bash
# E2E 用 web 起動。
#
# 同じ作業ツリーで別の `next dev` を動かしていると Next の distDir ロック
# （「Another next dev server is already running」）で起動できない。
# 以前は apps/web のソースを .wrangler/state-e2e/web-runtime へコピーして起動していたが、
# コピー先では Turbopack が next パッケージを解決できず
# 「Could not find the Next.js package (next/package.json)」で webServer がタイムアウトした。
#
# 現在はリポジトリ内の apps/web から起動し、distDir だけを E2E 専用に分離する
# （next.config.ts の `distDir: process.env.NEXT_DIST_DIR ?? ".next"`）。
# Next の dev ロックは <distDir>/lock なので、distDir が違えば別の dev と共存できる。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${E2E_WEB_PORT:-3107}"
export API_ORIGIN="${API_ORIGIN:-http://127.0.0.1:8807}"
export NEXT_DIST_DIR="${E2E_NEXT_DIST_DIR:-.next-e2e}"
# 実況（WebSocket）は next dev の rewrites では中継できないため、クライアントは API へ直接つなぐ。
# wsBase() の dev 既定ポートは 8787 固定なので、E2E の API ポートを明示する。
export NEXT_PUBLIC_WS_BASE="${NEXT_PUBLIC_WS_BASE:-$(printf '%s' "$API_ORIGIN" | sed -e 's#^http#ws#')}"

echo "[e2e] next dev :$PORT (dir: $ROOT/apps/web, distDir: $NEXT_DIST_DIR, API_ORIGIN=$API_ORIGIN, WS=$NEXT_PUBLIC_WS_BASE)"
cd "$ROOT/apps/web"
exec "$ROOT/apps/web/node_modules/.bin/next" dev -p "$PORT"
