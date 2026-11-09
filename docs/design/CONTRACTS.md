# おーぷんクローン 実装契約書（CONTRACTS）

最終更新: 2026-11-08
正本設計: `docs/design/DESIGN.md`（§A に確定値）。作業分担: `docs/design/WORKPACKAGES.md`。
**このファイルだけで実装契約が分かる**ことを目標に記述する。

---

## 1. リポジトリ構成とパッケージ

```
open-clone/
├─ apps/
│  ├─ web/      # Next.js 16 App Router（output:'export'）。Vercel Hobby
│  └─ api/      # Cloudflare Workers（Hono v4）。単一 Worker
├─ packages/
│  ├─ shared/   # zod スキーマ・型・エラー・定数・暗号ライブラリ（TOTP/DES/Shift_JIS）
│  ├─ plugin-sdk/ # プラグイン SDK
│  └─ mcp/      # MCP サーバー定義
├─ e2e/         # Playwright 基盤・スタブ・テスト
└─ tools/       # 生成スクリプト（shiftjis-table など）
```

- **パッケージ名**: `web` / `api` / `shared` / `plugin-sdk` / `mcp` / `e2e`。`pnpm --filter` はこの短い名前を使う。
- **ワークスペース**: pnpm 12 + Turborepo。タスク定義は `turbo.json`（`pnpm dev` = `turbo run dev`）。
- **TS 設定**: `tsconfig.base.json` を継承。`moduleResolution: "Bundler"`。`strict: true`。shared は `lib: ["ES2022", "WebWorker"]`（WebCrypto/Response 用）。

## 2. 共通エラー形式（全 API 統一）

### 2.1 レスポンス envelope

| ケース | HTTP | JSON |
|---|---|---|
| 成功 | 200/201 | `{ "ok": true, "data": <T> }` |
| 失敗 | 4xx/5xx | `{ "ok": false, "code": "ERROR_CODE", "message": "人間向け説明", "details": ? }` |

- 実装: `packages/shared/src/schemas/common.ts` の `ok(data)` / `err(code, message, details?)` を使う。
- Hono での返回: `return c.json(ok(data))` / `return c.json(err(...), status)`。
- エラーコードは `packages/shared/src/errors.ts` の `ErrorCode` を使う。独自コードを新設する場合は同ファイルに追加（WP ごとの増殖を防ぐ）。

### 2.2 例外の投げ方

```ts
import { ApiError } from "shared";
throw ApiError.forbidden("板スタッフ権限（admin）が必要です");
throw ApiError.unauthorized();
throw ApiError.validation("boardId が不正です");
throw ApiError.notFound("スレッドが見つかりません");
```

- `errorHandler` ミドルウェアが全て捕捉し、envelope に変換する。**例外を throw するだけでよい**。
- `ZodError` は 400 `VALIDATION` と `details: issues` に自動変換される。
- 想定外エラーは 500 `INTERNAL` に丸め、内部情報は漏らさない。

## 3. 認証コンテキスト型

### 3.1 グローバルロール・板レベル

```ts
type GlobalRole = "owner" | "special_admin" | "user";
type BoardStaffLevel = "admin" | "deputy" | "moderator";
```

- 権限マトリクスは `packages/shared/src/schemas/permission.ts`。`can(role, action, { boardScope?, selfScope? })`。
- `PERMISSION_MATRIX` / `PERMISSION_ACTIONS` を参照。**新しい action はここに追加**すること。

### 3.2 リクエストコンテキスト（`AppRequestContext`）

`apps/api` の全ルートで `c.get("reqCtx")` からアクセス可能（WP0 の `requestContext` ミドルウェア済み）。

```ts
interface AppRequestContext {
  requestId: string;            // ULID
  device: {
    deviceId: string;           // oc_did Cookie（HttpOnly）
    deviceHash: string;         // HMAC(ID_SALT, device)。保存はこれだけ
    ip: string;                 // 接続元 IP（正規化前）
    ipHash: string;             // HMAC(ID_SALT, ip)。生 IP は保存しない
  };
  session: {
    tokenHash: string;          // SHA-256(session token)
    account: {
      id: string; name: string; email: string | null;
      role: GlobalRole; status: "active" | "suspended";
    };
    expiresAt: number;          // Unix seconds
  } | null;
}
```

### 3.3 認証ミドルウェア（`apps/api/src/lib/middleware/auth.ts`）

```ts
import { requireAuth, requireRole, requireBoardStaff, requireAction } from "../lib/middleware/auth";

// ログイン必須
app.get("/me", requireAuth, handler);

// グローバルロール
app.post("", requireRole("owner"), handler);
app.post("", requireAdmin, handler); // owner + special_admin

// 板スタッフ（WP1 の board_staff に依存。WP1 のマイグレーション後に有効）
app.post("", requireBoardStaff("moderator", "boardId"), handler);
// 第2引数 = パラメータ名（/v1/boards/:boardId/ なら "boardId"）

// 権限マトリクスの合成ロール評価（owner > special_admin > board_* > user > anon）
app.post("", requireAction("boardEdit", { boardScope: true }), handler);
```

## 4. 環境変数と秘密情報

### 4.1 一覧（`apps/api/src/lib/env.ts` の `Env` を参照）

| キー | 種別 | 用途 |
|---|---|---|
| `ENVIRONMENT` | var | `"development"` / `"production"` |
| `ALLOWED_ORIGINS` | var | カンマ区切りのオリジン許可リスト |
| `ID_SALT` | secret | 表示ID・`device_hash`・`ip_hash` の pepper |
| `ENC_KEY` | secret | GitHub トークン等の AES-GCM 暗号化鍵（WP4） |
| `OWNER_BOOTSTRAP_KEY` | secret | owner 初期セットアップの一度きりキー |
| `TURNSTILE_SECRET_KEY` | secret | Turnstile siteverify |

- **ローカル**: `apps/api/.dev.vars`（gitignore 済み）に設定。`apps/api/.dev.vars.example` をコピー。
- **本番**: `wrangler secret put <NAME>` で登録。
- **リポジトリに秘密を置かない**。CI で gitleaks（WP7）。

### 4.2 Turnstile

- ローカル・CI は公式テストキー（`shared/src/types/env.ts` の `TURNSTILE_TEST_KEYS`）で動作。
- 実際の siteverify は必ず Worker から `fetch` する（`lib/middleware/turnstile.ts`）。
- `requireTurnstile({ required: true })` を mutation に付ける。

## 5. API ルート追加手順

### 5.1 既存ルートの実装（自分の WP のルートファイルを差し替える）

`apps/api/src/routes/<file>.ts` は WP ごとに排他（WORKPACKAGES §3.2）。自分のファイルのスタブを実装に差し替えるだけ。

```ts
import { Hono } from "hono";
import { z } from "zod";
import { ok, err, ApiError, ErrorCode } from "shared";
import type { AppEnv } from "../lib/env";
import { requireAuth, requireBoardStaff } from "../lib/middleware/auth";
import { requireTurnstile } from "../lib/middleware/turnstile";

const app = new Hono<AppEnv>();

const CreateSchema = z.object({ title: z.string().min(1).max(100) });

app.post("", requireAuth, requireTurnstile(), async (c) => {
  const body = CreateSchema.parse(await c.req.json());
  // ... D1 処理（lib/db.ts の batch() 等を使う）
  return c.json(ok({ id: 1 }), 201);
});

export default app;
```

### 5.2 新規マウントが必要な場合

`apps/api/src/index.ts` に import と mount を追加する（すべてのルートは初期登録済みのため、通常は変更不要）。

### 5.3 エンドポイントのプレフィックス

| 種別 | プレフィックス | 用途 |
|---|---|---|
| REST（ユーザー/管理） | `/v1/*` | 通常の API |
| MCP | `/mcp` / `/mcp/legacy` | AI クライアント（WP5） |
| 専ブラ互換 | `/compat/*` | subject.txt/dat/RSS（WP1） |
| WebSocket | `/rt` / `/v1/rt/ticket` | リアルタイム（WP1） |

## 6. マイグレーション命名と実行

- ファイル: `apps/api/migrations/NNNN_<name>.sql`。番号帯は WP ごとに排他（WORKPACKAGES §3.3）。**自分の帯域外には作成禁止**。
- ローカル適用: `pnpm --filter api db:migrate:local`（= `wrangler d1 migrations apply open-clone --local`）。
- 他の帯域のテーブルを自分のマイグレーションで `ALTER` しない（変更は所有者と合意する）。
- seed は `e2e/fixtures/seed.sql`。本番には適用しない。

## 7. shared スキーマの追加/変更

- `packages/shared/src/schemas/<domain>.ts` はドメインの実装者が作成/更新。
- 追加後は `packages/shared/src/index.ts` に export 行を足す。
- 既存スキーマの意味変更・削除は影響 WP 全員の合意が必要（後方互換必須）。

## 8. ローカル起動手順

```sh
# 前提: Node 22+, pnpm 12
pnpm install

# ローカル秘密（公式テストキー入り。実秘密は書かない）
cp apps/api/.dev.vars.example apps/api/.dev.vars

# D1 マイグレーション
pnpm --filter api db:migrate:local

# 起動（API + Web 同時）
pnpm dev
```

- API: `http://127.0.0.1:8787`（`wrangler dev`）
- Web: `http://localhost:3000`（`next dev`）
- ヘルスチェック:
  - `curl http://127.0.0.1:8787/v1/health`
  - `curl http://localhost:3000/api/v1/health`（**rewrites 経由**）

### 8.1 ローカル D1 を直接操作するときの注意（重要）

- **`wrangler dev` の稼働中に、同じ `--persist-to` ディレクトリへ `wrangler d1 execute` / `d1 migrations apply` を実行しない。**
  ローカル D1（SQLite）のロックが競合し、Worker の書き込みリクエストが応答せずハングする（読み取りは通ることがあるため気づきにくい）。
- 手順: **dev を停止 → `wrangler d1 execute ... --persist-to <dir>` → dev を再起動**。
- ハングした場合は dev プロセス（`wrangler dev` と子の `workerd`）を完全に停止してから再起動する。
- テスト用の状態ディレクトリは WP ごとに分ける（§1 のポート表と同じ `--persist-to .wrangler/state-<WP>`）。

## 9. テストの書き方

### 9.1 単体テスト（packages/*）

- `vitest` を使用。Node 環境。
- `src/**/*.test.ts` に配置。`packages/shared` の例が参照実装。
- **crypto 系はゴールデンベクタを必須**にする（TOTP=RFC 6238、DES crypt=perl/glibc、trip=0ch+ 準拠 perl）。

### 9.2 API 統合テスト（apps/api）

- `@cloudflare/vitest-plugin` を使用（Miniflare ベース、workersd 実行）。vitest は ^4.1.0 固定（v5 非対応）。
- D1 マイグレーションは `test/apply-migrations.ts` で自動適用。
- 外部 HTTP（Turnstile/GitHub/アップローダ）は MSW（`test/network.ts`）でモック。
- `test/health.test.ts` が参照実装（SELF.fetch でルートに投げる）。

### 9.3 E2E（e2e/）

- Playwright。WP7 が整備。spec は `e2e/<wp>/` に配置（所有は WORKPACKAGES §3.5）。
- 外部サービスは `e2e/helpers/stubs.ts` のスタブで代用。

## 10. 無料枠ガード（全 WP 共通の設計前提）

- Worker CPU 10ms/req: **PBKDF2 は WebCrypto 100k iter で 14ms（workerd 実測）**。これ以上の身上は使えない。BCrypt/Argon2 は不可。
- D1 1投稿の `rows_written ≤ 12` を WP1 の受入条件でテストする。
- DO は SQLite-backed のみ（`new_sqlite_classes`）。KV-backed は使わない。
- Cron 上限 5（wrangler.toml で既に 5 個を割当済み。追加は設計変更）。
- 添付本体は Cloudflare に保存しない。R2 禁止。

## 11. open2ch 互換 URL の扱い（WP1/WP2 向け）

- スレ閲覧: `/b/:slug/t/:id?r=l50|1-100|n|3,4,8`（`?r=` で範囲指定）。`/test/read.cgi/<board>/<key>/l50` も同じシェルで受けられる（vercel.json rewrites で `/test/* → index.html`）。
- 専ブラ互換は Worker 側 `/compat/<slug>/subject.txt`・`/compat/<slug>/dat/<id>.dat`（**Shift_JIS 出力**）。`packages/shared/src/lib/shiftjis.ts` を使う。
- 画像一覧: `/b/:slug/t/:id?r=images`（クエリ方式）。

## 12. WP 間サービス契約（現在のスタブ一覧）

| ファイル | 関数 | 消費 WP | 所有者 |
|---|---|---|---|
| `apps/api/src/services/uploads/attach.ts` | `attachToPost(postId, ids)` | WP1 | WP4 |
| `apps/api/src/services/github/service.ts` | `createGist/pushToRepo/listUserRepos/getRateInfo` | WP3 | WP4 |
| `apps/api/src/lib/pipeline.ts` | `createPostInternal/createThreadInternal/createTsubuyakiInternal`（投稿・スレ作成・つぶやきの唯一の経路） | WP1/WP5 | WP1 |
| `apps/api/src/services/board/index.ts` | `hidePost/unhidePost/deletePost`（管理操作のみ。投稿系は pipeline を直接呼ぶ） | WP1 | WP1 |
| `apps/api/src/services/plugins/static-checks.ts` | `runStaticChecks(code)` | WP5 | WP3 |
| `apps/api/src/services/ai/policy-engine.ts` | `enforceAiPolicy(agent, action, params)` | WP5 | WP5 |
| `apps/api/src/services/account/index.ts` | `verifySession/token`, `issueInvite` | WP6 | WP6 |

## 13. 既知の制約（WP0 確定値。詳細は DESIGN.md §A）

| 項目 | 確定値 |
|---|---|
| パスワードハッシュ | PBKDF2-SHA256（WebCrypto）、**100,000 iter**（Workers Free 上限・workerd 実測 14ms） |
| vitest バージョン | **^4.1.0**（Cloudflare プラグインは v5 非対応） |
| FTS5 | trigram は **3文字以上必須**（2文字は LIKE フォールバック。実測で確認） |
| MCP | `@modelcontextprotocol/server` v2 + `agents` v0.33+（@cloudflare/vitest-pool-workers は deprecated → @cloudflare/vitest-plugin 使用） |
| 表示 ID | **4 文字**（open2ch 実測） |
| トリップ | 2ch 互換 **10 桁**、SJIS バイト切詰め、glibc crypt(3) 一致（ゴールデンベクタで検証済み） |
