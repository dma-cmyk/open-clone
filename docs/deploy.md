# デプロイ手順

Vercel（web 静的配信）+ Cloudflare Workers / D1 / Durable Objects（API）への本番デプロイ手順です。
**無料枠（Workers Free / D1 Free / Vercel Hobby）**を前提とし、自動デプロイは行いません。

- 構成: `apps/web` → Vercel、`apps/api` → 単一 Worker
- 本番の API 中継: `apps/web/vercel.json` の rewrites（`/api/*` → Worker）
- 添付本体は Cloudflare に保存しない（R2 不使用）

> プレースホルダ `<...>` は環境ごとの実値に置換してください。アカウント名・ドメインは**要確認**です。

## 0. 前提

- Node.js 22+ / pnpm 12
- Cloudflare アカウント（Workers / D1 / Turnstile が使えること）
- Vercel アカウント（Hobby）
- GitHub リポジトリ（ソース管理。公開/非公開は任意）

```sh
pnpm install
pnpm -r typecheck && pnpm -r test
pnpm --filter web build
```

## 1. D1 データベース作成

```sh
wrangler login
wrangler d1 create open-clone
```

出力の `database_id` を `apps/api/wrangler.toml` の `[[d1_databases]]` に設定します
（現在はプレースホルダ `00000000-0000-0000-0000-000000000000`）。

```toml
[[d1_databases]]
binding = "DB"
database_name = "open-clone"
database_id = "<実際の database_id>"
migrations_dir = "migrations"
```

## 2. マイグレーション適用（remote）

```sh
pnpm --filter api exec wrangler d1 migrations apply open-clone --remote
```

- 適用前に一覧確認: `wrangler d1 migrations list open-clone --remote`
- **順序はファイル名の昇順**。WP ごとの番号帯（CONTRACTS §6）を守ること
- 本番に `e2e/fixtures/seed.sql` を**適用しない**（E2E 専用。固定セッションを含む）

## 3. 秘密情報（Wrangler secrets）

| キー | 必須 | 用途 | 生成例 |
|---|---|---|---|
| `ID_SALT` | ✓ | 表示ID・device_hash・ip_hash の pepper | `openssl rand -hex 32` |
| `ENC_KEY` | ✓ | GitHub トークン等の AES-256-GCM 鍵（32 bytes base64） | `openssl rand -base64 32` |
| `OWNER_BOOTSTRAP_KEY` | ✓ | owner 初回セットアップの一度きりキー | `openssl rand -hex 32` |
| `TURNSTILE_SECRET_KEY` | ✓ | Turnstile siteverify | Cloudflare ダッシュボード |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 任意 | GitHub OAuth（WP4） | GitHub OAuth App |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | 任意 | Cloudinary アダプタ | Cloudinary ダッシュボード |

```sh
cd apps/api
wrangler secret put ID_SALT
wrangler secret put ENC_KEY
wrangler secret put OWNER_BOOTSTRAP_KEY
wrangler secret put TURNSTILE_SECRET_KEY
# 任意
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put CLOUDINARY_CLOUD_NAME
wrangler secret put CLOUDINARY_API_KEY
wrangler secret put CLOUDINARY_API_SECRET
```

非機密の `[vars]`（`apps/api/wrangler.toml`）:

```toml
[vars]
ENVIRONMENT = "production"
ALLOWED_ORIGINS = "https://<web-domain>"
```

- 秘密は**リポジトリに置かない**。CI は gitleaks で検査
- ローカルは `apps/api/.dev.vars`（gitignore 済み）。`*.example` は公式テストキーのみ

## 4. Turnstile

1. Cloudflare ダッシュボード → Turnstile → ウィジェット追加
2. ドメインに `<web-domain>`（例: `open-clone-nine.vercel.app`）を登録する。Turnstile は
   **ウィジェットを表示するページのホスト名**で検証するため、Vercel の本番ドメインを登録する
   （`workers.dev` は WS/API 用なので不要）。登録後にサイトキーを変更した場合は web の再ビルドが必要
   （`NEXT_PUBLIC_*` はビルド時に埋め込まれる）
3. **Site Key**（公開可）→ web の `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
4. **Secret Key** → `wrangler secret put TURNSTILE_SECRET_KEY`
5. ローカル/CI は公式テストキー:
   - site key `1x00000000000000000000AA`（常に成功）
   - secret `1x0000000000000000000000000000000AA`

## 5. GitHub OAuth App（任意・WP4）

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

| 項目 | 値 |
|---|---|
| Application name | おーぷんクローン |
| Homepage URL | `https://<web-domain>` |
| Authorization callback URL | `https://<api-domain>/v1/github/oauth/callback` |

- scope は最小（`gist` + `public_repo`）
- Client ID / Secret を Worker secrets に設定
- Device flow は任意（設計 §8）

## 6. Worker デプロイ

```sh
# dry-run で bundle を確認
pnpm --filter api exec wrangler deploy --dry-run

# 本番
pnpm --filter api exec wrangler deploy
```

- 出力される URL（`https://open-clone-api.<account>.workers.dev` 等）を控える
- `wrangler.toml` には `workers_dev = true` と `preview_urls = false` を明示している（WS を直接つなぐため）
- cron は **Free プランのアカウント全体で 5 枠**。既存 Worker が枠を使っている場合は
  `wrangler deploy` が `reached the Workers Free limit of 5 cron triggers per account` で
  途中失敗するので、[`docs/operations.md`](operations.md) §3 の 4 枠構成に統合する
- ヘルスチェック: `curl https://<api-domain>/v1/health`
- カスタムドメインを使う場合は Cloudflare ダッシュボードで route を設定
- Durable Objects（`RealtimeHub` / `RateLimiter` / `AiGate`）は `index.ts` から export 済み。
  `wrangler.toml` の `new_sqlite_classes` を変更しない

## 7. web を Vercel へデプロイ

### 7.1 プロジェクト設定

- Root Directory: `apps/web`
- Framework Preset: **Other**（`output: 'export'` の静的配信。Next.js プリセットだと
  未定義パスが `404.html` になり SPA の直リンクが開かない）
- Build Command: `pnpm build`
- Output Directory: `out`
- Install Command: `pnpm install`（monorepo のためリポジトリルートで実行される）

`apps/web/next.config.ts` で `trailingSlash: true` を有効にし、静的ページを
`out/account/login/index.html` の形で出力する。Vercel では `vercel.json` の
**`routes`（レガシー形式）で `{"handle": "filesystem"}` を先に評価**し、実ファイルを優先したうえで
API/互換プロキシ → `/(.*)` → `/index.html` の順にフォールバックする。
これで `/b/<slug>` や `/b/<slug>/t/<id>` の直リンクも **200** で SPA シェルを返す。

- `rewrites` + `cleanUrls` の組み合わせでは、静的ファイルへの rewrite が 404 になり直リンクが開かなかった
- `routes` と `cleanUrls` / `headers` は併用できないため、セキュリティヘッダーは `routes` の先頭に
  `{"src": "/(.*)", "headers": {…}}` として書く

環境変数:

| 変数 | 値 |
|---|---|
| `NEXT_PUBLIC_API_BASE` | 直接モード時のみ。既定は同一オリジン `/api/v1`（rewrites） |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile Site Key |
| `API_ORIGIN` | 開発時のみ（`next dev` の rewrites 先） |

### 7.2 rewrites / CSP の宛先を更新

`apps/web/vercel.json` の `destination` と CSP の `connect-src` を実際の Worker ドメインへ変更します。

```json
{
  "source": "/api/v1/:path*",
  "destination": "https://<api-domain>/v1/:path*"
}
```

- `/api/:path*`（互換）、`/compat/:path*`（専ブラ互換）も同じ Worker へプロキシする
- CSP の `connect-src` には `https://<api-domain>` と `wss://<api-domain>` を明示する
  （実況 WebSocket は rewrites で中継できないため Worker へ直接接続する）
- vercel.json は **Root Directory（`apps/web`）側**に置く。リポジトリルートから `vercel deploy` しても
  Root Directory 側の設定が読まれる
- SPA フォールバック以外のパス（`/api/*`, `/compat/*`）は Worker へ proxy する

### 7.3 デプロイ

```sh
cd apps/web
vercel link
vercel --prod
```

または GitHub 連携で `apps/web` を root に設定し、main への push で自動デプロイ（Vercel 側の設定）。
本リポジトリの CI からは**自動デプロイしません**（§9 の手動 workflow のみ）。
CLI からデプロイする場合はリポジトリルートで `vercel deploy --prod` を実行する
（`.vercelignore` が `node_modules` / `.next` / `out` をアップロード対象から除く）。

## 8. 初回セットアップ

1. `https://<web-domain>/admin` を開く（owner 未作成ならセットアップ画面）
2. `OWNER_BOOTSTRAP_KEY`・表示名・メール・パスワード・TOTP を入力
   - API: `POST /v1/admin/owner/setup`（一度だけ。作成後は 409）
   - TOTP secret は `otpauth://` URI を QR で読み取り
3. リカバリーコード 10 個を安全に保管
4. **`OWNER_BOOTSTRAP_KEY` をローテーション**（`wrangler secret put`）
5. 特別管理人の招待は [`docs/special-admin.md`](special-admin.md)

## 9. GitHub Actions からの手動デプロイ

`.github/workflows/deploy.yml` は **workflow_dispatch のみ**です（自動デプロイなし）。

Repository secrets:

| secret | 必須 | 用途 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ✓ | Workers / D1 のデプロイ |
| `CLOUDFLARE_ACCOUNT_ID` | ✓ | アカウント指定 |
| `VERCEL_TOKEN` | web を出す場合 | Vercel CLI |
| `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | web を出す場合 | プロジェクト指定 |

実行順:

1. `wrangler d1 migrations apply open-clone --remote`（入力 `apply_migrations` が true のとき）
2. `wrangler deploy`
3. `pnpm --filter web build`
4. `vercel pull` → `vercel build` → `vercel deploy --prebuilt --prod`（入力 `deploy_web` が true のとき）

## 10. ロールバック

### 10.1 Worker

```sh
# 直前のデプロイへ戻す
wrangler rollback

# 特定のバージョンへ
wrangler deployments list
wrangler rollback <deployment-id>
```

- 秘密・D1 はロールバック対象外。コードとスキーマの不整合に注意
- ロールバック後は `/v1/health` と主要導線を確認

### 10.2 D1（データ）

```sh
# Time Travel（30 日以内）
wrangler d1 time-travel restore open-clone --timestamp=<unix-seconds>

# 事前エクスポートがある場合
wrangler d1 export open-clone --remote --output backup-before-change.sql
```

- **migration は原則 forward-only**。破壊的変更の前に必ず export を取る
- 失敗した migration を手で削除しない。新しい migration で修正する

### 10.3 Vercel

- ダッシュボード → Deployments → 対象の過去デプロイ → **Promote to Production**
- または `vercel rollback <deployment-url>`
- `apps/web/vercel.json` の rewrite 先を戻した場合は再デプロイが必要

### 10.4 復旧チェックリスト

1. `curl -fsS https://<api-domain>/v1/health`
2. `curl -fsS https://<web-domain>/api/v1/health`
3. トップページ / 板一覧 / スレ閲覧 / 投稿（Turnstile）
4. ログイン / 管理画面 / 特別管理人ダッシュボード
5. AI 緊急停止が意図せず ON でないこと
6. 使用量（`/v1/meta/usage`）とエラーログ

## 11. 無料枠・運用上の注意

- Workers Free: 100,000 req/日、CPU 10ms/req。PBKDF2 は 100,000 iter 固定
- D1 Free: 500MB/DB、5M read / 100k write 行/日。1 投稿 ≤12 行
- DO Free: SQLite-backed のみ。Hibernation 必須
- Cron 5 枠は割当済み（追加不可）
- **Vercel Hobby は非商用のみ**。商用化には Pro が必要
- **Catbox は非商用**。Cloudinary は 25 credits/月
- 上限超過は課金ではなく停止。監視は [`docs/operations.md`](operations.md)

## 12. デプロイ後の確認（受入）

- [ ] `GET /v1/health` が 200
- [ ] web の `/` が表示され、`/api/v1/health` が rewrites 経由で 200
- [ ] owner セットアップ（一度だけ）とログイン
- [ ] 板作成 → スレ作成 → 投稿 → 表示（Turnstile 含む）
- [ ] 画像アップロード（Catbox / Cloudinary）
- [ ] GitHub 連携（任意）
- [ ] プラグイン作成 → 公開 → 導入
- [ ] AI agent 登録 → MCP `tools/list` → low/medium 実行 → high キュー
- [ ] 特別管理人招待 → TOTP 就任
- [ ] 緊急停止 → AI 503 → 解除
- [ ] gitleaks / CI がグリーン