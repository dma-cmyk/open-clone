#!/usr/bin/env bash
# E2E 用 API 起動。
# 1) ローカル D1 に migrations を適用 2) seed を投入 3) wrangler dev を起動。
# 状態は E2E 専用ディレクトリに隔離する（同じ作業ツリーの wrangler dev と衝突しない）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${E2E_API_PORT:-8807}"
PERSIST="${E2E_PERSIST_DIR:-$ROOT/.wrangler/state-e2e}"
ORIGINS="${E2E_ALLOWED_ORIGINS:-http://127.0.0.1:3107,http://localhost:3107}"

# --reset: ローカル D1 状態ディレクトリを捨てて作り直す。
# マイグレーション SQL が適用後に編集された場合、D1 はファイル名だけで適用済み判定するため
# スキーマが古いまま残る（no such column 等）。その場合は --reset で作り直す。
RESET=0
SETUP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    --setup-only) SETUP_ONLY=1 ;;
    *) echo "[e2e] 不明な引数: $arg" >&2; exit 2 ;;
  esac
done

if [ "$RESET" = 1 ]; then
  echo "[e2e] persist dir をリセットします: $PERSIST"
  rm -rf "$PERSIST"
fi

cd "$ROOT"
mkdir -p "$PERSIST"

# CI には .dev.vars が無い（gitignore 済み）。公式テストキーの雛形から作る。
if [ ! -f "$ROOT/apps/api/.dev.vars" ]; then
  echo "[e2e] apps/api/.dev.vars が無いため .dev.vars.example から作成します（ローカル専用ダミー値）"
  cp "$ROOT/apps/api/.dev.vars.example" "$ROOT/apps/api/.dev.vars"
fi

echo "[e2e] D1 migrations apply (persist: $PERSIST)"
pnpm --filter api exec wrangler d1 migrations apply open-clone --local --persist-to "$PERSIST"

echo "[e2e] seed: e2e/fixtures/seed.sql"
pnpm --filter api exec wrangler d1 execute open-clone --local --persist-to "$PERSIST" \
  --file "$ROOT/e2e/fixtures/seed.sql"

if [ "$SETUP_ONLY" = 1 ]; then
  echo "[e2e] setup 完了（--setup-only のため wrangler dev は起動しません）"
  exit 0
fi

# 外部サービス（Catbox / Cloudinary / GitHub）をローカルスタブへ向ける。
# 既定は無効（実 API への誤爆防止）。WP4 の spec は E2E_UPLOAD_STUB=1 / E2E_GITHUB_STUB=1 で有効化する。
STUB_URL="${E2E_STUB_URL:-http://127.0.0.1:8898}"
EXTRA_VARS=()
if [ "${E2E_UPLOAD_STUB:-0}" = "1" ]; then
  EXTRA_VARS+=(
    --var "CATBOX_API_URL:$STUB_URL/user/api.php"
    --var "LITTERBOX_API_URL:$STUB_URL/user/api.php"
    --var "CLOUDINARY_API_BASE:$STUB_URL"
  )
  echo "[e2e] upload stub 有効: $STUB_URL"
fi
if [ "${E2E_TURNSTILE_STUB:-0}" = "1" ]; then
  EXTRA_VARS+=(--var "TURNSTILE_VERIFY_URL:$STUB_URL/turnstile/v0/siteverify")
  echo "[e2e] turnstile stub 有効: $STUB_URL/turnstile/v0/siteverify"
fi
if [ "${E2E_GITHUB_STUB:-0}" = "1" ]; then
  EXTRA_VARS+=(
    --var "GITHUB_API_BASE:$STUB_URL/api/v3"
    --var "GITHUB_OAUTH_AUTHORIZE_URL:$STUB_URL/login/oauth/authorize"
    --var "GITHUB_OAUTH_TOKEN_URL:$STUB_URL/login/oauth/access_token"
    --var "GITHUB_CLIENT_ID:e2e-client-id"
    --var "GITHUB_CLIENT_SECRET:e2e-client-secret"
  )
  echo "[e2e] github stub 有効: $STUB_URL"
fi

# 読み取り系 IP 窓の上限倍率（E2E 専用）。E2E は全ブラウザ操作が 127.0.0.1 に集約されるため、
# 本番と同じ上限（readList 120/分など）だと正常な画面遷移でも 429 になる。本番の既定は変えない
# （倍率を渡さない限り RATE_LIMITS の値そのまま）。E2E_RATE_LIMIT_RELAX=0 で無効化できる。
if [ "${E2E_RATE_LIMIT_RELAX:-1}" = "1" ]; then
  RELAX_MULTIPLIER="${E2E_RATE_LIMIT_READ_MULTIPLIER:-10}"
  EXTRA_VARS+=(--var "RATE_LIMIT_READ_MULTIPLIER:$RELAX_MULTIPLIER")
  echo "[e2e] 読み取り系レート制限を緩和: x$RELAX_MULTIPLIER"
fi

echo "[e2e] wrangler dev :$PORT (ALLOWED_ORIGINS=$ORIGINS)"
exec pnpm --filter api exec wrangler dev \
  --local \
  --port "$PORT" \
  --persist-to "$PERSIST" \
  --var "ENVIRONMENT:development" \
  --var "ALLOWED_ORIGINS:$ORIGINS" \
  "${EXTRA_VARS[@]}"
