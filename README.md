# おーぷんクローン (open-clone)

おーぷん2ch風・AI運営型の匿名掲示板。**実際に運用できる完成品**を目標に、Vercel（静的配信）+ Cloudflare Workers / D1 / Durable Objects（SQLite-backed）の**無料枠**で動く構成です。

> 本リポジトリは独立した個人・有志による実装です。既存サービス（open2ch.net その他の掲示板）とは**運営・提携・後援などの関係が一切ない無関係の独立サイト**であり、既存サイトのロゴ・画像・CSS などの素材は一切流用していません（外観・操作感の参考にとどめます）。

- 正本要件: [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)
- 設計: [`docs/design/DESIGN.md`](docs/design/DESIGN.md)（末尾 §A に確定事項）
- 実装契約・起動手順: [`docs/design/CONTRACTS.md`](docs/design/CONTRACTS.md)
- 作業分担・ファイル排他: [`docs/design/WORKPACKAGES.md`](docs/design/WORKPACKAGES.md)

> **実装状況**: 主要機能は各パッケージに実装済みです。ルートごとの実装状況は
> [`docs/api.md`](docs/api.md) §3（生成時に実装を検査）を参照してください。未実装の API は
> `501 NOT_IMPLEMENTED` を返します（スタブで隠さない方針）。

## 主な機能

- **掲示板本体**: 板・スレ・レス、ID（4文字）・トリップ（2ch互換10桁）・安価・sage/age・kome・実況・NG・アク禁・投票・検索（FTS5 + LIKE）・ランキング・通報・専ブラ互換（`/compat/*`、Shift_JIS）
- **ユーザー製プラグイン**: Web エディタで作成・プレビュー・公開・検索・インストール・更新。`sandbox="allow-scripts"` の iframe（不透明オリジン）+ postMessage RPC で隔離。GitHub 連携なしでもレジストリ内で完結
- **GitHub 連携 / アップローダ**: GitHub OAuth（任意）、Gist / リポジトリへの保存、Catbox / Cloudinary / Gist / mock の交換可能アダプタ。**添付本体は Cloudflare に永続保存しない（R2 不使用）**
- **外部 AI 自律運営**: REST `/v1/ai/*` と MCP `/mcp`（ステートレス Streamable HTTP）。リスク階層（low/medium/high/never）、承認キュー、緊急停止、監査ログ、プロンプトインジェクション対策
- **特別管理人**: owner が発行する一回限りの就任キー、TOTP（RFC 6238）必須、リカバリーコード、専用ダッシュボード。owner の最終権限とインフラ秘密情報は渡さない

## 構成

```
open-clone/
├─ apps/
│  ├─ web/          Next.js 16 App Router（output:'export'）→ Vercel
│  └─ api/          Cloudflare Workers（Hono v4）→ 単一 Worker
├─ packages/
│  ├─ shared/       zod スキーマ・型・エラー・TOTP/DES/Shift_JIS
│  ├─ plugin-sdk/   プラグイン SDK
│  └─ mcp/          MCP サーバー定義・プロンプト
├─ e2e/             Playwright（実スタック + 外部サービススタブ）
├─ tools/           生成スクリプト（API ドキュメント・Shift_JIS テーブル）
└─ docs/            要件・設計・API/MCP/プラグイン/運用ドキュメント
```

- API: `/v1/*`（REST）、`/mcp`・`/mcp/legacy`（MCP）、`/compat/*`（専ブラ互換）、`/rt`（WebSocket）
- データ: D1 のみ（`apps/api/migrations/`）。Durable Objects は SQLite-backed（`RealtimeHub` / `RateLimiter` / `AiGate`）
- フロントは静的エクスポート。開発時は `next.config.ts` の rewrites、本番は `apps/web/vercel.json` の rewrites で `/api/*` を Worker へ中継

## 必要環境

- Node.js 22 以上（CI は 24）
- pnpm 12（`packageManager` で固定）
- Cloudflare アカウント（デプロイ時）、Vercel アカウント（デプロイ時）

## ローカル開発

```sh
pnpm install

# ローカル秘密（公式 Turnstile テストキー入り。実秘密は書かない）
cp apps/api/.dev.vars.example apps/api/.dev.vars

# D1 ローカルへマイグレーション適用
pnpm --filter api db:migrate:local

# API（wrangler dev :8787）+ Web（next dev :3000）
pnpm dev
```

確認:

```sh
curl http://127.0.0.1:8787/v1/health
curl http://localhost:3000/api/v1/health   # web の rewrites 経由
```

- ローカル DB は `apps/api/.wrangler/state/` に作られます（gitignore 済み）。
- 秘密は `apps/api/.dev.vars` のみ。**リポジトリに実秘密を置かない**（CI で gitleaks）。

## テスト

```sh
pnpm -r lint
pnpm -r typecheck
pnpm -r test                 # 単体 + API 統合 + e2e の --list
pnpm --filter web build      # 静的エクスポート
pnpm --filter api exec wrangler deploy --dry-run
```

### E2E（Playwright）

E2E は実スタック（wrangler dev + next dev + ローカル D1）を起動し、外部サービスはローカルスタブで代用します。

```sh
pnpm --filter e2e exec playwright install chromium
pnpm --filter e2e test:e2e            # 全 spec（pc + mobile）
pnpm --filter e2e test:e2e:smoke      # スモークのみ
pnpm --filter e2e test:e2e:security   # セキュリティ suite
```

- 専用ポート: web **3107** / api **8807** / スタブ **8898**（`E2E_WEB_PORT` / `E2E_API_PORT` / `E2E_STUB_PORT` で上書き可）
- web は `apps/web` を直接起動し、distDir を `.next-e2e`（`NEXT_DIST_DIR`）に分離します。同じツリーの `next dev`（`.next`）とロックが衝突しません。
  実況の WebSocket は next dev の rewrites で中継できないため、`start-web.sh` が `NEXT_PUBLIC_WS_BASE` を API ポートから設定します。
- 専用 D1 状態: `.wrangler/state-e2e`（起動時に migrations apply + `e2e/fixtures/seed.sql`。`E2E_PERSIST_DIR` で上書き可）
- 外部サービススタブ: `e2e/scripts/stub-server.mjs`（Catbox / Cloudinary / GitHub / Turnstile）。テスト側は `e2e/helpers/stubs.ts`
- 読み取り系 IP 窓の緩和: E2E は全ブラウザ操作が 127.0.0.1 に集約されるため、`start-api.sh` が `RATE_LIMIT_READ_MULTIPLIER=10` を渡し、
  `readList` などの 1 分あたり上限を 10 倍にします（既定で有効、本番の既定は 1 のまま）。
  本番と同じ上限で検証したいときは `E2E_RATE_LIMIT_RELAX=0`、倍率を変えるときは `E2E_RATE_LIMIT_READ_MULTIPLIER=<n>` を指定します
- 未実装 API に対するセキュリティテストは動的に skip し、実装後に自動で検証へ戻ります（`e2e/helpers/api.ts` の `skipIfUnimplemented`）

同じ作業ツリーで複数の E2E を並行実行する場合は、衝突しないように分けてください。

```sh
E2E_WEB_PORT=3103 E2E_API_PORT=8803 \
E2E_PERSIST_DIR="$PWD/.wrangler/state-parallel" \
E2E_OUTPUT_DIR=test-results-parallel E2E_REPORT_DIR=playwright-report-parallel \
  pnpm --filter e2e exec playwright test --project=pc
```

- `E2E_OUTPUT_DIR` / `E2E_REPORT_DIR`: trace / スクリーンショット / HTML レポートの出力先。既定は `test-results` / `playwright-report`（共有すると並行実行で trace が消え合います）
- `CI=true` が環境にあると `reuseExistingServer` が無効になります。起動済みサーバーへ相乗りするときは `env -u CI` で実行
- マイグレーション SQL を適用後に編集した場合、D1 はファイル名だけで適用済み判定するためスキーマが古いまま残ります。
  `bash e2e/scripts/start-api.sh --reset --setup-only` で状態ディレクトリを作り直してください

### ドキュメント生成

```sh
pnpm --filter e2e gen:api-docs   # shared の zod スキーマ + ルート定義 → docs/api.md
```

### セキュリティスキャン

```sh
gitleaks dir . --redact --config .gitleaks.toml
actionlint .github/workflows/*.yml
```

## デプロイ

詳細・ロールバック手順は [`docs/deploy.md`](docs/deploy.md)。概要:

1. **D1 作成**: `wrangler d1 create open-clone` → 出力の `database_id` を `apps/api/wrangler.toml` に設定
2. **マイグレーション**: `pnpm --filter api exec wrangler d1 migrations apply open-clone --remote`
3. **secrets**: `wrangler secret put ID_SALT` / `ENC_KEY` / `OWNER_BOOTSTRAP_KEY` / `TURNSTILE_SECRET_KEY`（+ GitHub OAuth / Cloudinary を使う場合は追加）
4. **Turnstile**: Cloudflare ダッシュボードでウィジェット作成。site key を web の `NEXT_PUBLIC_TURNSTILE_SITE_KEY`、secret を Worker に設定
5. **GitHub OAuth App**（任意）: callback URL を `https://<api-domain>/v1/github/oauth/callback` に設定
6. **Worker**: `pnpm --filter api exec wrangler deploy`
7. **Vercel**: プロジェクト root を `apps/web`、静的エクスポートを配信。`apps/web/vercel.json` の rewrite 宛先を実際の Worker ドメインへ更新
8. **初回 owner 作成**: `OWNER_BOOTSTRAP_KEY` を使って `/admin` のセットアップ（一度だけ）

> ドメイン・アカウント名は環境ごとに異なります。`vercel.json` の `open-clone-api.example.workers.dev` は**要確認**（デプロイ時に実値へ更新）。

### CI / 手動デプロイ

- `.github/workflows/ci.yml`: PR で lint / typecheck / unit / 統合 / build / gitleaks。main push と手動実行で E2E（2 shard）
- `.github/workflows/deploy.yml`: **workflow_dispatch のみ**。`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（Vercel へ出す場合は `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`）が必要。自動デプロイはしない

## 無料枠の注意

- **Workers Free**: 100,000 req/日、CPU 10ms/req。PBKDF2 は 100,000 iter（上限）で実装
- **D1 Free**: 5,000,000 rows read/日、100,000 rows written/日、**500MB/DB**。1投稿の書き込みは ≤12 行を目標
- **Durable Objects Free**: SQLite-backed のみ。WebSocket Hibernation 必須（アイドル課金を避ける）
- **Cron**: Free は 5 個まで。既に 5 個割当済み（追加は設計変更）
- **Vercel Hobby**: **非商用のみ**（広告・販売・制作費受領は商用）。寄付は可
- **Catbox**: 非商用。商用化には事前承認が必要。Cloudinary は 25 credits/月
- **R2 は使わない**。添付本体は Cloudflare に永続保存しない（D1 には URL とメタデータのみ）
- 上限超過は課金ではなく**サービス停止**。`/v1/meta/usage` は D1 の一部テーブル件数と Free 枠の定数を返すのみで、日次のリクエスト数・rows read/write の実測や 80% 自動警報は**未実装**。Cloudflare ダッシュボードの Usage を定期確認する（[`docs/operations.md`](docs/operations.md)）

## セキュリティ

- 投稿本文はプレーンテキスト保存、描画時にエスケープ。生 HTML は不可
- 全 mutation で Origin 検証（CSRF）。CORS は許可リストのみ
- パスワードは PBKDF2-SHA256 100k、TOTP は ±1 窓・5回失敗ロック
- プラグインは不透明オリジンの iframe + 権限宣言 + ホストブリッジで強制
- AI は REST/MCP 共通の政策エンジンを必ず通過。high は人間承認、never は常に 403
- 秘密情報は Wrangler secrets / Vercel env のみ。CI で gitleaks

## ドキュメント

| ファイル | 内容 |
|---|---|
| [`docs/api.md`](docs/api.md) | REST API 仕様（zod スキーマから自動生成） |
| [`docs/mcp.md`](docs/mcp.md) | MCP 接続方法・認証・ツール一覧・リスク階層 |
| [`docs/plugin-guide.md`](docs/plugin-guide.md) | プラグイン開発ガイド（manifest / SDK / 権限 / 審査 / GitHub 配布） |
| [`docs/special-admin.md`](docs/special-admin.md) | 特別管理人（専用ロール）の招待・就任手順 |
| [`docs/operations.md`](docs/operations.md) | 運用（緊急停止・無料枠監視・障害対応） |
| [`docs/deploy.md`](docs/deploy.md) | デプロイ手順・環境変数・ロールバック |

## ライセンス

[MIT](LICENSE)
