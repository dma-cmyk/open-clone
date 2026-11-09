# REST API 仕様

> このファイルは `tools/gen-api-docs.ts` が生成する。**手編集しない**。
> 生成: `pnpm --filter e2e gen:api-docs`
> 正本: `packages/shared/src/schemas/*.ts`（zod）と `apps/api/src/routes/*.ts`。
> 未実装のルートは「501 スタブ」と明記し、実装済みと推測で書かない。

## 1. 共通仕様

### 1.1 レスポンス envelope

成功: `200` / `201`

```json
{ "ok": true, "data": { } }
```

失敗: `4xx` / `5xx`

```json
{ "ok": false, "code": "ERROR_CODE", "message": "人間向け説明", "details": null }
```

`details` は省略可能。`ZodError` は `400 VALIDATION` と `details: issues` に変換される。

### 1.2 エラーコード

| code | 意味 |
|---|---|
| `INTERNAL` | 想定外の内部エラー（詳細は返さない） |
| `MISCONFIGURED` | サーバ設定不足（secret 未設定等） |
| `NOT_FOUND` | リソース不在 / ルート不在 |
| `NOT_IMPLEMENTED` | 未実装（WP スタブ） |
| `VALIDATION` | 入力検証エラー |
| `BAD_REQUEST` | 不正なリクエスト |
| `UNAUTHORIZED` | 認証が必要 |
| `FORBIDDEN` | 権限不足 |
| `BAD_ORIGIN` | Origin/CSRF 検証失敗 |
| `TURNSTILE_FAILED` | Turnstile 検証失敗 |
| `RATE_LIMITED` | レート制限 |
| `BANNED` | アクセス禁止 |
| `CONFLICT` | 競合（重複・状態不整合） |
| `PAYLOAD_TOO_LARGE` | 本文サイズ超過 |
| `AI_STOPPED` | AI 緊急停止中 |
| `BAD_GATEWAY` | 外部サービス応答異常 |
| `SERVICE_UNAVAILABLE` | 要確認 |
| `AI_DISABLED` | 要確認 |
| `TOTP_REQUIRED` | TOTP コードの入力が必要（ログイン二段目） |
| `TOTP_INVALID` | TOTP コードが不正（残り試行回数を details.remaining で返す） |
| `TOTP_LOCKED` | TOTP 失敗回数が上限。ロック解除まで待機（details.lockedUntil） |
| `STEP_UP_REQUIRED` | 高リスク操作に TOTP step-up（再認証）が必要 |
| `INVITE_INVALID` | 招待キーが無効・期限切れ・使用済み |
| `OWNER_SETUP_CLOSED` | owner 初期設定は完了済み（再実行不可） |

### 1.3 認証

- セッション Cookie: `oc_sess`（HttpOnly）。`Authorization: Bearer ocai_...` は AI agent 用。
- 端末 Cookie: `oc_did`（HttpOnly、初回リクエストで発行）。
- mutation（POST/PUT/PATCH/DELETE）は `Origin` が `ALLOWED_ORIGINS` に一致すること。
- 権限は `packages/shared/src/schemas/permission.ts` の `can()` とサーバ側ミドルウェアで強制。

### 1.4 レート制限（`shared/constants.ts`）

| scope | window | max |
|---|---|---|
| post | 30s | 3 |
| threadCreate | 300s | 2 |
| kome | 10s | 5 |
| login | 300s | 10 |
| register | 86400s | 5 |
| report | 300s | 5 |
| upload | 86400s | 50 |
| aiAction | 60s | 30 |
| pluginAi | 60s | 10 |
| pluginAuthor | 60s | 30 |
| postIp | 300s | 40 |
| threadCreateIp | 300s | 12 |
| komeIp | 60s | 30 |
| uploadIp | 86400s | 100 |
| readCompat | 60s | 180 |
| readSearch | 60s | 30 |
| readRanking | 60s | 60 |
| readList | 60s | 120 |
| rtTicket | 60s | 30 |

## 2. エンドポイント一覧（自動抽出）

| Method | Path | ミドルウェア | ファイル | 行 |
|---|---|---|---|---|
| GET | `/me` | `requireAuth` | `accounts.ts` | 37 |
| PATCH | `/me` | `requireAuth` | `accounts.ts` | 47 |
| POST | `/me/password` | `requireAuth` | `accounts.ts` | 77 |
| GET | `/me/sessions` | `requireAuth` | `accounts.ts` | 100 |
| DELETE | `/me/sessions/:id` | `requireAuth` | `accounts.ts` | 118 |
| POST | `/me/sessions/revoke-others` | `requireAuth` | `accounts.ts` | 139 |
| POST | `/owner/setup` | — | `admin.ts` | 57 |
| GET | `/overview` | `requireAdminActive` | `admin.ts` | 109 |
| GET | `/users` | `requireAdminActive` | `admin.ts` | 137 |
| GET | `/users/:id` | `requireAdminActive` | `admin.ts` | 200 |
| GET | `/suspensions` | `requireAdminActive` | `admin.ts` | 228 |
| POST | `/suspensions` | `requireAdminActive` | `admin.ts` | 238 |
| POST | `/suspensions/:id/lift` | `requireAdminActive` | `admin.ts` | 253 |
| DELETE | `/suspensions/:id` | `requireAdminActive` | `admin.ts` | 268 |
| GET | `/audit` | `requireAdminActive` | `admin.ts` | 285 |
| GET | `/site-config` | `requireAdminActive`, `requireOwnerActive` | `admin.ts` | 352 |
| PUT | `/site-config` | `requireOwnerActive` | `admin.ts` | 356 |
| GET | `/special-admins` | `requireOwnerActive` | `admin.ts` | 373 |
| POST | `/special-admins/:id/stop` | `requireOwnerActive` | `admin.ts` | 387 |
| POST | `/special-admins/:id/restore` | `requireOwnerActive` | `admin.ts` | 406 |
| POST | `/special-admins/:id/totp-reset` | `requireOwnerActive` | `admin.ts` | 423 |
| POST | `/complete` | — | `ai.ts` | 195 |
| GET | `/me` | — | `ai.ts` | 209 |
| POST | `/act` | — | `ai.ts` | 220 |
| GET | `/boards` | — | `ai.ts` | 226 |
| GET | `/boards/:id` | — | `ai.ts` | 235 |
| GET | `/threads` | — | `ai.ts` | 240 |
| GET | `/threads/:id` | — | `ai.ts` | 249 |
| GET | `/threads/:id/posts` | — | `ai.ts` | 254 |
| GET | `/posts/:id` | — | `ai.ts` | 263 |
| GET | `/search` | — | `ai.ts` | 268 |
| GET | `/feed` | — | `ai.ts` | 279 |
| GET | `/reports` | — | `ai.ts` | 288 |
| GET | `/reports/:id` | — | `ai.ts` | 298 |
| POST | `/reports/:id/triage` | — | `ai.ts` | 309 |
| POST | `/posts` | — | `ai.ts` | 325 |
| POST | `/posts/:id/hide` | — | `ai.ts` | 332 |
| POST | `/posts/:id/spam` | — | `ai.ts` | 338 |
| POST | `/posts/:id/delete` | — | `ai.ts` | 344 |
| PATCH | `/boards/:id/settings` | — | `ai.ts` | 359 |
| POST | `/plugins/:id/review` | — | `ai.ts` | 368 |
| POST | `/suspend-self` | — | `ai.ts` | 383 |
| GET | `/queue` | — | `ai.ts` | 391 |
| POST | `/queue/:id/decide` | `requireAuth` | `ai.ts` | 416 |
| GET | `/audit` | — | `ai.ts` | 443 |
| POST | `/agents` | `requireAuth` | `ai.ts` | 477 |
| GET | `/agents` | `requireAuth` | `ai.ts` | 500 |
| GET | `/agents/:id` | `requireAuth` | `ai.ts` | 510 |
| PATCH | `/agents/:id` | `requireAuth` | `ai.ts` | 515 |
| POST | `/agents/:id/rotate-key` | `requireAuth` | `ai.ts` | 547 |
| POST | `/agents/:id/suspend` | `requireAuth` | `ai.ts` | 570 |
| POST | `/agents/:id/resume` | `requireAuth` | `ai.ts` | 595 |
| DELETE | `/agents/:id` | `requireAuth` | `ai.ts` | 614 |
| GET | `/policies` | `requireAuth` | `ai.ts` | 635 |
| PUT | `/policies` | `requireAuth` | `ai.ts` | 698 |
| DELETE | `/policies/:id` | `requireAuth` | `ai.ts` | 773 |
| GET | `/status` | `requireAuth` | `ai.ts` | 804 |
| POST | `/stop` | `requireAuth` | `ai.ts` | 864 |
| POST | `/resume` | `requireAuth` | `ai.ts` | 941 |
| GET | `/webhooks` | `requireAuth` | `ai.ts` | 1007 |
| POST | `/webhooks` | `requireAuth` | `ai.ts` | 1020 |
| PATCH | `/webhooks/:id` | `requireAuth` | `ai.ts` | 1048 |
| DELETE | `/webhooks/:id` | `requireAuth` | `ai.ts` | 1064 |
| POST | `/webhooks/:id/test` | `requireAuth` | `ai.ts` | 1079 |
| GET | `/webhooks/:id/deliveries` | `requireAuth` | `ai.ts` | 1086 |
| GET | `/metrics` | `requireAuth` | `ai.ts` | 1094 |
| GET | `/actions` | `requireAuth` | `ai.ts` | 1100 |
| POST | `/register` | `requireTurnstile` | `auth.ts` | 81 |
| POST | `/login` | `requireTurnstile` | `auth.ts` | 147 |
| POST | `/logout` | — | `auth.ts` | 222 |
| GET | `/session` | `requireAuth` | `auth.ts` | 229 |
| GET | `/totp/status` | `requireAuth` | `auth.ts` | 238 |
| POST | `/totp/setup` | `requireAuth` | `auth.ts` | 244 |
| POST | `/totp/enable` | `requireAuth` | `auth.ts` | 251 |
| POST | `/totp/disable` | `requireAuth` | `auth.ts` | 265 |
| POST | `/recovery-codes/regenerate` | `requireAuth` | `auth.ts` | 279 |
| POST | `/recovery` | `requireTurnstile` | `auth.ts` | 294 |
| GET | `/github/status` | — | `auth.ts` | 361 |
| GET | `/github/start` | — | `auth.ts` | 365 |
| POST | `/github/callback` | — | `auth.ts` | 371 |
| POST | `/step-up` | `requireAuth` | `auth.ts` | 399 |
| GET | `/` | — | `boards.ts` | 42 |
| POST | `/` | `requireAuth` | `boards.ts` | 98 |
| GET | `/:slug` | — | `boards.ts` | 169 |
| PATCH | `/:slug` | `requireAuth` | `boards.ts` | 219 |
| DELETE | `/:slug` | `requireAuth` | `boards.ts` | 258 |
| GET | `/:slug/threads` | — | `boards.ts` | 281 |
| POST | `/:slug/threads` | — | `boards.ts` | 305 |
| GET | `/:slug/staff` | — | `boards.ts` | 333 |
| POST | `/:slug/staff` | `requireAuth` | `boards.ts` | 356 |
| DELETE | `/:slug/staff/:accountId` | `requireAuth` | `boards.ts` | 389 |
| GET | `/:slug/bans` | `requireAuth` | `boards.ts` | 418 |
| POST | `/:slug/bans` | `requireAuth` | `boards.ts` | 455 |
| DELETE | `/:slug/bans/:id` | `requireAuth` | `boards.ts` | 492 |
| GET | `/:slug/subject.txt` | — | `compat.ts` | 59 |
| GET | `/:slug/dat/:file` | — | `compat.ts` | 105 |
| GET | `/bbsmenu.html` | — | `compat.ts` | 143 |
| GET | `/:slug/SETTING.TXT` | — | `compat.ts` | 162 |
| GET | `/:slug/index.rdf` | — | `compat.ts` | 180 |
| POST | `/:slug/bbs.cgi` | — | `compat.ts` | 204 |
| GET | `/` | `requireAuth` | `github-auth.ts` | 67 |
| GET | `/start` | `requireAuth` | `github-auth.ts` | 74 |
| POST | `/callback` | `requireAuth` | `github-auth.ts` | 91 |
| POST | `/pat` | `requireAuth` | `github-auth.ts` | 140 |
| DELETE | `/` | `requireAuth` | `github-auth.ts` | 180 |
| GET | `/repos` | `requireAuth` | `github-files.ts` | 61 |
| GET | `/rate` | `requireAuth` | `github-files.ts` | 71 |
| GET | `/gists` | `requireAuth` | `github-files.ts` | 78 |
| POST | `/gists` | `requireAuth` | `github-files.ts` | 93 |
| GET | `/gists/:id` | `requireAuth` | `github-files.ts` | 105 |
| PATCH | `/gists/:id` | `requireAuth` | `github-files.ts` | 110 |
| DELETE | `/gists/:id` | `requireAuth` | `github-files.ts` | 121 |
| GET | `/repo/:owner/:repo/content` | `requireAuth` | `github-files.ts` | 129 |
| PUT | `/repo/:owner/:repo/content` | `requireAuth` | `github-files.ts` | 139 |
| DELETE | `/repo/:owner/:repo/content` | `requireAuth` | `github-files.ts` | 156 |
| POST | `/github` | — | `github-files.ts` | 174 |
| POST | `/` | `requireOwnerActive` | `invites.ts` | 60 |
| GET | `/` | `requireOwnerActive` | `invites.ts` | 97 |
| POST | `/:id/revoke` | `requireOwnerActive` | `invites.ts` | 108 |
| GET | `/inspect` | — | `invites.ts` | 125 |
| POST | `/prepare-totp` | — | `invites.ts` | 132 |
| POST | `/accept` | `requireTurnstile` | `invites.ts` | 174 |
| ALL | `/` | — | `mcp-plugin.ts` | 199 |
| ALL | `/legacy` | — | `mcp-plugin.ts` | 200 |
| ALL | `/` | — | `mcp.ts` | 112 |
| ALL | `/legacy` | — | `mcp.ts` | 113 |
| GET | `/health` | — | `meta.ts` | 10 |
| GET | `/usage` | `requireAdminActive` | `meta.ts` | 24 |
| POST | `/fetch` | — | `plugin-net.ts` | 24 |
| GET | `/log` | `requireRole` | `plugin-net.ts` | 105 |
| POST | `/revoke-all` | `requireAuth` | `plugin-tokens.ts` | 83 |
| DELETE | `/:id` | `requireAuth` | `plugin-tokens.ts` | 97 |
| GET | `/mine` | `requireAuth` | `plugins.ts` | 142 |
| GET | `/active` | — | `plugins.ts` | 155 |
| GET | `/installed` | — | `plugins.ts` | 187 |
| GET | `/reviews` | `requireRole` | `plugins.ts` | 253 |
| POST | `/preview-check` | `requireAuth` | `plugins.ts` | 267 |
| POST | `/import/gist` | `requireAuth` | `plugins.ts` | 274 |
| POST | `/import/repo` | `requireAuth` | `plugins.ts` | 298 |
| POST | `/hooks/github` | — | `plugins.ts` | 330 |
| GET | `/:id` | — | `plugins.ts` | 442 |
| GET | `/:id/versions` | — | `plugins.ts` | 453 |
| GET | `/:id/code` | — | `plugins.ts` | 475 |
| POST | `/:id/versions` | `requireAuth` | `plugins.ts` | 513 |
| POST | `/:id/publish` | `requireAuth` | `plugins.ts` | 545 |
| POST | `/:id/install` | — | `plugins.ts` | 589 |
| POST | `/:id/update` | — | `plugins.ts` | 656 |
| POST | `/:id/uninstall` | — | `plugins.ts` | 687 |
| POST | `/:id/report` | — | `plugins.ts` | 708 |
| GET | `/:id/reports` | — | `plugins.ts` | 731 |
| POST | `/:id/disable` | — | `plugins.ts` | 742 |
| POST | `/:id/enable` | — | `plugins.ts` | 778 |
| DELETE | `/:id` | — | `plugins.ts` | 792 |
| POST | `/:id/fork` | `requireAuth` | `plugins.ts` | 810 |
| GET | `/:id/state` | — | `plugins.ts` | 853 |
| POST | `/:id/state` | — | `plugins.ts` | 876 |
| DELETE | `/:id/state` | — | `plugins.ts` | 911 |
| POST | `/:id/review` | `requireRole` | `plugins.ts` | 938 |
| GET | `/:id/review` | `requireRole` | `plugins.ts` | 970 |
| POST | `/:id/export/gist` | `requireAuth` | `plugins.ts` | 986 |
| POST | `/:id/export/repo` | `requireAuth` | `plugins.ts` | 1012 |
| POST | `/:id/sync` | `requireAuth` | `plugins.ts` | 1051 |
| GET | `/:id` | — | `posts.ts` | 46 |
| POST | `/` | — | `posts.ts` | 68 |
| POST | `/kome` | — | `posts.ts` | 96 |
| POST | `/:id/like` | — | `posts.ts` | 126 |
| GET | `/:id/like` | — | `posts.ts` | 159 |
| POST | `/:id/hide` | `requireAuth` | `posts.ts` | 176 |
| POST | `/:id/restore` | `requireAuth` | `posts.ts` | 185 |
| DELETE | `/:id` | `requireAuth` | `posts.ts` | 194 |
| GET | `/:id/poll` | — | `posts.ts` | 206 |
| POST | `/:id/poll/vote` | — | `posts.ts` | 245 |
| GET | `/:id/backlinks` | — | `posts.ts` | 272 |
| GET | `/` | — | `ranking.ts` | 210 |
| POST | `/` | — | `reports.ts` | 125 |
| GET | `/` | `requireAuth` | `reports.ts` | 178 |
| GET | `/:id` | `requireAuth` | `reports.ts` | 236 |
| POST | `/:id/handle` | `requireAuth` | `reports.ts` | 260 |
| POST | `/ticket` | — | `rt.ts` | 27 |
| GET | `/` | — | `rt.ts` | 37 |
| GET | `/stats` | — | `rt.ts` | 67 |
| GET | `/recent` | — | `rt.ts` | 77 |
| GET | `/` | — | `search.ts` | 98 |
| GET | `/suggest` | — | `search.ts` | 307 |
| GET | `/stats` | — | `search.ts` | 320 |
| GET | `/` | — | `threads.ts` | 39 |
| GET | `/:id` | — | `threads.ts` | 58 |
| GET | `/:id/posts` | — | `threads.ts` | 86 |
| POST | `/:id/posts` | — | `threads.ts` | 110 |
| POST | `/:id/kome` | — | `threads.ts` | 135 |
| PATCH | `/:id` | `requireAuth` | `threads.ts` | 164 |
| DELETE | `/:id` | `requireAuth` | `threads.ts` | 190 |
| GET | `/:id/range` | — | `threads.ts` | 206 |
| GET | `/adapters` | — | `uploads.ts` | 167 |
| POST | `/prepare` | — | `uploads.ts` | 178 |
| POST | `/proxy` | — | `uploads.ts` | 239 |
| POST | `/commit` | — | `uploads.ts` | 335 |
| GET | `/history` | — | `uploads.ts` | 416 |
| GET | `/:id` | — | `uploads.ts` | 436 |
| GET | `/:id/raw` | — | `uploads.ts` | 444 |
| DELETE | `/:id` | — | `uploads.ts` | 477 |

## 3. ルートファイル別の実装状況

| ファイル | 所有 | mount | 状態 |
|---|---|---|---|
| `meta.ts` | WP0 | `/v1/meta, /v1（health alias）` | 実装あり |
| `auth.ts` | WP6 | `/v1/auth` | 実装あり |
| `github-auth.ts` | WP4 | `/v1/github/oauth, /v1/github/link` | 実装あり |
| `accounts.ts` | WP6 | `/v1/accounts` | 実装あり |
| `invites.ts` | WP6 | `/v1/admin/invites` | 実装あり |
| `admin.ts` | WP6 | `/v1/admin` | 実装あり |
| `boards.ts` | WP1 | `/v1/boards` | 実装あり |
| `threads.ts` | WP1 | `/v1/threads` | 実装あり |
| `posts.ts` | WP1 | `/v1/posts` | 実装あり |
| `search.ts` | WP1 | `/v1/search` | 実装あり |
| `ranking.ts` | WP1 | `/v1/ranking, /v1/headline` | 実装あり |
| `reports.ts` | WP1 | `/v1/reports` | 実装あり |
| `compat.ts` | WP1 | `/compat` | 実装あり |
| `rt.ts` | WP1 | `/v1/rt, /rt` | 実装あり |
| `uploads.ts` | WP4 | `/v1/uploads` | 実装あり |
| `github-files.ts` | WP4 | `/v1/github/files, /v1/github/hooks` | 実装あり |
| `plugins.ts` | WP3 | `/v1/plugins` | 実装あり |
| `plugin-net.ts` | WP3 | `/v1/plugin-net` | 実装あり |
| `ai.ts` | WP5 | `/v1/ai` | 実装あり |
| `mcp.ts` | WP5 | `/mcp, /mcp/legacy` | 実装あり |
| `plugin-tokens.ts` | WP-A | `/v1/me/plugin-tokens` | 実装あり |
| `mcp-plugin.ts` | WP-A | `/mcp-plugin, /mcp-plugin/legacy` | 実装あり |

## 4. 予定エンドポイント（WORKPACKAGES §3.2 の契約）

以下は契約上の予定であり、実装状況は §3 を参照。未実装のものは **要確認**。

| mount | 主な用途 | 所有 |
|---|---|---|
| `/v1/meta/*` | health / usage | WP0 |
| `/v1/auth/*` | register, login, logout, session, totp/*, recovery | WP6 |
| `/v1/github/oauth/*`, `/v1/github/link*` | GitHub OAuth / 連携 | WP4 |
| `/v1/accounts/*` | 自分情報、アカウント停止（admin） | WP6 |
| `/v1/admin/invites/*` | 招待キー発行 / accept | WP6 |
| `/v1/admin/*` | site settings, suspensions, audit, owner setup | WP6 |
| `/v1/boards/*` | 一覧, 作成, 詳細, 設定, スタッフ任免 | WP1 |
| `/v1/threads/*` | 一覧, 作成, レス取得 ?since, 実況 | WP1 |
| `/v1/posts/*` | 作成, kome, 削除/非表示, 投票, 安価 | WP1 |
| `/v1/search/*` | スレタイ/全文/ID/画像検索 | WP1 |
| `/v1/ranking/*`, `/v1/headline/*` | ランキング / ヘッドライン | WP1 |
| `/v1/reports/*` | 通報作成, 一覧, 処理 | WP1 |
| `/compat/*` | subject.txt, dat, bbs.cgi 互換, rss（Shift_JIS） | WP1 |
| `/v1/rt/ticket`, `/rt` | WebSocket ticket / 接続 | WP1 |
| `/v1/uploads/*` | prepare, proxy, commit, history, delete | WP4 |
| `/v1/github/files/*`, `/v1/github/hooks/*` | repo/gist CRUD プロキシ, webhook | WP4 |
| `/v1/plugins/*` | CRUD, code 配信, install, review, hooks/github | WP3 |
| `/v1/plugin-net/*` | サンドボックス net:fetch プロキシ | WP3 |
| `/v1/ai/*` | agents CRUD, policies, queue, audit, stop, webhooks | WP5 |
| `/mcp`, `/mcp/legacy` | MCP サーバー（ステートレス / 旧互換） | WP5 |

## 5. スキーマ（zod → JSON Schema）

### `packages/shared/src/schemas/account.ts`

#### `accountSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 26,
      "maxLength": 26
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "email": {
      "anyOf": [
        {
          "type": "string",
          "format": "email",
          "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "special_admin",
        "user"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "name",
    "email",
    "role",
    "status",
    "createdAt"
  ]
}
```

#### `accountStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "active",
    "suspended"
  ]
}
```

#### `globalRoleSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "owner",
    "special_admin",
    "user"
  ]
}
```

#### `loginRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "password": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "totpCode": {
      "type": "string",
      "pattern": "^\\d{6}$"
    },
    "turnstileToken": {
      "type": "string"
    }
  },
  "required": [
    "email",
    "password"
  ]
}
```

#### `registerRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "password": {
      "type": "string",
      "minLength": 8,
      "maxLength": 256
    },
    "turnstileToken": {
      "type": "string"
    }
  },
  "required": [
    "name",
    "email",
    "password"
  ]
}
```

#### `sessionSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "account",
    "expiresAt"
  ]
}
```

### `packages/shared/src/schemas/admin.ts`

#### `adminOverviewSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "accounts": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "activeSessions": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "specialAdmins": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "stoppedSpecialAdmins": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "activeSuspensions": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "pendingInvites": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "auditEvents24h": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "ownerExists": {
      "type": "boolean"
    }
  },
  "required": [
    "accounts",
    "activeSessions",
    "specialAdmins",
    "stoppedSpecialAdmins",
    "activeSuspensions",
    "pendingInvites",
    "auditEvents24h",
    "ownerExists"
  ]
}
```

#### `adminUserSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "email": {
      "type": [
        "string",
        "null"
      ]
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "special_admin",
        "user"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "specialAdminStopped": {
      "type": "boolean"
    },
    "activeSuspensions": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "name",
    "email",
    "role",
    "status",
    "createdAt",
    "specialAdminStopped",
    "activeSuspensions"
  ]
}
```

#### `auditLogEntrySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "actorType": {
      "type": "string",
      "enum": [
        "owner",
        "special_admin",
        "account",
        "board_staff",
        "system"
      ]
    },
    "actorId": {
      "type": [
        "string",
        "null"
      ]
    },
    "actorName": {
      "type": [
        "string",
        "null"
      ]
    },
    "action": {
      "type": "string"
    },
    "target": {
      "type": [
        "string",
        "null"
      ]
    },
    "detail": {},
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "actorType",
    "actorId",
    "actorName",
    "action",
    "target",
    "detail",
    "createdAt"
  ]
}
```

#### `auditLogQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "action": {
      "type": "string"
    },
    "actorId": {
      "type": "string"
    },
    "since": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "page": {
      "default": 1,
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "limit": {
      "default": 50,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  }
}
```

#### `inviteAcceptRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "minLength": 8
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "password": {
      "type": "string",
      "minLength": 8,
      "maxLength": 256
    },
    "totpSecret": {
      "type": "string",
      "minLength": 16
    },
    "totpCode": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": [
    "key",
    "name",
    "email",
    "password",
    "totpSecret",
    "totpCode"
  ]
}
```

#### `inviteAcceptResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "recoveryCodes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "boardAssignment": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "boardId": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "level": {
              "type": "string",
              "enum": [
                "admin",
                "deputy",
                "moderator"
              ]
            }
          },
          "required": [
            "boardId",
            "level"
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "account",
    "expiresAt",
    "recoveryCodes",
    "boardAssignment"
  ]
}
```

#### `inviteInspectSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "valid": {
      "type": "boolean"
    },
    "kind": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "special_admin",
            "board_staff"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "note": {
      "type": [
        "string",
        "null"
      ]
    },
    "accountName": {
      "type": [
        "string",
        "null"
      ]
    },
    "email": {
      "type": [
        "string",
        "null"
      ]
    },
    "reason": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "valid",
    "kind",
    "expiresAt",
    "note",
    "accountName",
    "email",
    "reason"
  ]
}
```

#### `inviteIssueRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "kind": {
      "default": "special_admin",
      "type": "string",
      "enum": [
        "special_admin",
        "board_staff"
      ]
    },
    "expiresInHours": {
      "type": "integer",
      "minimum": 1,
      "maximum": 720
    },
    "note": {
      "type": "string",
      "maxLength": 200
    },
    "accountId": {
      "type": "string",
      "minLength": 26,
      "maxLength": 26
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "level": {
      "type": "string",
      "enum": [
        "admin",
        "deputy",
        "moderator"
      ]
    }
  }
}
```

#### `inviteIssueResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "key": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "special_admin",
        "board_staff"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "acceptPath": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "key",
    "kind",
    "expiresAt",
    "acceptPath"
  ]
}
```

#### `inviteKindSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "special_admin",
    "board_staff"
  ]
}
```

#### `inviteSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "special_admin",
        "board_staff"
      ]
    },
    "note": {
      "type": [
        "string",
        "null"
      ]
    },
    "issuedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "usedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "revokedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "state": {
      "type": "string",
      "enum": [
        "pending",
        "used",
        "expired",
        "revoked"
      ]
    }
  },
  "required": [
    "id",
    "kind",
    "note",
    "issuedBy",
    "createdAt",
    "expiresAt",
    "usedAt",
    "revokedAt",
    "state"
  ]
}
```

#### `ownerBootstrapRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "bootstrapKey": {
      "type": "string",
      "minLength": 1
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "password": {
      "type": "string",
      "minLength": 8,
      "maxLength": 256
    },
    "totpSecret": {
      "type": "string",
      "minLength": 16
    },
    "totpCode": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": [
    "bootstrapKey",
    "name",
    "email",
    "password",
    "totpSecret",
    "totpCode"
  ]
}
```

#### `ownerBootstrapResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "recoveryCodes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "account",
    "expiresAt",
    "recoveryCodes"
  ]
}
```

#### `siteSettingsSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "site.name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "site.description": {
      "type": "string",
      "maxLength": 300
    },
    "registration.open": {
      "type": "boolean"
    },
    "security.require_turnstile": {
      "type": "string",
      "enum": [
        "always",
        "auto",
        "off"
      ]
    },
    "security.special_admin_totp_required": {
      "type": "boolean"
    },
    "security.login_max_failures": {
      "type": "integer",
      "minimum": 3,
      "maximum": 50
    },
    "plugin.ai.baseUrl": {
      "anyOf": [
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "string",
          "maxLength": 500,
          "format": "uri"
        }
      ]
    },
    "plugin.ai.model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    }
  },
  "required": [
    "site.name",
    "site.description",
    "registration.open",
    "security.require_turnstile",
    "security.special_admin_totp_required",
    "security.login_max_failures",
    "plugin.ai.baseUrl",
    "plugin.ai.model"
  ]
}
```

#### `siteSettingsUpdateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "site.name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "site.description": {
      "type": "string",
      "maxLength": 300
    },
    "registration.open": {
      "type": "boolean"
    },
    "security.require_turnstile": {
      "type": "string",
      "enum": [
        "always",
        "auto",
        "off"
      ]
    },
    "security.special_admin_totp_required": {
      "type": "boolean"
    },
    "security.login_max_failures": {
      "type": "integer",
      "minimum": 3,
      "maximum": 50
    },
    "plugin.ai.baseUrl": {
      "anyOf": [
        {
          "type": "string",
          "const": ""
        },
        {
          "type": "string",
          "maxLength": 500,
          "format": "uri"
        }
      ]
    },
    "plugin.ai.model": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    }
  }
}
```

#### `specialAdminSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "email": {
      "type": [
        "string",
        "null"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended"
      ]
    },
    "stoppedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "stoppedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "stopReason": {
      "type": [
        "string",
        "null"
      ]
    },
    "totpEnabled": {
      "type": "boolean"
    },
    "recoveryRemaining": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "name",
    "email",
    "status",
    "stoppedAt",
    "stoppedBy",
    "stopReason",
    "totpEnabled",
    "recoveryRemaining",
    "createdAt"
  ]
}
```

#### `specialAdminStopRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  },
  "required": [
    "reason"
  ]
}
```

#### `specialAdminTotpResetRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reinvite": {
      "default": false,
      "type": "boolean"
    },
    "note": {
      "type": "string",
      "maxLength": 200
    }
  }
}
```

#### `specialAdminTotpResetResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "invite": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string"
            },
            "key": {
              "type": "string"
            },
            "kind": {
              "type": "string",
              "enum": [
                "special_admin",
                "board_staff"
              ]
            },
            "expiresAt": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "acceptPath": {
              "type": "string"
            }
          },
          "required": [
            "id",
            "key",
            "kind",
            "expiresAt",
            "acceptPath"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "sessionsRevoked": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "invite",
    "sessionsRevoked"
  ]
}
```

#### `suspensionCreateRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string",
      "minLength": 26,
      "maxLength": 26
    },
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "deviceHash": {
      "type": "string",
      "minLength": 8,
      "maxLength": 128
    },
    "scope": {
      "type": "string",
      "enum": [
        "site",
        "board"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "expiresAt": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "durationHours": {
      "type": "integer",
      "minimum": 1,
      "maximum": 8760
    }
  },
  "required": [
    "scope",
    "reason"
  ]
}
```

#### `suspensionSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "accountId": {
      "type": [
        "string",
        "null"
      ]
    },
    "email": {
      "type": [
        "string",
        "null"
      ]
    },
    "deviceHash": {
      "type": [
        "string",
        "null"
      ]
    },
    "scope": {
      "type": "string",
      "enum": [
        "site",
        "board"
      ]
    },
    "boardId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reason": {
      "type": "string"
    },
    "by": {
      "type": "string"
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "liftedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "active": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "accountId",
    "email",
    "deviceHash",
    "scope",
    "boardId",
    "reason",
    "by",
    "expiresAt",
    "liftedAt",
    "createdAt",
    "active"
  ]
}
```

#### `suspensionScopeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "site",
    "board"
  ]
}
```

#### `totpSecretPrepareRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "minLength": 8
    }
  },
  "required": [
    "key"
  ]
}
```

#### `totpSecretPrepareResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "secret": {
      "type": "string"
    },
    "otpauthUri": {
      "type": "string"
    }
  },
  "required": [
    "secret",
    "otpauthUri"
  ]
}
```

### `packages/shared/src/schemas/ai.ts`

#### `aiAgentSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": [
        "string",
        "null"
      ]
    },
    "ownerType": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "account"
      ]
    },
    "ownerId": {
      "type": "string"
    },
    "boardId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "allowedBoards": {
      "anyOf": [
        {
          "maxItems": 500,
          "type": "array",
          "items": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        {
          "type": "string",
          "const": "*"
        }
      ]
    },
    "riskCap": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended",
        "revoked"
      ]
    },
    "suspendedReason": {
      "type": [
        "string",
        "null"
      ]
    },
    "rateLimitPerMin": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "dailyLimit": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "displayName": {
      "type": "string"
    },
    "keyPrefix": {
      "type": "string"
    },
    "createdBy": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "lastUsedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "name",
    "description",
    "ownerType",
    "ownerId",
    "boardId",
    "allowedBoards",
    "riskCap",
    "status",
    "suspendedReason",
    "rateLimitPerMin",
    "dailyLimit",
    "displayName",
    "keyPrefix",
    "createdBy",
    "createdAt",
    "updatedAt",
    "lastUsedAt"
  ]
}
```

#### `aiAgentStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "active",
    "suspended",
    "revoked"
  ]
}
```

#### `aiAgentWithKeySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "description": {
      "type": [
        "string",
        "null"
      ]
    },
    "ownerType": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "account"
      ]
    },
    "ownerId": {
      "type": "string"
    },
    "boardId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "allowedBoards": {
      "anyOf": [
        {
          "maxItems": 500,
          "type": "array",
          "items": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        {
          "type": "string",
          "const": "*"
        }
      ]
    },
    "riskCap": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended",
        "revoked"
      ]
    },
    "suspendedReason": {
      "type": [
        "string",
        "null"
      ]
    },
    "rateLimitPerMin": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "dailyLimit": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "displayName": {
      "type": "string"
    },
    "keyPrefix": {
      "type": "string"
    },
    "createdBy": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "lastUsedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "apiKey": {
      "type": "string"
    },
    "keyWarning": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "name",
    "description",
    "ownerType",
    "ownerId",
    "boardId",
    "allowedBoards",
    "riskCap",
    "status",
    "suspendedReason",
    "rateLimitPerMin",
    "dailyLimit",
    "displayName",
    "keyPrefix",
    "createdBy",
    "createdAt",
    "updatedAt",
    "lastUsedAt",
    "apiKey",
    "keyWarning"
  ]
}
```

#### `aiAuditEntrySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "agentId": {
      "type": [
        "string",
        "null"
      ]
    },
    "actorType": {
      "type": "string",
      "enum": [
        "agent",
        "human",
        "system"
      ]
    },
    "actorId": {
      "type": [
        "string",
        "null"
      ]
    },
    "action": {
      "type": "string"
    },
    "risk": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high",
        "never"
      ]
    },
    "mode": {
      "type": "string"
    },
    "boardId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "paramsDigest": {
      "type": [
        "string",
        "null"
      ]
    },
    "paramsSummary": {
      "type": [
        "string",
        "null"
      ]
    },
    "queueId": {
      "type": [
        "string",
        "null"
      ]
    },
    "result": {
      "type": "string",
      "enum": [
        "ok",
        "queued",
        "denied",
        "error",
        "rate_limited",
        "stopped"
      ]
    },
    "errorCode": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "agentId",
    "actorType",
    "actorId",
    "action",
    "risk",
    "mode",
    "boardId",
    "paramsDigest",
    "paramsSummary",
    "queueId",
    "result",
    "errorCode",
    "createdAt"
  ]
}
```

#### `aiOwnerTypeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "site",
    "board",
    "account"
  ]
}
```

#### `aiPolicySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "scope": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "agent"
      ]
    },
    "scopeId": {
      "type": "string"
    },
    "action": {
      "type": "string"
    },
    "mode": {
      "type": "string",
      "enum": [
        "auto",
        "queue",
        "deny"
      ]
    },
    "updatedBy": {
      "type": "string"
    },
    "updatedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "scope",
    "scopeId",
    "action",
    "mode",
    "updatedBy",
    "updatedAt"
  ]
}
```

#### `aiQueueItemSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "agentId": {
      "type": "string"
    },
    "agentName": {
      "type": [
        "string",
        "null"
      ]
    },
    "action": {
      "type": "string"
    },
    "risk": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high",
        "never"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "approved",
        "rejected",
        "executed",
        "failed",
        "expired"
      ]
    },
    "boardId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "params": {},
    "summary": {
      "type": "string"
    },
    "evidence": {
      "anyOf": [
        {},
        {
          "type": "null"
        }
      ]
    },
    "idempotencyKey": {
      "type": [
        "string",
        "null"
      ]
    },
    "requestedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "decidedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "decidedBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "note": {
      "type": [
        "string",
        "null"
      ]
    },
    "executedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "result": {
      "anyOf": [
        {},
        {
          "type": "null"
        }
      ]
    },
    "error": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "agentId",
    "agentName",
    "action",
    "risk",
    "status",
    "boardId",
    "params",
    "summary",
    "evidence",
    "idempotencyKey",
    "requestedAt",
    "expiresAt",
    "decidedAt",
    "decidedBy",
    "note",
    "executedAt",
    "result",
    "error"
  ]
}
```

#### `aiStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "stop": {
      "type": "object",
      "properties": {
        "globalStopped": {
          "type": "boolean"
        },
        "stoppedAt": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "reason": {
          "type": [
            "string",
            "null"
          ]
        },
        "actorId": {
          "type": [
            "string",
            "null"
          ]
        },
        "boards": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "boardId": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "stoppedAt": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "reason": {
                "type": "string"
              },
              "actorId": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "boardId",
              "stoppedAt",
              "reason",
              "actorId"
            ]
          }
        },
        "updatedAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "globalStopped",
        "stoppedAt",
        "reason",
        "actorId",
        "boards",
        "updatedAt"
      ]
    },
    "counts": {
      "type": "object",
      "properties": {
        "agents": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "activeAgents": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "suspendedAgents": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "pendingQueue": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "executedToday": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "deniedToday": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "agents",
        "activeAgents",
        "suspendedAgents",
        "pendingQueue",
        "executedToday",
        "deniedToday"
      ]
    }
  },
  "required": [
    "stop",
    "counts"
  ]
}
```

#### `allowedBoardsSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "maxItems": 500,
      "type": "array",
      "items": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      }
    },
    {
      "type": "string",
      "const": "*"
    }
  ]
}
```

#### `auditResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "ok",
    "queued",
    "denied",
    "error",
    "rate_limited",
    "stopped"
  ]
}
```

#### `boardStopSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "boardId": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "stoppedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "reason": {
      "type": "string"
    },
    "actorId": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "boardId",
    "stoppedAt",
    "reason",
    "actorId"
  ]
}
```

#### `createAiAgentInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "description": {
      "type": "string",
      "maxLength": 1000
    },
    "ownerType": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "account"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "allowedBoards": {
      "anyOf": [
        {
          "maxItems": 500,
          "type": "array",
          "items": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        {
          "type": "string",
          "const": "*"
        }
      ]
    },
    "riskCap": {
      "default": "low",
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high"
      ]
    },
    "rateLimitPerMin": {
      "default": 30,
      "type": "integer",
      "minimum": 1,
      "maximum": 600
    },
    "dailyLimit": {
      "default": 2000,
      "type": "integer",
      "minimum": 1,
      "maximum": 100000
    },
    "displayName": {
      "default": "AI運営",
      "type": "string",
      "minLength": 1,
      "maxLength": 50
    }
  },
  "required": [
    "name",
    "ownerType",
    "allowedBoards"
  ],
  "additionalProperties": false
}
```

#### `putAiPolicyInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "agent"
      ]
    },
    "scopeId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "action": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "mode": {
      "type": "string",
      "enum": [
        "auto",
        "queue",
        "deny"
      ]
    }
  },
  "required": [
    "scope",
    "scopeId",
    "action",
    "mode"
  ],
  "additionalProperties": false
}
```

#### `queueDecideInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "decision": {
      "type": "string",
      "enum": [
        "approve",
        "reject"
      ]
    },
    "note": {
      "type": "string",
      "maxLength": 2000
    }
  },
  "required": [
    "decision"
  ],
  "additionalProperties": false
}
```

#### `queueStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "pending",
    "approved",
    "rejected",
    "executed",
    "failed",
    "expired"
  ]
}
```

#### `resumeRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "global",
        "board",
        "agent"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "agentId": {
      "type": "string",
      "maxLength": 64
    }
  },
  "required": [
    "scope"
  ],
  "additionalProperties": false
}
```

#### `stopRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "global",
        "board",
        "agent"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "agentId": {
      "type": "string",
      "maxLength": 64
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    }
  },
  "required": [
    "scope",
    "reason"
  ],
  "additionalProperties": false
}
```

#### `stopStateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "globalStopped": {
      "type": "boolean"
    },
    "stoppedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reason": {
      "type": [
        "string",
        "null"
      ]
    },
    "actorId": {
      "type": [
        "string",
        "null"
      ]
    },
    "boards": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "boardId": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "stoppedAt": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "reason": {
            "type": "string"
          },
          "actorId": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "boardId",
          "stoppedAt",
          "reason",
          "actorId"
        ]
      }
    },
    "updatedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "globalStopped",
    "stoppedAt",
    "reason",
    "actorId",
    "boards",
    "updatedAt"
  ]
}
```

#### `updateAiAgentInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "description": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 1000
        },
        {
          "type": "null"
        }
      ]
    },
    "allowedBoards": {
      "anyOf": [
        {
          "maxItems": 500,
          "type": "array",
          "items": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          }
        },
        {
          "type": "string",
          "const": "*"
        }
      ]
    },
    "rateLimitPerMin": {
      "type": "integer",
      "minimum": 1,
      "maximum": 600
    },
    "dailyLimit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100000
    },
    "displayName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 50
    },
    "riskCap": {
      "type": "string",
      "enum": [
        "low",
        "medium",
        "high"
      ]
    }
  },
  "additionalProperties": false
}
```

### `packages/shared/src/schemas/anchor.ts`

#### `anchorRefSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "raw": {
      "type": "string"
    },
    "nums": {
      "type": "array",
      "items": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      }
    }
  },
  "required": [
    "raw",
    "nums"
  ]
}
```

### `packages/shared/src/schemas/auth.ts`

#### `authSessionSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "totpSetupRequired": {
      "type": "boolean"
    },
    "totp": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "required": {
          "type": "boolean"
        },
        "recoveryRemaining": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "enabled",
        "required",
        "recoveryRemaining"
      ]
    },
    "specialAdminStopped": {
      "type": "boolean"
    },
    "stepUpActive": {
      "type": "boolean"
    }
  },
  "required": [
    "account",
    "expiresAt",
    "totpSetupRequired",
    "totp",
    "specialAdminStopped",
    "stepUpActive"
  ]
}
```

#### `githubLoginCallbackSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "state": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    }
  },
  "required": [
    "code",
    "state"
  ]
}
```

#### `githubLoginResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "created": {
      "type": "boolean"
    },
    "linkedExisting": {
      "type": "boolean"
    },
    "githubLogin": {
      "type": "string"
    }
  },
  "required": [
    "account",
    "expiresAt",
    "created",
    "linkedExisting",
    "githubLogin"
  ]
}
```

#### `githubLoginStartSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "authorizeUrl": {
      "type": "string",
      "format": "uri"
    },
    "state": {
      "type": "string"
    }
  },
  "required": [
    "authorizeUrl",
    "state"
  ]
}
```

#### `githubLoginStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "available": {
      "type": "boolean"
    }
  },
  "required": [
    "available"
  ]
}
```

#### `loginResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "totpSetupRequired": {
      "type": "boolean"
    }
  },
  "required": [
    "account",
    "expiresAt",
    "totpSetupRequired"
  ]
}
```

#### `passwordChangeRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "currentPassword": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "newPassword": {
      "type": "string",
      "minLength": 8,
      "maxLength": 256
    }
  },
  "required": [
    "currentPassword",
    "newPassword"
  ]
}
```

#### `profileSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 26,
      "maxLength": 26
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "email": {
      "anyOf": [
        {
          "type": "string",
          "format": "email",
          "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "role": {
      "type": "string",
      "enum": [
        "owner",
        "special_admin",
        "user"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "suspended"
      ]
    },
    "bio": {
      "type": "string",
      "maxLength": 500
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "name",
    "email",
    "role",
    "status",
    "bio",
    "createdAt"
  ]
}
```

#### `profileUpdateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "bio": {
      "type": "string",
      "maxLength": 500
    }
  }
}
```

#### `recoveryCodeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 8,
  "maxLength": 64
}
```

#### `recoveryRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "email": {
      "type": "string",
      "format": "email",
      "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
    },
    "password": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256
    },
    "code": {
      "type": "string",
      "minLength": 8,
      "maxLength": 64
    }
  },
  "required": [
    "email",
    "password",
    "code"
  ]
}
```

#### `recoveryResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "totpSetupRequired": {
      "type": "boolean"
    },
    "recoveryRemaining": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "account",
    "expiresAt",
    "totpSetupRequired",
    "recoveryRemaining"
  ]
}
```

#### `regenerateRecoveryRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": [
    "code"
  ]
}
```

#### `regenerateRecoveryResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "recoveryCodes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "recoveryCodes"
  ]
}
```

#### `registerResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "account": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 26,
          "maxLength": 26
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "email": {
          "anyOf": [
            {
              "type": "string",
              "format": "email",
              "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "role": {
          "type": "string",
          "enum": [
            "owner",
            "special_admin",
            "user"
          ]
        },
        "status": {
          "type": "string",
          "enum": [
            "active",
            "suspended"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "email",
        "role",
        "status",
        "createdAt"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "totpSetupRequired": {
      "type": "boolean"
    }
  },
  "required": [
    "account",
    "expiresAt",
    "totpSetupRequired"
  ]
}
```

#### `sessionInfoSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "ua": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "lastUsedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "current": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "ua",
    "createdAt",
    "lastUsedAt",
    "expiresAt",
    "current"
  ]
}
```

#### `sessionStateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "authenticated": {
          "type": "boolean",
          "const": false
        }
      },
      "required": [
        "authenticated"
      ]
    },
    {
      "type": "object",
      "properties": {
        "authenticated": {
          "type": "boolean",
          "const": true
        },
        "account": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "minLength": 26,
              "maxLength": 26
            },
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64
            },
            "email": {
              "anyOf": [
                {
                  "type": "string",
                  "format": "email",
                  "pattern": "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "role": {
              "type": "string",
              "enum": [
                "owner",
                "special_admin",
                "user"
              ]
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "suspended"
              ]
            },
            "createdAt": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "id",
            "name",
            "email",
            "role",
            "status",
            "createdAt"
          ]
        },
        "expiresAt": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "totpSetupRequired": {
          "type": "boolean"
        },
        "totp": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "required": {
              "type": "boolean"
            },
            "recoveryRemaining": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "enabled",
            "required",
            "recoveryRemaining"
          ]
        },
        "specialAdminStopped": {
          "type": "boolean"
        },
        "stepUpActive": {
          "type": "boolean"
        }
      },
      "required": [
        "authenticated",
        "account",
        "expiresAt",
        "totpSetupRequired",
        "totp",
        "specialAdminStopped",
        "stepUpActive"
      ]
    }
  ]
}
```

#### `stepUpRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "minLength": 6,
      "maxLength": 64
    }
  },
  "required": [
    "code"
  ]
}
```

#### `stepUpResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "verifiedUntil": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "verifiedUntil"
  ]
}
```

#### `totpCodeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "pattern": "^\\d{6}$"
}
```

#### `totpDisableRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": [
    "code"
  ]
}
```

#### `totpEnableRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "secret": {
      "type": "string"
    },
    "code": {
      "type": "string",
      "pattern": "^\\d{6}$"
    }
  },
  "required": [
    "code"
  ]
}
```

#### `totpEnableResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "recoveryCodes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "recoveryCodes"
  ]
}
```

#### `totpSetupResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "secret": {
      "type": "string"
    },
    "otpauthUri": {
      "type": "string"
    }
  },
  "required": [
    "secret",
    "otpauthUri"
  ]
}
```

#### `totpStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "enabled": {
      "type": "boolean"
    },
    "required": {
      "type": "boolean"
    },
    "lockedUntil": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "recoveryRemaining": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "enabled",
    "required",
    "lockedUntil",
    "recoveryRemaining"
  ]
}
```

### `packages/shared/src/schemas/board.ts`

#### `boardBanKindSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "device",
    "ip",
    "account"
  ]
}
```

#### `boardBanSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "boardId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "identity": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "device",
        "ip",
        "account"
      ]
    },
    "reason": {
      "type": "string"
    },
    "byAccountId": {
      "type": [
        "string",
        "null"
      ]
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "boardId",
    "identity",
    "kind",
    "reason",
    "byAccountId",
    "expiresAt",
    "createdAt"
  ]
}
```

#### `boardDesignSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "themeColor": {
      "default": "#ccffcc",
      "type": "string",
      "pattern": "^#[0-9a-fA-F]{6}$"
    },
    "accentColor": {
      "default": "#228811",
      "type": "string",
      "pattern": "^#[0-9a-fA-F]{6}$"
    },
    "bannerUrl": {
      "default": null,
      "anyOf": [
        {
          "type": "string",
          "maxLength": 512,
          "format": "uri"
        },
        {
          "type": "null"
        }
      ]
    },
    "css": {
      "default": "",
      "type": "string",
      "maxLength": 8192
    }
  }
}
```

#### `boardListQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "category": {
      "type": "string",
      "maxLength": 32
    },
    "q": {
      "type": "string",
      "maxLength": 100
    },
    "limit": {
      "default": 100,
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

#### `boardSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "slug": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "category": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "rulesMd": {
      "type": "string"
    },
    "design": {
      "type": "object",
      "properties": {
        "themeColor": {
          "default": "#ccffcc",
          "type": "string",
          "pattern": "^#[0-9a-fA-F]{6}$"
        },
        "accentColor": {
          "default": "#228811",
          "type": "string",
          "pattern": "^#[0-9a-fA-F]{6}$"
        },
        "bannerUrl": {
          "default": null,
          "anyOf": [
            {
              "type": "string",
              "maxLength": 512,
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "css": {
          "default": "",
          "type": "string",
          "maxLength": 8192
        }
      }
    },
    "settings": {
      "type": "object",
      "properties": {
        "cooldownSeconds": {
          "default": 0,
          "type": "integer",
          "minimum": 0,
          "maximum": 3600
        },
        "turnstile": {
          "default": "anonymous",
          "type": "string",
          "enum": [
            "off",
            "anonymous",
            "always"
          ]
        },
        "ngWords": {
          "default": [],
          "maxItems": 200,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        },
        "ngWordAction": {
          "default": "reject",
          "type": "string",
          "enum": [
            "reject",
            "mask"
          ]
        },
        "live": {
          "default": false,
          "type": "boolean"
        },
        "noId": {
          "default": false,
          "type": "boolean"
        },
        "allowImages": {
          "default": true,
          "type": "boolean"
        },
        "kome": {
          "default": true,
          "type": "boolean"
        },
        "maxPosts": {
          "default": 1000,
          "type": "integer",
          "minimum": 10,
          "maximum": 1000
        },
        "uploader": {
          "default": null,
          "anyOf": [
            {
              "type": "string",
              "maxLength": 32
            },
            {
              "type": "null"
            }
          ]
        },
        "forceSage": {
          "default": false,
          "type": "boolean"
        },
        "maxBoardsPerAccount": {
          "default": null,
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            {
              "type": "null"
            }
          ]
        }
      }
    },
    "ownerAccountId": {
      "type": [
        "string",
        "null"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "deleted"
      ]
    },
    "lastPostAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "slug",
    "name",
    "category",
    "description",
    "rulesMd",
    "design",
    "settings",
    "ownerAccountId",
    "status",
    "lastPostAt",
    "createdAt"
  ]
}
```

#### `boardSettingsSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "cooldownSeconds": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 3600
    },
    "turnstile": {
      "default": "anonymous",
      "type": "string",
      "enum": [
        "off",
        "anonymous",
        "always"
      ]
    },
    "ngWords": {
      "default": [],
      "maxItems": 200,
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "ngWordAction": {
      "default": "reject",
      "type": "string",
      "enum": [
        "reject",
        "mask"
      ]
    },
    "live": {
      "default": false,
      "type": "boolean"
    },
    "noId": {
      "default": false,
      "type": "boolean"
    },
    "allowImages": {
      "default": true,
      "type": "boolean"
    },
    "kome": {
      "default": true,
      "type": "boolean"
    },
    "maxPosts": {
      "default": 1000,
      "type": "integer",
      "minimum": 10,
      "maximum": 1000
    },
    "uploader": {
      "default": null,
      "anyOf": [
        {
          "type": "string",
          "maxLength": 32
        },
        {
          "type": "null"
        }
      ]
    },
    "forceSage": {
      "default": false,
      "type": "boolean"
    },
    "maxBoardsPerAccount": {
      "default": null,
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

#### `boardSlugSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 1,
  "maxLength": 32,
  "pattern": "^[a-z0-9][a-z0-9_-]*$"
}
```

#### `boardStaffLevelSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "admin",
    "deputy",
    "moderator"
  ]
}
```

#### `boardStaffSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "boardId": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "accountId": {
      "type": "string"
    },
    "accountName": {
      "type": "string"
    },
    "level": {
      "type": "string",
      "enum": [
        "admin",
        "deputy",
        "moderator"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "boardId",
    "accountId",
    "accountName",
    "level",
    "createdAt"
  ]
}
```

#### `boardStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "active",
    "deleted"
  ]
}
```

#### `boardSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "slug": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "category": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "deleted"
      ]
    },
    "lastPostAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "threadCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "postCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "slug",
    "name",
    "category",
    "description",
    "status",
    "lastPostAt",
    "createdAt",
    "threadCount",
    "postCount"
  ]
}
```

#### `createBoardBanRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "identity": {
      "type": "string",
      "minLength": 8,
      "maxLength": 128
    },
    "kind": {
      "default": "device",
      "type": "string",
      "enum": [
        "device",
        "ip",
        "account"
      ]
    },
    "reason": {
      "default": "",
      "type": "string",
      "maxLength": 500
    },
    "durationHours": {
      "default": 24,
      "anyOf": [
        {
          "type": "integer",
          "minimum": 1,
          "maximum": 8760
        },
        {
          "type": "null"
        }
      ]
    },
    "site": {
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "identity"
  ]
}
```

#### `createBoardRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "slug": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32,
      "pattern": "^[a-z0-9][a-z0-9_-]*$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "category": {
      "default": "雑談",
      "type": "string",
      "minLength": 1,
      "maxLength": 32
    },
    "description": {
      "default": "",
      "type": "string",
      "maxLength": 2000
    },
    "rulesMd": {
      "default": "",
      "type": "string",
      "maxLength": 20000
    },
    "design": {
      "type": "object",
      "properties": {
        "themeColor": {
          "default": "#ccffcc",
          "type": "string",
          "pattern": "^#[0-9a-fA-F]{6}$"
        },
        "accentColor": {
          "default": "#228811",
          "type": "string",
          "pattern": "^#[0-9a-fA-F]{6}$"
        },
        "bannerUrl": {
          "default": null,
          "anyOf": [
            {
              "type": "string",
              "maxLength": 512,
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "css": {
          "default": "",
          "type": "string",
          "maxLength": 8192
        }
      }
    },
    "settings": {
      "type": "object",
      "properties": {
        "cooldownSeconds": {
          "default": 0,
          "type": "integer",
          "minimum": 0,
          "maximum": 3600
        },
        "turnstile": {
          "default": "anonymous",
          "type": "string",
          "enum": [
            "off",
            "anonymous",
            "always"
          ]
        },
        "ngWords": {
          "default": [],
          "maxItems": 200,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        },
        "ngWordAction": {
          "default": "reject",
          "type": "string",
          "enum": [
            "reject",
            "mask"
          ]
        },
        "live": {
          "default": false,
          "type": "boolean"
        },
        "noId": {
          "default": false,
          "type": "boolean"
        },
        "allowImages": {
          "default": true,
          "type": "boolean"
        },
        "kome": {
          "default": true,
          "type": "boolean"
        },
        "maxPosts": {
          "default": 1000,
          "type": "integer",
          "minimum": 10,
          "maximum": 1000
        },
        "uploader": {
          "default": null,
          "anyOf": [
            {
              "type": "string",
              "maxLength": 32
            },
            {
              "type": "null"
            }
          ]
        },
        "forceSage": {
          "default": false,
          "type": "boolean"
        },
        "maxBoardsPerAccount": {
          "default": null,
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            {
              "type": "null"
            }
          ]
        }
      }
    },
    "turnstileToken": {
      "type": "string"
    }
  },
  "required": [
    "slug",
    "name"
  ]
}
```

#### `ngWordSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 1,
  "maxLength": 64
}
```

#### `setBoardStaffRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "accountId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "accountName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "level": {
      "type": "string",
      "enum": [
        "admin",
        "deputy",
        "moderator"
      ]
    }
  },
  "required": [
    "level"
  ]
}
```

#### `updateBoardRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "category": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "rulesMd": {
      "type": "string",
      "maxLength": 20000
    },
    "design": {
      "type": "object",
      "properties": {
        "themeColor": {
          "default": "#ccffcc",
          "type": "string",
          "pattern": "^#[0-9a-fA-F]{6}$"
        },
        "accentColor": {
          "default": "#228811",
          "type": "string",
          "pattern": "^#[0-9a-fA-F]{6}$"
        },
        "bannerUrl": {
          "default": null,
          "anyOf": [
            {
              "type": "string",
              "maxLength": 512,
              "format": "uri"
            },
            {
              "type": "null"
            }
          ]
        },
        "css": {
          "default": "",
          "type": "string",
          "maxLength": 8192
        }
      }
    },
    "settings": {
      "type": "object",
      "properties": {
        "cooldownSeconds": {
          "default": 0,
          "type": "integer",
          "minimum": 0,
          "maximum": 3600
        },
        "turnstile": {
          "default": "anonymous",
          "type": "string",
          "enum": [
            "off",
            "anonymous",
            "always"
          ]
        },
        "ngWords": {
          "default": [],
          "maxItems": 200,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          }
        },
        "ngWordAction": {
          "default": "reject",
          "type": "string",
          "enum": [
            "reject",
            "mask"
          ]
        },
        "live": {
          "default": false,
          "type": "boolean"
        },
        "noId": {
          "default": false,
          "type": "boolean"
        },
        "allowImages": {
          "default": true,
          "type": "boolean"
        },
        "kome": {
          "default": true,
          "type": "boolean"
        },
        "maxPosts": {
          "default": 1000,
          "type": "integer",
          "minimum": 10,
          "maximum": 1000
        },
        "uploader": {
          "default": null,
          "anyOf": [
            {
              "type": "string",
              "maxLength": 32
            },
            {
              "type": "null"
            }
          ]
        },
        "forceSage": {
          "default": false,
          "type": "boolean"
        },
        "maxBoardsPerAccount": {
          "default": null,
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            {
              "type": "null"
            }
          ]
        }
      }
    }
  }
}
```

### `packages/shared/src/schemas/commands.ts`

#### `threadCommandKeySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "aku",
    "kaijo",
    "sub",
    "cap",
    "reset",
    "nopic",
    "ngk",
    "jien",
    "add"
  ]
}
```

#### `threadCommandNameSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "!aku",
    "!kaijo",
    "!sub",
    "!cap",
    "!reset",
    "!nopic",
    "!ngk",
    "!jien",
    "!add"
  ]
}
```

### `packages/shared/src/schemas/common.ts`

#### `apiErrorSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": false
    },
    "code": {
      "type": "string"
    },
    "message": {
      "type": "string"
    },
    "details": {}
  },
  "required": [
    "ok",
    "code",
    "message"
  ]
}
```

#### `cursorPaginationQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "cursor": {
      "type": "string"
    },
    "limit": {
      "default": 50,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  }
}
```

### `packages/shared/src/schemas/compat.ts`

#### `datLineSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string"
    },
    "trip": {
      "type": [
        "string",
        "null"
      ]
    },
    "mail": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "idHash": {
      "type": "string"
    },
    "body": {
      "type": "string"
    },
    "title": {
      "type": [
        "string",
        "null"
      ]
    },
    "num": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string"
    },
    "threadId": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "name",
    "trip",
    "mail",
    "createdAt",
    "idHash",
    "body",
    "title",
    "num",
    "boardSlug",
    "threadId"
  ]
}
```

### `packages/shared/src/schemas/github.ts`

#### `createGistSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "maxLength": 256
    },
    "public": {
      "default": false,
      "type": "boolean"
    },
    "files": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "additionalProperties": {
        "type": "object",
        "properties": {
          "content": {
            "type": "string"
          },
          "filename": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "required": [
          "content"
        ]
      }
    }
  },
  "required": [
    "files"
  ]
}
```

#### `gistFileInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "content": {
      "type": "string"
    },
    "filename": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "content"
  ]
}
```

#### `gistSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "htmlUrl": {
      "type": "string"
    },
    "description": {
      "type": [
        "string",
        "null"
      ]
    },
    "public": {
      "type": "boolean"
    },
    "createdAt": {
      "type": [
        "string",
        "null"
      ]
    },
    "updatedAt": {
      "type": [
        "string",
        "null"
      ]
    },
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "filename": {
            "type": "string"
          },
          "size": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "rawUrl": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "filename",
          "size",
          "rawUrl"
        ]
      }
    }
  },
  "required": [
    "id",
    "htmlUrl",
    "description",
    "public",
    "createdAt",
    "updatedAt",
    "files"
  ]
}
```

#### `githubLinkStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "linked": {
      "type": "boolean"
    },
    "login": {
      "type": [
        "string",
        "null"
      ]
    },
    "userId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "avatarUrl": {
      "type": [
        "string",
        "null"
      ]
    },
    "method": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "oauth",
            "pat"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "scopes": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "linkedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "rate": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "limit": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "remaining": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "reset": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "resource": {
              "type": "string"
            }
          },
          "required": [
            "limit",
            "remaining",
            "reset",
            "resource"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "oauthAvailable": {
      "type": "boolean"
    }
  },
  "required": [
    "linked",
    "login",
    "userId",
    "avatarUrl",
    "method",
    "scopes",
    "linkedAt",
    "rate",
    "oauthAvailable"
  ]
}
```

#### `githubOauthCallbackSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    },
    "state": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    }
  },
  "required": [
    "code",
    "state"
  ]
}
```

#### `githubOauthStartResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "authorizeUrl": {
      "type": "string"
    },
    "state": {
      "type": "string"
    }
  },
  "required": [
    "authorizeUrl",
    "state"
  ]
}
```

#### `githubOwnerSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 1,
  "maxLength": 100,
  "pattern": "^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$"
}
```

#### `githubPatSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "token": {
      "type": "string",
      "minLength": 20,
      "maxLength": 255
    }
  },
  "required": [
    "token"
  ]
}
```

#### `githubPathSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 1,
  "maxLength": 400
}
```

#### `githubRateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "remaining": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "reset": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "resource": {
      "type": "string"
    }
  },
  "required": [
    "limit",
    "remaining",
    "reset",
    "resource"
  ]
}
```

#### `githubRepoSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 1,
  "maxLength": 100,
  "pattern": "^[A-Za-z0-9._-]+$"
}
```

#### `repoFileDeleteSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 400
    },
    "sha": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "message": {
      "default": "Delete from おーぷんクローン",
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "branch": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "path",
    "sha"
  ]
}
```

#### `repoFileReadQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 400
    },
    "ref": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "path"
  ]
}
```

#### `repoFileSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": {
      "type": "string"
    },
    "sha": {
      "type": "string"
    },
    "size": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "content": {
      "type": [
        "string",
        "null"
      ]
    },
    "encoding": {
      "type": [
        "string",
        "null"
      ]
    },
    "htmlUrl": {
      "type": [
        "string",
        "null"
      ]
    },
    "downloadUrl": {
      "type": [
        "string",
        "null"
      ]
    },
    "rawUrl": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "path",
    "sha",
    "size",
    "content",
    "encoding",
    "htmlUrl",
    "downloadUrl",
    "rawUrl"
  ]
}
```

#### `repoFileWriteSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "minLength": 1,
      "maxLength": 400
    },
    "content": {
      "type": "string"
    },
    "message": {
      "default": "Update from おーぷんクローン",
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "sha": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "branch": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "path",
    "content"
  ]
}
```

#### `repoListQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "page": {
      "default": 1,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "perPage": {
      "default": 30,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "sort": {
      "default": "updated",
      "type": "string",
      "enum": [
        "updated",
        "pushed",
        "full_name",
        "created"
      ]
    }
  }
}
```

#### `repoSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "name": {
      "type": "string"
    },
    "fullName": {
      "type": "string"
    },
    "private": {
      "type": "boolean"
    },
    "htmlUrl": {
      "type": "string"
    },
    "defaultBranch": {
      "type": "string"
    },
    "permissions": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "push": {
              "type": "boolean"
            }
          },
          "required": [
            "push"
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "name",
    "fullName",
    "private",
    "htmlUrl",
    "defaultBranch",
    "permissions"
  ]
}
```

#### `updateGistSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "maxLength": 256
    },
    "files": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "additionalProperties": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "content": {
                "type": "string"
              },
              "filename": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              }
            },
            "required": [
              "content"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    }
  }
}
```

### `packages/shared/src/schemas/mcp.ts`

#### `mcpPolicyResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "action": {
      "type": "string"
    },
    "risk": {
      "type": "string"
    },
    "mode": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "executed",
        "queued",
        "denied"
      ]
    },
    "result": {},
    "queueId": {
      "type": "string"
    },
    "reason": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "risk",
    "mode",
    "status"
  ]
}
```

### `packages/shared/src/schemas/plugin-authoring.ts`

#### `authoringAddVersionOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "checks": {
      "type": "object",
      "properties": {
        "allowed": {
          "type": "boolean"
        },
        "reasons": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "riskScore": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        }
      },
      "required": [
        "allowed",
        "reasons",
        "riskScore"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 500
      }
    }
  },
  "required": [
    "ok",
    "pluginId",
    "version",
    "checks",
    "warnings"
  ],
  "additionalProperties": false
}
```

#### `authoringAddVersionSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "default": [],
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "connectAllowlist": {
          "default": [],
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "entry": {
          "default": "plugin.js",
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "slots": {
          "default": [],
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "default": [],
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "render": {
          "type": "object",
          "properties": {
            "post": {
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "pattern": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  },
                  "flags": {
                    "default": "g",
                    "type": "string",
                    "maxLength": 6,
                    "pattern": "^[gimsu]*$"
                  },
                  "template": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  "kind": {
                    "default": "text",
                    "type": "string",
                    "enum": [
                      "spoiler",
                      "dice",
                      "link",
                      "image",
                      "text"
                    ]
                  }
                },
                "required": [
                  "pattern",
                  "template"
                ]
              }
            }
          }
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "name",
        "version",
        "summary",
        "scope"
      ]
    },
    "code": {
      "type": "string",
      "minLength": 1
    },
    "changelog": {
      "type": "string",
      "maxLength": 2000
    },
    "templateId": {
      "type": "string",
      "enum": [
        "spoiler",
        "ng-word-mask",
        "keyword-deco",
        "dice-button",
        "counter",
        "thread-info",
        "quick-reply"
      ]
    }
  },
  "required": [
    "pluginId",
    "code"
  ],
  "additionalProperties": false
}
```

#### `authoringBaseManifestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "summary": {
      "type": "string",
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "maxLength": 20000
    },
    "scope": {
      "minItems": 1,
      "maxItems": 3,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "personal",
          "board",
          "site"
        ]
      }
    },
    "permissions": {
      "maxItems": 12,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "ui:slot",
          "data:read:thread",
          "data:read:board",
          "data:write:post",
          "storage:shared",
          "net:fetch",
          "upload:start",
          "github:gist",
          "github:repo",
          "events:subscribe",
          "notify",
          "ai:complete"
        ]
      }
    },
    "slots": {
      "maxItems": 8,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "thread-head",
          "thread-post-inline",
          "thread-post-footer",
          "post-form-after",
          "board-head",
          "sidebar",
          "plugin-page",
          "site-header",
          "site-top",
          "board-top",
          "board-sidebar",
          "thread-top",
          "thread-nav",
          "post-form-extra",
          "thread-bottom",
          "board-manage",
          "post-actions"
        ]
      }
    },
    "hooks": {
      "maxItems": 4,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "beforePost",
          "onPostRendered"
        ]
      }
    },
    "entry": {
      "type": "string",
      "pattern": "^[A-Za-z0-9._/-]{1,100}$"
    },
    "author": {
      "type": "string",
      "maxLength": 60
    },
    "license": {
      "type": "string",
      "maxLength": 30
    },
    "homepage": {
      "type": "string",
      "maxLength": 300
    }
  },
  "additionalProperties": false
}
```

#### `authoringCheckOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "checks": {
      "type": "object",
      "properties": {
        "allowed": {
          "type": "boolean"
        },
        "reasons": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "riskScore": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        }
      },
      "required": [
        "allowed",
        "reasons",
        "riskScore"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 500
      }
    }
  },
  "required": [
    "ok",
    "checks",
    "warnings"
  ],
  "additionalProperties": false
}
```

#### `authoringCheckSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "minLength": 1
    },
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "default": [],
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "connectAllowlist": {
          "default": [],
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "entry": {
          "default": "plugin.js",
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "slots": {
          "default": [],
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "default": [],
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "render": {
          "type": "object",
          "properties": {
            "post": {
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "pattern": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  },
                  "flags": {
                    "default": "g",
                    "type": "string",
                    "maxLength": 6,
                    "pattern": "^[gimsu]*$"
                  },
                  "template": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  "kind": {
                    "default": "text",
                    "type": "string",
                    "enum": [
                      "spoiler",
                      "dice",
                      "link",
                      "image",
                      "text"
                    ]
                  }
                },
                "required": [
                  "pattern",
                  "template"
                ]
              }
            }
          }
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "name",
        "version",
        "summary",
        "scope"
      ]
    }
  },
  "required": [
    "code"
  ],
  "additionalProperties": false
}
```

#### `authoringCodeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 1
}
```

#### `authoringCreateDraftOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{2,40}$"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "checks": {
      "type": "object",
      "properties": {
        "allowed": {
          "type": "boolean"
        },
        "reasons": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "riskScore": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        }
      },
      "required": [
        "allowed",
        "reasons",
        "riskScore"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 500
      }
    }
  },
  "required": [
    "ok",
    "pluginId",
    "name",
    "version",
    "checks",
    "warnings"
  ],
  "additionalProperties": false
}
```

#### `authoringCreateDraftSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "default": [],
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "connectAllowlist": {
          "default": [],
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "entry": {
          "default": "plugin.js",
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "slots": {
          "default": [],
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "default": [],
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "render": {
          "type": "object",
          "properties": {
            "post": {
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "pattern": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  },
                  "flags": {
                    "default": "g",
                    "type": "string",
                    "maxLength": 6,
                    "pattern": "^[gimsu]*$"
                  },
                  "template": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  "kind": {
                    "default": "text",
                    "type": "string",
                    "enum": [
                      "spoiler",
                      "dice",
                      "link",
                      "image",
                      "text"
                    ]
                  }
                },
                "required": [
                  "pattern",
                  "template"
                ]
              }
            }
          }
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "name",
        "version",
        "summary",
        "scope"
      ]
    },
    "code": {
      "type": "string",
      "minLength": 1
    },
    "changelog": {
      "type": "string",
      "maxLength": 2000
    },
    "visibility": {
      "default": "private",
      "type": "string",
      "enum": [
        "private",
        "unlisted"
      ]
    },
    "templateId": {
      "type": "string",
      "enum": [
        "spoiler",
        "ng-word-mask",
        "keyword-deco",
        "dice-button",
        "counter",
        "thread-info",
        "quick-reply"
      ]
    }
  },
  "required": [
    "manifest",
    "code"
  ],
  "additionalProperties": false
}
```

#### `authoringErrorSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": false
    },
    "code": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "message": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "details": {}
  },
  "required": [
    "ok",
    "code",
    "message"
  ],
  "additionalProperties": false
}
```

#### `authoringGetOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "plugin": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "status": {
          "type": "string",
          "enum": [
            "draft",
            "pending",
            "published",
            "rejected",
            "disabled"
          ]
        },
        "visibility": {
          "type": "string",
          "enum": [
            "private",
            "unlisted",
            "public"
          ]
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "updatedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "manifest": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9-]{2,40}$"
            },
            "version": {
              "type": "string",
              "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
            },
            "summary": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "description": {
              "type": "string",
              "maxLength": 20000
            },
            "scope": {
              "minItems": 1,
              "maxItems": 3,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "personal",
                  "board",
                  "site"
                ]
              }
            },
            "permissions": {
              "default": [],
              "maxItems": 12,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "ui:slot",
                  "data:read:thread",
                  "data:read:board",
                  "data:write:post",
                  "storage:shared",
                  "net:fetch",
                  "upload:start",
                  "github:gist",
                  "github:repo",
                  "events:subscribe",
                  "notify",
                  "ai:complete"
                ]
              }
            },
            "connectAllowlist": {
              "default": [],
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "string",
                "maxLength": 300
              }
            },
            "entry": {
              "default": "plugin.js",
              "type": "string",
              "pattern": "^[A-Za-z0-9._/-]{1,100}$"
            },
            "slots": {
              "default": [],
              "maxItems": 8,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "thread-head",
                  "thread-post-inline",
                  "thread-post-footer",
                  "post-form-after",
                  "board-head",
                  "sidebar",
                  "plugin-page",
                  "site-header",
                  "site-top",
                  "board-top",
                  "board-sidebar",
                  "thread-top",
                  "thread-nav",
                  "post-form-extra",
                  "thread-bottom",
                  "board-manage",
                  "post-actions"
                ]
              }
            },
            "hooks": {
              "default": [],
              "maxItems": 4,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "beforePost",
                  "onPostRendered"
                ]
              }
            },
            "render": {
              "type": "object",
              "properties": {
                "post": {
                  "maxItems": 20,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "pattern": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 500
                      },
                      "flags": {
                        "default": "g",
                        "type": "string",
                        "maxLength": 6,
                        "pattern": "^[gimsu]*$"
                      },
                      "template": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000
                      },
                      "kind": {
                        "default": "text",
                        "type": "string",
                        "enum": [
                          "spoiler",
                          "dice",
                          "link",
                          "image",
                          "text"
                        ]
                      }
                    },
                    "required": [
                      "pattern",
                      "template"
                    ]
                  }
                }
              }
            },
            "author": {
              "type": "string",
              "maxLength": 60
            },
            "license": {
              "type": "string",
              "maxLength": 30
            },
            "homepage": {
              "type": "string",
              "maxLength": 300
            }
          },
          "required": [
            "name",
            "version",
            "summary",
            "scope"
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "status",
        "visibility",
        "manifest"
      ],
      "additionalProperties": false
    },
    "versions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "version": {
            "type": "string",
            "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "pending",
              "published",
              "rejected",
              "disabled"
            ]
          },
          "changelog": {
            "type": "string",
            "maxLength": 2000
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "version",
          "status"
        ],
        "additionalProperties": false
      }
    },
    "reviews": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "scope": {
            "type": "string",
            "enum": [
              "board",
              "site"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "approved",
              "rejected"
            ]
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "id",
          "scope",
          "status"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "ok",
    "plugin",
    "versions",
    "reviews"
  ],
  "additionalProperties": false
}
```

#### `authoringGetSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    }
  },
  "required": [
    "pluginId"
  ],
  "additionalProperties": false
}
```

#### `authoringInstallSelfOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "scope": {
      "type": "string",
      "const": "personal"
    },
    "installed": {
      "type": "boolean"
    },
    "uninstalled": {
      "type": "boolean"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "pinned": {
      "type": "boolean"
    }
  },
  "required": [
    "ok",
    "pluginId",
    "scope",
    "installed",
    "uninstalled",
    "pinned"
  ],
  "additionalProperties": false
}
```

#### `authoringInstallSelfSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "pinned": {
      "default": false,
      "type": "boolean"
    },
    "uninstall": {
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "pluginId"
  ],
  "additionalProperties": false
}
```

#### `authoringListOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "plugins": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "name": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{2,40}$"
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "pending",
              "published",
              "rejected",
              "disabled"
            ]
          },
          "visibility": {
            "type": "string",
            "enum": [
              "private",
              "unlisted",
              "public"
            ]
          },
          "version": {
            "type": "string",
            "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
          },
          "updatedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "id",
          "name",
          "status",
          "visibility"
        ],
        "additionalProperties": false
      }
    },
    "nextCursor": {
      "type": "string",
      "maxLength": 300
    }
  },
  "required": [
    "ok",
    "plugins"
  ],
  "additionalProperties": false
}
```

#### `authoringListSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "limit": {
      "default": 30,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "cursor": {
      "type": "string",
      "maxLength": 300
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "pending",
        "published",
        "rejected",
        "disabled"
      ]
    },
    "q": {
      "type": "string",
      "maxLength": 100
    }
  },
  "additionalProperties": false
}
```

#### `authoringListTemplatesInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### `authoringListTemplatesOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "templates": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "parameters": {
            "minItems": 1,
            "maxItems": 20,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "key": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 64
                },
                "label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 100
                },
                "type": {
                  "type": "string",
                  "enum": [
                    "string",
                    "text",
                    "number",
                    "boolean",
                    "select",
                    "stringList"
                  ]
                },
                "required": {
                  "type": "boolean"
                },
                "default": {},
                "constraints": {
                  "type": "object",
                  "properties": {
                    "minLength": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "maxLength": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "min": {
                      "type": "number"
                    },
                    "max": {
                      "type": "number"
                    },
                    "step": {
                      "type": "number"
                    },
                    "integer": {
                      "type": "boolean"
                    },
                    "options": {
                      "maxItems": 50,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "value": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 100
                          },
                          "label": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 100
                          }
                        },
                        "required": [
                          "value",
                          "label"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "maxItems": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "itemMaxLength": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "placeholder": {
                      "type": "string",
                      "maxLength": 200
                    },
                    "slugPattern": {
                      "type": "string",
                      "maxLength": 200
                    },
                    "pattern": {
                      "type": "string",
                      "maxLength": 200
                    }
                  },
                  "additionalProperties": false
                }
              },
              "required": [
                "key",
                "label",
                "type",
                "required"
              ],
              "additionalProperties": false
            }
          },
          "baseManifest": {
            "type": "object",
            "properties": {
              "version": {
                "type": "string",
                "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
              },
              "summary": {
                "type": "string",
                "maxLength": 200
              },
              "description": {
                "type": "string",
                "maxLength": 20000
              },
              "scope": {
                "minItems": 1,
                "maxItems": 3,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "personal",
                    "board",
                    "site"
                  ]
                }
              },
              "permissions": {
                "maxItems": 12,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "ui:slot",
                    "data:read:thread",
                    "data:read:board",
                    "data:write:post",
                    "storage:shared",
                    "net:fetch",
                    "upload:start",
                    "github:gist",
                    "github:repo",
                    "events:subscribe",
                    "notify",
                    "ai:complete"
                  ]
                }
              },
              "slots": {
                "maxItems": 8,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "thread-head",
                    "thread-post-inline",
                    "thread-post-footer",
                    "post-form-after",
                    "board-head",
                    "sidebar",
                    "plugin-page",
                    "site-header",
                    "site-top",
                    "board-top",
                    "board-sidebar",
                    "thread-top",
                    "thread-nav",
                    "post-form-extra",
                    "thread-bottom",
                    "board-manage",
                    "post-actions"
                  ]
                }
              },
              "hooks": {
                "maxItems": 4,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "beforePost",
                    "onPostRendered"
                  ]
                }
              },
              "entry": {
                "type": "string",
                "pattern": "^[A-Za-z0-9._/-]{1,100}$"
              },
              "author": {
                "type": "string",
                "maxLength": 60
              },
              "license": {
                "type": "string",
                "maxLength": 30
              },
              "homepage": {
                "type": "string",
                "maxLength": 300
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "id",
          "label",
          "description",
          "parameters",
          "baseManifest"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "ok",
    "templates"
  ],
  "additionalProperties": false
}
```

#### `authoringPluginSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{2,40}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "pending",
        "published",
        "rejected",
        "disabled"
      ]
    },
    "visibility": {
      "type": "string",
      "enum": [
        "private",
        "unlisted",
        "public"
      ]
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "name",
    "status",
    "visibility"
  ],
  "additionalProperties": false
}
```

#### `authoringPreviewOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "default": [],
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "connectAllowlist": {
          "default": [],
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "entry": {
          "default": "plugin.js",
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "slots": {
          "default": [],
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "default": [],
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "render": {
          "type": "object",
          "properties": {
            "post": {
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "pattern": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  },
                  "flags": {
                    "default": "g",
                    "type": "string",
                    "maxLength": 6,
                    "pattern": "^[gimsu]*$"
                  },
                  "template": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  "kind": {
                    "default": "text",
                    "type": "string",
                    "enum": [
                      "spoiler",
                      "dice",
                      "link",
                      "image",
                      "text"
                    ]
                  }
                },
                "required": [
                  "pattern",
                  "template"
                ]
              }
            }
          }
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "name",
        "version",
        "summary",
        "scope"
      ]
    },
    "checks": {
      "type": "object",
      "properties": {
        "allowed": {
          "type": "boolean"
        },
        "reasons": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "riskScore": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        }
      },
      "required": [
        "allowed",
        "reasons",
        "riskScore"
      ],
      "additionalProperties": false
    },
    "warnings": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 500
      }
    },
    "regex": {
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "maxLength": 500
          },
          "flags": {
            "type": "string",
            "maxLength": 6
          },
          "safe": {
            "type": "boolean"
          },
          "reason": {
            "type": "string",
            "maxLength": 500
          }
        },
        "required": [
          "pattern",
          "flags",
          "safe"
        ],
        "additionalProperties": false
      }
    },
    "versions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "version": {
            "type": "string",
            "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
          },
          "status": {
            "type": "string",
            "enum": [
              "draft",
              "pending",
              "published",
              "rejected",
              "disabled"
            ]
          },
          "changelog": {
            "type": "string",
            "maxLength": 2000
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "version",
          "status"
        ],
        "additionalProperties": false
      }
    },
    "reviews": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "scope": {
            "type": "string",
            "enum": [
              "board",
              "site"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "approved",
              "rejected"
            ]
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "id",
          "scope",
          "status"
        ],
        "additionalProperties": false
      }
    },
    "previewUrl": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  },
  "required": [
    "ok",
    "pluginId",
    "manifest",
    "checks",
    "warnings",
    "regex",
    "versions",
    "reviews",
    "previewUrl"
  ],
  "additionalProperties": false
}
```

#### `authoringPreviewSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    }
  },
  "required": [
    "pluginId"
  ],
  "additionalProperties": false
}
```

#### `authoringPublishOutputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "pending",
        "published",
        "rejected",
        "disabled"
      ]
    },
    "needsReview": {
      "type": "boolean"
    },
    "reviewId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "message": {
      "type": "string",
      "maxLength": 500
    },
    "checks": {
      "type": "object",
      "properties": {
        "allowed": {
          "type": "boolean"
        },
        "reasons": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "riskScore": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        }
      },
      "required": [
        "allowed",
        "reasons",
        "riskScore"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "ok",
    "pluginId",
    "status",
    "needsReview",
    "checks"
  ],
  "additionalProperties": false
}
```

#### `authoringPublishSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "scopes": {
      "minItems": 1,
      "maxItems": 3,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "personal",
          "board",
          "site"
        ]
      }
    },
    "visibility": {
      "default": "public",
      "type": "string",
      "enum": [
        "private",
        "unlisted",
        "public"
      ]
    }
  },
  "required": [
    "pluginId",
    "scopes"
  ],
  "additionalProperties": false
}
```

#### `authoringRenderSafetySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "maxLength": 500
    },
    "flags": {
      "type": "string",
      "maxLength": 6
    },
    "safe": {
      "type": "boolean"
    },
    "reason": {
      "type": "string",
      "maxLength": 500
    }
  },
  "required": [
    "pattern",
    "flags",
    "safe"
  ],
  "additionalProperties": false
}
```

#### `authoringReviewSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "scope": {
      "type": "string",
      "enum": [
        "board",
        "site"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "approved",
        "rejected"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "scope",
    "status"
  ],
  "additionalProperties": false
}
```

#### `authoringStaticCheckResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "allowed": {
      "type": "boolean"
    },
    "reasons": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 300
      }
    },
    "riskScore": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    }
  },
  "required": [
    "allowed",
    "reasons",
    "riskScore"
  ],
  "additionalProperties": false
}
```

#### `authoringTemplateIdSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "spoiler",
    "ng-word-mask",
    "keyword-deco",
    "dice-button",
    "counter",
    "thread-info",
    "quick-reply"
  ]
}
```

#### `authoringTemplateInfoSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "label": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "parameters": {
      "minItems": 1,
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "type": {
            "type": "string",
            "enum": [
              "string",
              "text",
              "number",
              "boolean",
              "select",
              "stringList"
            ]
          },
          "required": {
            "type": "boolean"
          },
          "default": {},
          "constraints": {
            "type": "object",
            "properties": {
              "minLength": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "maxLength": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "min": {
                "type": "number"
              },
              "max": {
                "type": "number"
              },
              "step": {
                "type": "number"
              },
              "integer": {
                "type": "boolean"
              },
              "options": {
                "maxItems": 50,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "value": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 100
                    },
                    "label": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 100
                    }
                  },
                  "required": [
                    "value",
                    "label"
                  ],
                  "additionalProperties": false
                }
              },
              "maxItems": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "itemMaxLength": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "placeholder": {
                "type": "string",
                "maxLength": 200
              },
              "slugPattern": {
                "type": "string",
                "maxLength": 200
              },
              "pattern": {
                "type": "string",
                "maxLength": 200
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "key",
          "label",
          "type",
          "required"
        ],
        "additionalProperties": false
      }
    },
    "baseManifest": {
      "type": "object",
      "properties": {
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "slots": {
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "entry": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "id",
    "label",
    "description",
    "parameters",
    "baseManifest"
  ],
  "additionalProperties": false
}
```

#### `authoringTemplateParameterConstraintsSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "minLength": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "maxLength": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "min": {
      "type": "number"
    },
    "max": {
      "type": "number"
    },
    "step": {
      "type": "number"
    },
    "integer": {
      "type": "boolean"
    },
    "options": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "value": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "label": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          }
        },
        "required": [
          "value",
          "label"
        ],
        "additionalProperties": false
      }
    },
    "maxItems": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "itemMaxLength": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "placeholder": {
      "type": "string",
      "maxLength": 200
    },
    "slugPattern": {
      "type": "string",
      "maxLength": 200
    },
    "pattern": {
      "type": "string",
      "maxLength": 200
    }
  },
  "additionalProperties": false
}
```

#### `authoringTemplateParameterSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "key": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "label": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "type": {
      "type": "string",
      "enum": [
        "string",
        "text",
        "number",
        "boolean",
        "select",
        "stringList"
      ]
    },
    "required": {
      "type": "boolean"
    },
    "default": {},
    "constraints": {
      "type": "object",
      "properties": {
        "minLength": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxLength": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "min": {
          "type": "number"
        },
        "max": {
          "type": "number"
        },
        "step": {
          "type": "number"
        },
        "integer": {
          "type": "boolean"
        },
        "options": {
          "maxItems": 50,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "value": {
                "type": "string",
                "minLength": 1,
                "maxLength": 100
              },
              "label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 100
              }
            },
            "required": [
              "value",
              "label"
            ],
            "additionalProperties": false
          }
        },
        "maxItems": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "itemMaxLength": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "placeholder": {
          "type": "string",
          "maxLength": 200
        },
        "slugPattern": {
          "type": "string",
          "maxLength": 200
        },
        "pattern": {
          "type": "string",
          "maxLength": 200
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "key",
    "label",
    "type",
    "required"
  ],
  "additionalProperties": false
}
```

#### `authoringTemplateParameterTypeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "string",
    "text",
    "number",
    "boolean",
    "select",
    "stringList"
  ]
}
```

#### `authoringVersionSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "pending",
        "published",
        "rejected",
        "disabled"
      ]
    },
    "changelog": {
      "type": "string",
      "maxLength": 2000
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "version",
    "status"
  ],
  "additionalProperties": false
}
```

#### `pluginAuthorTokenCreateResponseSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "token": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "prefix": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "revoked"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "token",
    "prefix",
    "name",
    "status",
    "createdAt",
    "expiresAt"
  ],
  "additionalProperties": false
}
```

#### `pluginAuthorTokenCreateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    }
  },
  "additionalProperties": false
}
```

#### `pluginAuthorTokenListResponseSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "items": {
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          "prefix": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "revoked"
            ]
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "expiresAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "lastUsedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "expired": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "prefix",
          "name",
          "status",
          "createdAt",
          "expiresAt"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "items"
  ],
  "additionalProperties": false
}
```

#### `pluginAuthorTokenRevokeAllResponseSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "revoked": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000
    }
  },
  "required": [
    "ok",
    "revoked"
  ],
  "additionalProperties": false
}
```

#### `pluginAuthorTokenRevokeResponseSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean",
      "const": true
    },
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    }
  },
  "required": [
    "ok",
    "id"
  ],
  "additionalProperties": false
}
```

#### `pluginAuthorTokenStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "active",
    "revoked"
  ]
}
```

#### `pluginAuthorTokenSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "prefix": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "revoked"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastUsedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expired": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "prefix",
    "name",
    "status",
    "createdAt",
    "expiresAt"
  ],
  "additionalProperties": false
}
```

### `packages/shared/src/schemas/plugin.ts`

#### `pluginActiveQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "threadId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  }
}
```

#### `pluginAiCompleteSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2147483647
    },
    "threadId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "system": {
      "type": "string",
      "maxLength": 2000
    },
    "maxTokens": {
      "type": "integer",
      "minimum": 1,
      "maximum": 512
    },
    "consent": {
      "type": "boolean",
      "const": true
    }
  },
  "required": [
    "pluginId",
    "scope",
    "prompt",
    "consent"
  ],
  "additionalProperties": false
}
```

#### `pluginCreateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "default": [],
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "connectAllowlist": {
          "default": [],
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "entry": {
          "default": "plugin.js",
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "slots": {
          "default": [],
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "default": [],
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "render": {
          "type": "object",
          "properties": {
            "post": {
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "pattern": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  },
                  "flags": {
                    "default": "g",
                    "type": "string",
                    "maxLength": 6,
                    "pattern": "^[gimsu]*$"
                  },
                  "template": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  "kind": {
                    "default": "text",
                    "type": "string",
                    "enum": [
                      "spoiler",
                      "dice",
                      "link",
                      "image",
                      "text"
                    ]
                  }
                },
                "required": [
                  "pattern",
                  "template"
                ]
              }
            }
          }
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "name",
        "version",
        "summary",
        "scope"
      ]
    },
    "code": {
      "type": "string",
      "minLength": 1
    },
    "changelog": {
      "type": "string",
      "maxLength": 2000
    },
    "visibility": {
      "default": "private",
      "type": "string",
      "enum": [
        "private",
        "unlisted",
        "public"
      ]
    },
    "templateId": {
      "type": "string",
      "enum": [
        "spoiler",
        "ng-word-mask",
        "keyword-deco",
        "dice-button",
        "counter",
        "thread-info",
        "quick-reply"
      ]
    }
  },
  "required": [
    "manifest",
    "code"
  ]
}
```

#### `pluginDisableSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2147483647
    }
  },
  "required": [
    "reason"
  ]
}
```

#### `pluginExportRepoSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "owner": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "repo": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "path": {
      "default": "",
      "type": "string",
      "maxLength": 200
    },
    "message": {
      "type": "string",
      "maxLength": 200
    }
  },
  "required": [
    "owner",
    "repo"
  ]
}
```

#### `pluginForkSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{2,40}$"
    }
  }
}
```

#### `pluginGistExportSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "public": {
      "default": true,
      "type": "boolean"
    },
    "description": {
      "type": "string",
      "maxLength": 300
    }
  }
}
```

#### `pluginGistImportSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "gist": {
      "type": "string",
      "minLength": 5,
      "maxLength": 300
    }
  },
  "required": [
    "gist"
  ]
}
```

#### `pluginHostMessageSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "v": {
      "type": "number",
      "const": 1
    },
    "id": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 64
            },
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "method": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "params": {}
  },
  "required": [
    "v",
    "method"
  ]
}
```

#### `pluginInstallSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2147483647
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "pinned": {
      "default": false,
      "type": "boolean"
    },
    "config": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "scope"
  ]
}
```

#### `pluginListQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "q": {
      "type": "string",
      "maxLength": 100
    },
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "sort": {
      "default": "updated",
      "type": "string",
      "enum": [
        "updated",
        "popular",
        "new"
      ]
    },
    "limit": {
      "default": 30,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "cursor": {
      "type": "string",
      "maxLength": 300
    },
    "mine": {
      "type": "boolean"
    }
  }
}
```

#### `pluginManifestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{2,40}$"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "description": {
      "type": "string",
      "maxLength": 20000
    },
    "scope": {
      "minItems": 1,
      "maxItems": 3,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "personal",
          "board",
          "site"
        ]
      }
    },
    "permissions": {
      "default": [],
      "maxItems": 12,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "ui:slot",
          "data:read:thread",
          "data:read:board",
          "data:write:post",
          "storage:shared",
          "net:fetch",
          "upload:start",
          "github:gist",
          "github:repo",
          "events:subscribe",
          "notify",
          "ai:complete"
        ]
      }
    },
    "connectAllowlist": {
      "default": [],
      "maxItems": 20,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 300
      }
    },
    "entry": {
      "default": "plugin.js",
      "type": "string",
      "pattern": "^[A-Za-z0-9._/-]{1,100}$"
    },
    "slots": {
      "default": [],
      "maxItems": 8,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "thread-head",
          "thread-post-inline",
          "thread-post-footer",
          "post-form-after",
          "board-head",
          "sidebar",
          "plugin-page",
          "site-header",
          "site-top",
          "board-top",
          "board-sidebar",
          "thread-top",
          "thread-nav",
          "post-form-extra",
          "thread-bottom",
          "board-manage",
          "post-actions"
        ]
      }
    },
    "hooks": {
      "default": [],
      "maxItems": 4,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "beforePost",
          "onPostRendered"
        ]
      }
    },
    "render": {
      "type": "object",
      "properties": {
        "post": {
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "pattern": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500
              },
              "flags": {
                "default": "g",
                "type": "string",
                "maxLength": 6,
                "pattern": "^[gimsu]*$"
              },
              "template": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "kind": {
                "default": "text",
                "type": "string",
                "enum": [
                  "spoiler",
                  "dice",
                  "link",
                  "image",
                  "text"
                ]
              }
            },
            "required": [
              "pattern",
              "template"
            ]
          }
        }
      }
    },
    "author": {
      "type": "string",
      "maxLength": 60
    },
    "license": {
      "type": "string",
      "maxLength": 30
    },
    "homepage": {
      "type": "string",
      "maxLength": 300
    }
  },
  "required": [
    "name",
    "version",
    "summary",
    "scope"
  ]
}
```

#### `pluginNetFetchSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pluginId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2147483647
    },
    "url": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "method": {
      "default": "GET",
      "type": "string",
      "enum": [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD"
      ]
    },
    "headers": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "string"
      }
    },
    "body": {
      "type": "string",
      "maxLength": 65536
    },
    "timeoutMs": {
      "default": 5000,
      "type": "integer",
      "minimum": 500,
      "maximum": 10000
    }
  },
  "required": [
    "pluginId",
    "scope",
    "url"
  ]
}
```

#### `pluginPostRenderRuleSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "minLength": 1,
      "maxLength": 500
    },
    "flags": {
      "default": "g",
      "type": "string",
      "maxLength": 6,
      "pattern": "^[gimsu]*$"
    },
    "template": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "kind": {
      "default": "text",
      "type": "string",
      "enum": [
        "spoiler",
        "dice",
        "link",
        "image",
        "text"
      ]
    }
  },
  "required": [
    "pattern",
    "template"
  ]
}
```

#### `pluginPreviewCheckSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "minLength": 1,
      "maxLength": 524288
    },
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "default": [],
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "connectAllowlist": {
          "default": [],
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "entry": {
          "default": "plugin.js",
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "slots": {
          "default": [],
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "default": [],
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "render": {
          "type": "object",
          "properties": {
            "post": {
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "pattern": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  },
                  "flags": {
                    "default": "g",
                    "type": "string",
                    "maxLength": 6,
                    "pattern": "^[gimsu]*$"
                  },
                  "template": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  "kind": {
                    "default": "text",
                    "type": "string",
                    "enum": [
                      "spoiler",
                      "dice",
                      "link",
                      "image",
                      "text"
                    ]
                  }
                },
                "required": [
                  "pattern",
                  "template"
                ]
              }
            }
          }
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "name",
        "version",
        "summary",
        "scope"
      ]
    }
  },
  "required": [
    "code"
  ]
}
```

#### `pluginPublishSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scopes": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "personal",
          "board",
          "site"
        ]
      }
    },
    "visibility": {
      "default": "public",
      "type": "string",
      "enum": [
        "private",
        "unlisted",
        "public"
      ]
    }
  },
  "required": [
    "scopes"
  ]
}
```

#### `pluginRepoImportSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "repo": {
      "type": "string",
      "minLength": 3,
      "maxLength": 300
    }
  },
  "required": [
    "repo"
  ]
}
```

#### `pluginReportSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "reason": {
      "type": "string",
      "enum": [
        "malicious",
        "spam",
        "broken",
        "inappropriate",
        "other"
      ]
    },
    "detail": {
      "type": "string",
      "maxLength": 2000
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    }
  },
  "required": [
    "reason"
  ]
}
```

#### `pluginReviewDecisionSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "decision": {
      "type": "string",
      "enum": [
        "approve",
        "reject"
      ]
    },
    "note": {
      "type": "string",
      "maxLength": 2000
    },
    "scope": {
      "default": "site",
      "type": "string",
      "enum": [
        "board",
        "site"
      ]
    }
  },
  "required": [
    "decision"
  ]
}
```

#### `pluginRpcErrorSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "v": {
      "type": "number",
      "const": 1
    },
    "id": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 64
            },
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "ok": {
      "type": "boolean",
      "const": false
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "maxLength": 64
        },
        "message": {
          "type": "string",
          "maxLength": 1000
        }
      },
      "required": [
        "code",
        "message"
      ]
    }
  },
  "required": [
    "v",
    "id",
    "ok",
    "error"
  ]
}
```

#### `pluginRpcRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "v": {
      "type": "number",
      "const": 1
    },
    "id": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 64
            },
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "method": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "params": {}
  },
  "required": [
    "v",
    "id",
    "method"
  ]
}
```

#### `pluginRpcResponseSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "v": {
          "type": "number",
          "const": 1
        },
        "id": {
          "anyOf": [
            {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 64
                },
                {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                }
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "ok": {
          "type": "boolean",
          "const": true
        },
        "result": {}
      },
      "required": [
        "v",
        "id",
        "ok"
      ]
    },
    {
      "type": "object",
      "properties": {
        "v": {
          "type": "number",
          "const": 1
        },
        "id": {
          "anyOf": [
            {
              "anyOf": [
                {
                  "type": "string",
                  "maxLength": 64
                },
                {
                  "type": "integer",
                  "minimum": -9007199254740991,
                  "maximum": 9007199254740991
                }
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "ok": {
          "type": "boolean",
          "const": false
        },
        "error": {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "maxLength": 64
            },
            "message": {
              "type": "string",
              "maxLength": 1000
            }
          },
          "required": [
            "code",
            "message"
          ]
        }
      },
      "required": [
        "v",
        "id",
        "ok",
        "error"
      ]
    }
  ]
}
```

#### `pluginRpcSuccessSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "v": {
      "type": "number",
      "const": 1
    },
    "id": {
      "anyOf": [
        {
          "anyOf": [
            {
              "type": "string",
              "maxLength": 64
            },
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "ok": {
      "type": "boolean",
      "const": true
    },
    "result": {}
  },
  "required": [
    "v",
    "id",
    "ok"
  ]
}
```

#### `pluginStateQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "key": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "scope"
  ]
}
```

#### `pluginStateSetSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "key": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "value": {
      "type": "string",
      "maxLength": 65536
    }
  },
  "required": [
    "scope",
    "key",
    "value"
  ]
}
```

#### `pluginUninstallSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2147483647
    }
  },
  "required": [
    "scope"
  ]
}
```

#### `pluginUpdateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": [
        "personal",
        "board",
        "site"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2147483647
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    }
  },
  "required": [
    "scope"
  ]
}
```

#### `pluginVersionCreateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
    },
    "manifest": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{2,40}$"
        },
        "version": {
          "type": "string",
          "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
        },
        "summary": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "description": {
          "type": "string",
          "maxLength": 20000
        },
        "scope": {
          "minItems": 1,
          "maxItems": 3,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "personal",
              "board",
              "site"
            ]
          }
        },
        "permissions": {
          "default": [],
          "maxItems": 12,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "ui:slot",
              "data:read:thread",
              "data:read:board",
              "data:write:post",
              "storage:shared",
              "net:fetch",
              "upload:start",
              "github:gist",
              "github:repo",
              "events:subscribe",
              "notify",
              "ai:complete"
            ]
          }
        },
        "connectAllowlist": {
          "default": [],
          "maxItems": 20,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 300
          }
        },
        "entry": {
          "default": "plugin.js",
          "type": "string",
          "pattern": "^[A-Za-z0-9._/-]{1,100}$"
        },
        "slots": {
          "default": [],
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "thread-head",
              "thread-post-inline",
              "thread-post-footer",
              "post-form-after",
              "board-head",
              "sidebar",
              "plugin-page",
              "site-header",
              "site-top",
              "board-top",
              "board-sidebar",
              "thread-top",
              "thread-nav",
              "post-form-extra",
              "thread-bottom",
              "board-manage",
              "post-actions"
            ]
          }
        },
        "hooks": {
          "default": [],
          "maxItems": 4,
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "beforePost",
              "onPostRendered"
            ]
          }
        },
        "render": {
          "type": "object",
          "properties": {
            "post": {
              "maxItems": 20,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "pattern": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500
                  },
                  "flags": {
                    "default": "g",
                    "type": "string",
                    "maxLength": 6,
                    "pattern": "^[gimsu]*$"
                  },
                  "template": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  "kind": {
                    "default": "text",
                    "type": "string",
                    "enum": [
                      "spoiler",
                      "dice",
                      "link",
                      "image",
                      "text"
                    ]
                  }
                },
                "required": [
                  "pattern",
                  "template"
                ]
              }
            }
          }
        },
        "author": {
          "type": "string",
          "maxLength": 60
        },
        "license": {
          "type": "string",
          "maxLength": 30
        },
        "homepage": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "name",
        "version",
        "summary",
        "scope"
      ]
    },
    "code": {
      "type": "string",
      "minLength": 1
    },
    "changelog": {
      "type": "string",
      "maxLength": 2000
    }
  },
  "required": [
    "code"
  ]
}
```

#### `semverSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
}
```

### `packages/shared/src/schemas/post.ts`

#### `attachmentSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "url": {
      "type": "string"
    },
    "contentType": {
      "default": "application/octet-stream",
      "type": "string"
    },
    "size": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "name": {
      "type": "string"
    }
  },
  "required": [
    "url"
  ]
}
```

#### `createPostRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "threadId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "name": {
      "type": "string",
      "maxLength": 64
    },
    "mail": {
      "type": "string",
      "maxLength": 256
    },
    "body": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    },
    "sage": {
      "type": "boolean"
    },
    "attachments": {
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 64
      }
    },
    "turnstileToken": {
      "type": "string"
    }
  },
  "required": [
    "body"
  ]
}
```

#### `komeRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "body": {
      "type": "string",
      "minLength": 1,
      "maxLength": 400
    },
    "name": {
      "type": "string",
      "maxLength": 64
    },
    "parentPostId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "turnstileToken": {
      "type": "string",
      "maxLength": 4096
    }
  },
  "required": [
    "body"
  ]
}
```

#### `pollResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "postId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "threadId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "options": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "endsAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "counts": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "totalVotes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "votedOption": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "postId",
    "threadId",
    "options",
    "endsAt",
    "createdAt",
    "counts",
    "totalVotes",
    "votedOption"
  ]
}
```

#### `pollSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "postId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "threadId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "options": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "endsAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "postId",
    "threadId",
    "options",
    "endsAt",
    "createdAt"
  ]
}
```

#### `postKindSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "post",
    "kome"
  ]
}
```

#### `postSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "threadId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "num": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "post",
        "kome"
      ]
    },
    "name": {
      "type": "string"
    },
    "mail": {
      "type": "string"
    },
    "trip": {
      "type": [
        "string",
        "null"
      ]
    },
    "cap": {
      "type": [
        "string",
        "null"
      ]
    },
    "body": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "idHash": {
      "type": "string"
    },
    "sage": {
      "type": "boolean"
    },
    "isOp": {
      "type": "boolean"
    },
    "isSub": {
      "type": "boolean"
    },
    "attachments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "url": {
            "type": "string"
          },
          "contentType": {
            "default": "application/octet-stream",
            "type": "string"
          },
          "size": {
            "default": 0,
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "name": {
            "type": "string"
          }
        },
        "required": [
          "url"
        ]
      }
    },
    "likeCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "liked": {
      "type": "boolean"
    },
    "backlinks": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      }
    },
    "hidden": {
      "type": "boolean"
    },
    "aiAgentId": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "id",
    "threadId",
    "boardId",
    "num",
    "kind",
    "name",
    "mail",
    "trip",
    "cap",
    "body",
    "createdAt",
    "idHash",
    "sage",
    "isOp",
    "isSub",
    "attachments",
    "likeCount",
    "liked",
    "backlinks",
    "hidden",
    "aiAgentId"
  ]
}
```

#### `reactionKindSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "like",
    "good",
    "bad"
  ]
}
```

#### `reactionRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "kind": {
      "default": "like",
      "type": "string",
      "enum": [
        "like",
        "good",
        "bad"
      ]
    }
  }
}
```

#### `reactionResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "postId": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "like",
        "good",
        "bad"
      ]
    },
    "count": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "liked": {
      "type": "boolean"
    }
  },
  "required": [
    "postId",
    "kind",
    "count",
    "liked"
  ]
}
```

#### `votePollRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "option": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9
    }
  },
  "required": [
    "option"
  ]
}
```

### `packages/shared/src/schemas/realtime.ts`

#### `komeCreatedEventSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "kome.created"
    },
    "channel": {
      "type": "string",
      "pattern": "^(board|thread):\\d+$"
    },
    "seq": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "at": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "data": {
      "type": "object",
      "properties": {
        "post": {
          "type": "object",
          "properties": {
            "id": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "threadId": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "boardId": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "num": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "kind": {
              "type": "string",
              "enum": [
                "post",
                "kome"
              ]
            },
            "name": {
              "type": "string"
            },
            "mail": {
              "type": "string"
            },
            "trip": {
              "type": [
                "string",
                "null"
              ]
            },
            "cap": {
              "type": [
                "string",
                "null"
              ]
            },
            "body": {
              "type": "string"
            },
            "createdAt": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "idHash": {
              "type": "string"
            },
            "sage": {
              "type": "boolean"
            },
            "isOp": {
              "type": "boolean"
            },
            "isSub": {
              "type": "boolean"
            },
            "attachments": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "url": {
                    "type": "string"
                  },
                  "contentType": {
                    "default": "application/octet-stream",
                    "type": "string"
                  },
                  "size": {
                    "default": 0,
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "name": {
                    "type": "string"
                  }
                },
                "required": [
                  "url"
                ]
              }
            },
            "likeCount": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "liked": {
              "type": "boolean"
            },
            "backlinks": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "hidden": {
              "type": "boolean"
            },
            "aiAgentId": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "id",
            "threadId",
            "boardId",
            "num",
            "kind",
            "name",
            "mail",
            "trip",
            "cap",
            "body",
            "createdAt",
            "idHash",
            "sage",
            "isOp",
            "isSub",
            "attachments",
            "likeCount",
            "liked",
            "backlinks",
            "hidden",
            "aiAgentId"
          ]
        }
      },
      "required": [
        "post"
      ]
    }
  },
  "required": [
    "type",
    "channel",
    "seq",
    "at",
    "data"
  ]
}
```

#### `postCreatedEventSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "post.created"
    },
    "channel": {
      "type": "string",
      "pattern": "^(board|thread):\\d+$"
    },
    "seq": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "at": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "data": {
      "type": "object",
      "properties": {
        "post": {
          "type": "object",
          "properties": {
            "id": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "threadId": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "boardId": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "num": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "kind": {
              "type": "string",
              "enum": [
                "post",
                "kome"
              ]
            },
            "name": {
              "type": "string"
            },
            "mail": {
              "type": "string"
            },
            "trip": {
              "type": [
                "string",
                "null"
              ]
            },
            "cap": {
              "type": [
                "string",
                "null"
              ]
            },
            "body": {
              "type": "string"
            },
            "createdAt": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "idHash": {
              "type": "string"
            },
            "sage": {
              "type": "boolean"
            },
            "isOp": {
              "type": "boolean"
            },
            "isSub": {
              "type": "boolean"
            },
            "attachments": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string"
                  },
                  "url": {
                    "type": "string"
                  },
                  "contentType": {
                    "default": "application/octet-stream",
                    "type": "string"
                  },
                  "size": {
                    "default": 0,
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "name": {
                    "type": "string"
                  }
                },
                "required": [
                  "url"
                ]
              }
            },
            "likeCount": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "liked": {
              "type": "boolean"
            },
            "backlinks": {
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "hidden": {
              "type": "boolean"
            },
            "aiAgentId": {
              "type": [
                "string",
                "null"
              ]
            }
          },
          "required": [
            "id",
            "threadId",
            "boardId",
            "num",
            "kind",
            "name",
            "mail",
            "trip",
            "cap",
            "body",
            "createdAt",
            "idHash",
            "sage",
            "isOp",
            "isSub",
            "attachments",
            "likeCount",
            "liked",
            "backlinks",
            "hidden",
            "aiAgentId"
          ]
        },
        "thread": {
          "type": "object",
          "properties": {
            "id": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "postCount": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "lastPostAt": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "id",
            "postCount",
            "lastPostAt"
          ]
        }
      },
      "required": [
        "post",
        "thread"
      ]
    }
  },
  "required": [
    "type",
    "channel",
    "seq",
    "at",
    "data"
  ]
}
```

#### `realtimeChannelSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "pattern": "^(board|thread):\\d+$"
}
```

#### `realtimeEventSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "enum": [
        "post.created",
        "post.updated",
        "post.hidden",
        "post.deleted",
        "kome.created",
        "thread.created",
        "thread.updated",
        "board.updated",
        "poll.updated",
        "hello"
      ]
    },
    "channel": {
      "type": "string",
      "pattern": "^(board|thread):\\d+$"
    },
    "seq": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "at": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "data": {}
  },
  "required": [
    "type",
    "channel",
    "seq",
    "at",
    "data"
  ]
}
```

#### `realtimeEventTypeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "post.created",
    "post.updated",
    "post.hidden",
    "post.deleted",
    "kome.created",
    "thread.created",
    "thread.updated",
    "board.updated",
    "poll.updated",
    "hello"
  ]
}
```

#### `rtTicketRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "channels": {
      "minItems": 1,
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^(board|thread):\\d+$"
      }
    }
  },
  "required": [
    "channels"
  ]
}
```

#### `rtTicketResponseSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ticket": {
      "type": "string"
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "channels": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^(board|thread):\\d+$"
      }
    },
    "wsPath": {
      "type": "string"
    }
  },
  "required": [
    "ticket",
    "expiresAt",
    "channels",
    "wsPath"
  ]
}
```

#### `threadCreatedEventSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "const": "thread.created"
    },
    "channel": {
      "type": "string",
      "pattern": "^(board|thread):\\d+$"
    },
    "seq": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "at": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "data": {
      "type": "object",
      "properties": {
        "thread": {
          "type": "object",
          "properties": {
            "id": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "boardId": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "boardSlug": {
              "type": "string"
            },
            "boardName": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "postCount": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "lastPostAt": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "createdAt": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "live": {
              "type": "boolean"
            },
            "pinned": {
              "type": "boolean"
            },
            "status": {
              "type": "string",
              "enum": [
                "active",
                "closed",
                "deleted"
              ]
            }
          },
          "required": [
            "id",
            "boardId",
            "boardSlug",
            "boardName",
            "title",
            "postCount",
            "lastPostAt",
            "createdAt",
            "live",
            "pinned",
            "status"
          ]
        }
      },
      "required": [
        "thread"
      ]
    }
  },
  "required": [
    "type",
    "channel",
    "seq",
    "at",
    "data"
  ]
}
```

### `packages/shared/src/schemas/report.ts`

#### `createReportRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string",
      "maxLength": 32
    },
    "threadId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "posts": {
      "default": "all",
      "type": "string",
      "maxLength": 256
    },
    "reason": {
      "type": "string",
      "enum": [
        "abuse",
        "spam",
        "offtopic",
        "adult",
        "csam",
        "illegal",
        "other"
      ]
    },
    "comment": {
      "default": "",
      "type": "string",
      "maxLength": 1000
    },
    "turnstileToken": {
      "type": "string"
    }
  },
  "required": [
    "threadId",
    "reason"
  ]
}
```

#### `handleReportRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "reject",
        "resolve",
        "hide",
        "delete"
      ]
    },
    "note": {
      "default": "",
      "type": "string",
      "maxLength": 1000
    }
  },
  "required": [
    "action"
  ]
}
```

#### `reportListQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "accepted",
        "rejected",
        "resolved"
      ]
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string",
      "maxLength": 32
    },
    "limit": {
      "default": 50,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "cursor": {
      "type": "string",
      "maxLength": 64
    }
  }
}
```

#### `reportReasonSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "abuse",
    "spam",
    "offtopic",
    "adult",
    "csam",
    "illegal",
    "other"
  ]
}
```

#### `reportSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "boardId": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string"
    },
    "threadId": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "threadTitle": {
      "type": "string"
    },
    "postIds": {
      "type": "array",
      "items": {
        "type": "integer",
        "minimum": -9007199254740991,
        "maximum": 9007199254740991
      }
    },
    "nums": {
      "type": "string"
    },
    "reason": {
      "type": "string",
      "enum": [
        "abuse",
        "spam",
        "offtopic",
        "adult",
        "csam",
        "illegal",
        "other"
      ]
    },
    "comment": {
      "type": "string"
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "accepted",
        "rejected",
        "resolved"
      ]
    },
    "handledBy": {
      "type": [
        "string",
        "null"
      ]
    },
    "handledAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "note": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "boardId",
    "boardSlug",
    "threadId",
    "threadTitle",
    "postIds",
    "nums",
    "reason",
    "comment",
    "status",
    "handledBy",
    "handledAt",
    "note",
    "createdAt"
  ]
}
```

#### `reportStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "pending",
    "accepted",
    "rejected",
    "resolved"
  ]
}
```

### `packages/shared/src/schemas/risk.ts`

#### `policyModeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "auto",
    "queue",
    "deny"
  ]
}
```

### `packages/shared/src/schemas/thread.ts`

#### `createThreadRequestSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string",
      "maxLength": 32
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "body": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096
    },
    "name": {
      "type": "string",
      "maxLength": 64
    },
    "mail": {
      "type": "string",
      "maxLength": 256
    },
    "attachments": {
      "maxItems": 10,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 64
      }
    },
    "turnstileToken": {
      "type": "string"
    }
  },
  "required": [
    "title",
    "body"
  ]
}
```

#### `threadListQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "sort": {
      "default": "bump",
      "type": "string",
      "enum": [
        "bump",
        "speed",
        "created",
        "posts"
      ]
    },
    "q": {
      "type": "string",
      "maxLength": 100
    },
    "tag": {
      "type": "string",
      "maxLength": 30
    },
    "cursor": {
      "type": "string",
      "maxLength": 128
    },
    "limit": {
      "default": 50,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  }
}
```

#### `threadPostsQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "r": {
      "type": "string",
      "maxLength": 64
    },
    "from": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "id": {
      "type": "string",
      "maxLength": 16
    },
    "q": {
      "type": "string",
      "maxLength": 100
    },
    "images": {
      "type": "string",
      "enum": [
        "1",
        "true"
      ]
    },
    "since": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  }
}
```

#### `threadSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string"
    },
    "boardName": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "titleFlags": {
      "type": "object",
      "properties": {
        "noId": {
          "default": false,
          "type": "boolean"
        },
        "sage": {
          "default": false,
          "type": "boolean"
        },
        "oekaki": {
          "default": false,
          "type": "boolean"
        },
        "maxPosts": {
          "default": null,
          "anyOf": [
            {
              "type": "integer",
              "minimum": 10,
              "maximum": 999
            },
            {
              "type": "null"
            }
          ]
        },
        "timer": {
          "default": false,
          "type": "boolean"
        },
        "live": {
          "default": false,
          "type": "boolean"
        }
      }
    },
    "live": {
      "type": "boolean"
    },
    "postCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "maxPosts": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "lastPostAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "bumpAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "pinned": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "closed",
        "deleted"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "boardId",
    "boardSlug",
    "boardName",
    "title",
    "titleFlags",
    "live",
    "postCount",
    "maxPosts",
    "lastPostAt",
    "bumpAt",
    "pinned",
    "status",
    "createdAt"
  ]
}
```

#### `threadSortSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "bump",
    "speed",
    "created",
    "posts"
  ]
}
```

#### `threadStateSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "akuIds": {
      "default": [],
      "maxItems": 200,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 16
      }
    },
    "akuDevices": {
      "default": [],
      "maxItems": 200,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 128
      }
    },
    "akuExpiresAt": {
      "default": null,
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "nopic": {
      "default": false,
      "type": "boolean"
    },
    "ngk": {
      "default": false,
      "type": "boolean"
    },
    "jien": {
      "default": false,
      "type": "boolean"
    },
    "addCount": {
      "default": 0,
      "type": "integer",
      "minimum": 0,
      "maximum": 50
    },
    "resetAt": {
      "default": null,
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  }
}
```

#### `threadStatusSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "active",
    "closed",
    "deleted"
  ]
}
```

#### `threadSummarySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "boardSlug": {
      "type": "string"
    },
    "boardName": {
      "type": "string"
    },
    "title": {
      "type": "string"
    },
    "postCount": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "lastPostAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "live": {
      "type": "boolean"
    },
    "pinned": {
      "type": "boolean"
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "closed",
        "deleted"
      ]
    }
  },
  "required": [
    "id",
    "boardId",
    "boardSlug",
    "boardName",
    "title",
    "postCount",
    "lastPostAt",
    "createdAt",
    "live",
    "pinned",
    "status"
  ]
}
```

#### `threadTitleFlagsSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "noId": {
      "default": false,
      "type": "boolean"
    },
    "sage": {
      "default": false,
      "type": "boolean"
    },
    "oekaki": {
      "default": false,
      "type": "boolean"
    },
    "maxPosts": {
      "default": null,
      "anyOf": [
        {
          "type": "integer",
          "minimum": 10,
          "maximum": 999
        },
        {
          "type": "null"
        }
      ]
    },
    "timer": {
      "default": false,
      "type": "boolean"
    },
    "live": {
      "default": false,
      "type": "boolean"
    }
  }
}
```

### `packages/shared/src/schemas/upload.ts`

#### `attachmentSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "postId": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "adapter": {
      "type": "string"
    },
    "url": {
      "type": "string"
    },
    "contentType": {
      "type": "string"
    },
    "kind": {
      "type": "string",
      "enum": [
        "image",
        "video",
        "audio",
        "text",
        "file"
      ]
    },
    "size": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "filename": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "active",
        "dead",
        "deleted"
      ]
    },
    "canDelete": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "postId",
    "adapter",
    "url",
    "contentType",
    "kind",
    "size",
    "filename",
    "createdAt",
    "expiresAt",
    "status"
  ]
}
```

#### `uploadCommitSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ticketId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    },
    "externalUrl": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2048
    },
    "response": {},
    "deleteUrl": {
      "type": "string",
      "maxLength": 2048
    }
  },
  "required": [
    "ticketId"
  ]
}
```

#### `uploadHistoryQuerySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "limit": {
      "default": 50,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "boardId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "unattached": {
      "anyOf": [
        {
          "type": "boolean"
        },
        {
          "type": "string",
          "enum": [
            "true",
            "false"
          ]
        }
      ]
    }
  }
}
```

#### `uploadHistoryResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "postId": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "adapter": {
            "type": "string"
          },
          "url": {
            "type": "string"
          },
          "contentType": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "enum": [
              "image",
              "video",
              "audio",
              "text",
              "file"
            ]
          },
          "size": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "filename": {
            "type": "string"
          },
          "createdAt": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "expiresAt": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "dead",
              "deleted"
            ]
          },
          "canDelete": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "postId",
          "adapter",
          "url",
          "contentType",
          "kind",
          "size",
          "filename",
          "createdAt",
          "expiresAt",
          "status"
        ]
      }
    },
    "limitReached": {
      "type": "boolean"
    }
  },
  "required": [
    "items",
    "limitReached"
  ]
}
```

#### `uploadPlanSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "const": "direct"
        },
        "url": {
          "type": "string",
          "minLength": 1
        },
        "method": {
          "type": "string",
          "enum": [
            "POST",
            "PUT"
          ]
        },
        "headers": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "formFields": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "string"
          }
        },
        "fileField": {
          "type": "string"
        },
        "resultType": {
          "type": "string",
          "enum": [
            "json",
            "text"
          ]
        }
      },
      "required": [
        "mode",
        "url",
        "method"
      ]
    },
    {
      "type": "object",
      "properties": {
        "mode": {
          "type": "string",
          "const": "proxy-stream"
        },
        "proxyPath": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "mode",
        "proxyPath"
      ]
    }
  ]
}
```

#### `uploadPrepareResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ticketId": {
      "type": "string"
    },
    "adapter": {
      "type": "string"
    },
    "mode": {
      "type": "string",
      "enum": [
        "direct",
        "proxy-stream"
      ]
    },
    "plan": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "const": "direct"
            },
            "url": {
              "type": "string",
              "minLength": 1
            },
            "method": {
              "type": "string",
              "enum": [
                "POST",
                "PUT"
              ]
            },
            "headers": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "formFields": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {
                "type": "string"
              }
            },
            "fileField": {
              "type": "string"
            },
            "resultType": {
              "type": "string",
              "enum": [
                "json",
                "text"
              ]
            }
          },
          "required": [
            "mode",
            "url",
            "method"
          ]
        },
        {
          "type": "object",
          "properties": {
            "mode": {
              "type": "string",
              "const": "proxy-stream"
            },
            "proxyPath": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "mode",
            "proxyPath"
          ]
        }
      ]
    },
    "maxBytes": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "contentType": {
      "type": "string"
    },
    "uploadToken": {
      "type": "string"
    },
    "expiresAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "ticketId",
    "adapter",
    "mode",
    "plan",
    "maxBytes",
    "contentType",
    "expiresAt"
  ]
}
```

#### `uploadPrepareSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "adapter": {
      "type": "string",
      "minLength": 1,
      "maxLength": 40,
      "pattern": "^[a-z0-9][a-z0-9_-]*$"
    },
    "contentType": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "size": {
      "type": "integer",
      "minimum": 1,
      "maximum": 99614720
    },
    "filename": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "boardId": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "purpose": {
      "type": "string",
      "maxLength": 32
    }
  },
  "required": [
    "contentType",
    "size",
    "filename"
  ]
}
```

#### `uploadProxyResultSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ticketId": {
      "type": "string"
    },
    "externalUrl": {
      "type": "string"
    },
    "contentType": {
      "type": "string"
    },
    "size": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "kind": {
      "type": "string",
      "enum": [
        "image",
        "video",
        "audio",
        "text",
        "file"
      ]
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "ticketId",
    "externalUrl",
    "contentType",
    "size",
    "kind",
    "expiresAt"
  ]
}
```

#### `uploaderAdapterIdSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "minLength": 1,
  "maxLength": 40,
  "pattern": "^[a-z0-9][a-z0-9_-]*$"
}
```

#### `uploaderAdapterInfoSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "mode": {
      "type": "string",
      "enum": [
        "direct",
        "proxy-stream"
      ]
    },
    "maxBytes": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "types": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "label": {
      "type": "string"
    },
    "available": {
      "type": "boolean"
    },
    "reason": {
      "type": "string"
    },
    "retentionSeconds": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "requiresGithub": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "mode",
    "maxBytes",
    "types",
    "label",
    "available",
    "retentionSeconds",
    "requiresGithub"
  ]
}
```

#### `uploaderAdapterListSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "mode": {
            "type": "string",
            "enum": [
              "direct",
              "proxy-stream"
            ]
          },
          "maxBytes": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "types": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "label": {
            "type": "string"
          },
          "available": {
            "type": "boolean"
          },
          "reason": {
            "type": "string"
          },
          "retentionSeconds": {
            "anyOf": [
              {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "requiresGithub": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "mode",
          "maxBytes",
          "types",
          "label",
          "available",
          "retentionSeconds",
          "requiresGithub"
        ]
      }
    },
    "defaultAdapter": {
      "type": "string"
    }
  },
  "required": [
    "items",
    "defaultAdapter"
  ]
}
```

### `packages/shared/src/schemas/webhook.ts`

#### `createWebhookInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "events": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "webhook.test",
          "report.created",
          "queue.pending",
          "queue.decided",
          "agent.suspended",
          "agent.resumed",
          "ai.stopped",
          "ai.resumed",
          "plugin.review.requested",
          "anomaly.detected"
        ]
      }
    },
    "description": {
      "type": "string",
      "maxLength": 500
    },
    "ownerType": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "account"
      ]
    },
    "ownerId": {
      "type": "string",
      "maxLength": 64
    }
  },
  "required": [
    "url",
    "events"
  ],
  "additionalProperties": false
}
```

#### `updateWebhookInputSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "events": {
      "minItems": 1,
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "webhook.test",
          "report.created",
          "queue.pending",
          "queue.decided",
          "agent.suspended",
          "agent.resumed",
          "ai.stopped",
          "ai.resumed",
          "plugin.review.requested",
          "anomaly.detected"
        ]
      }
    },
    "description": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 500
        },
        {
          "type": "null"
        }
      ]
    },
    "active": {
      "type": "boolean"
    }
  },
  "additionalProperties": false
}
```

#### `webhookDeliverySchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "webhookId": {
      "type": "string"
    },
    "event": {
      "type": "string",
      "enum": [
        "webhook.test",
        "report.created",
        "queue.pending",
        "queue.decided",
        "agent.suspended",
        "agent.resumed",
        "ai.stopped",
        "ai.resumed",
        "plugin.review.requested",
        "anomaly.detected"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "pending",
        "delivered",
        "failed",
        "exhausted"
      ]
    },
    "attempts": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "nextAttemptAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "responseStatus": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "error": {
      "type": [
        "string",
        "null"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "webhookId",
    "event",
    "status",
    "attempts",
    "nextAttemptAt",
    "responseStatus",
    "error",
    "createdAt",
    "updatedAt"
  ]
}
```

#### `webhookEventSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "type": {
      "type": "string",
      "enum": [
        "webhook.test",
        "report.created",
        "queue.pending",
        "queue.decided",
        "agent.suspended",
        "agent.resumed",
        "ai.stopped",
        "ai.resumed",
        "plugin.review.requested",
        "anomaly.detected"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "owner": {
      "type": "object",
      "properties": {
        "type": {
          "type": "string",
          "enum": [
            "site",
            "board",
            "account"
          ]
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "type",
        "id"
      ]
    },
    "data": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {}
    }
  },
  "required": [
    "id",
    "type",
    "createdAt",
    "owner",
    "data"
  ]
}
```

#### `webhookEventTypeSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "string",
  "enum": [
    "webhook.test",
    "report.created",
    "queue.pending",
    "queue.decided",
    "agent.suspended",
    "agent.resumed",
    "ai.stopped",
    "ai.resumed",
    "plugin.review.requested",
    "anomaly.detected"
  ]
}
```

#### `webhookSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "ownerType": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "account"
      ]
    },
    "ownerId": {
      "type": "string"
    },
    "url": {
      "type": "string"
    },
    "events": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "webhook.test",
          "report.created",
          "queue.pending",
          "queue.decided",
          "agent.suspended",
          "agent.resumed",
          "ai.stopped",
          "ai.resumed",
          "plugin.review.requested",
          "anomaly.detected"
        ]
      }
    },
    "description": {
      "type": [
        "string",
        "null"
      ]
    },
    "active": {
      "type": "boolean"
    },
    "createdBy": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "lastDeliveryAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "lastStatus": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "failureCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "id",
    "ownerType",
    "ownerId",
    "url",
    "events",
    "description",
    "active",
    "createdBy",
    "createdAt",
    "updatedAt",
    "lastDeliveryAt",
    "lastStatus",
    "failureCount"
  ]
}
```

#### `webhookSecretSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "secret": {
      "type": "string"
    }
  },
  "required": [
    "secret"
  ]
}
```

#### `webhookWithSecretSchema`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string"
    },
    "ownerType": {
      "type": "string",
      "enum": [
        "site",
        "board",
        "account"
      ]
    },
    "ownerId": {
      "type": "string"
    },
    "url": {
      "type": "string"
    },
    "events": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "webhook.test",
          "report.created",
          "queue.pending",
          "queue.decided",
          "agent.suspended",
          "agent.resumed",
          "ai.stopped",
          "ai.resumed",
          "plugin.review.requested",
          "anomaly.detected"
        ]
      }
    },
    "description": {
      "type": [
        "string",
        "null"
      ]
    },
    "active": {
      "type": "boolean"
    },
    "createdBy": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "lastDeliveryAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "lastStatus": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "failureCount": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "secret": {
      "type": "string"
    },
    "secretWarning": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "ownerType",
    "ownerId",
    "url",
    "events",
    "description",
    "active",
    "createdBy",
    "createdAt",
    "updatedAt",
    "lastDeliveryAt",
    "lastStatus",
    "failureCount",
    "secret",
    "secretWarning"
  ]
}
```

## 6. 未実装・要確認

なし（全ルートファイルに実装あり）。

> この一覧は生成時点の静的解析結果。実装が進んだら再生成すること。
