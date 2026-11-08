# おーぷんクローン 作業パッケージ分解 (WORKPACKAGES)

最終更新: 2026-11-08
設計正本: `docs/design/DESIGN.md`（§参照は同書）。要件: `docs/REQUIREMENTS.md`。

---

## 1. 分割方針と排他ルール

- **ファイル排他**: 下表の「担当ディレクトリ/ファイル」は各 WP が作成・編集する。他 WP のファイルへの変更が必要な場合は Issue で依頼し、合意してから編集する。
- **競合しやすい共有資源の事前割当**:
  1. **フロントのルート**: `apps/web/src/app/` 配下のルートディレクトリは WP ごとに排他（§3.1）。
  2. **API のルートファイル**: `apps/api/src/routes/` 配下のファイルは WP ごとに排他（§3.2）。ルート登録は**自分のファイル内で `app.route()` 用の Hono サブアプリを export** し、`apps/api/src/index.ts` が import して mount する。mount リストは §3.2 の表に従い**全ルート分を初期登録済みで提供する**ため、通常は編集不要。
  3. **D1 マイグレーション番号**: `apps/api/migrations/` の連番を WP ごとに帯域割当（§3.3）。ファイル名 `<NNNN>_<name>.sql`（NNNN は 4 桁 0 埋め）。**自分の帯域外には作成禁止**。帯域内で番号が飛んでも wrangler は昇順適用のため問題ない。
  4. **shared のスキーマファイル**: `packages/shared/src/schemas/<domain>.ts` はドメインの実装者が作成（§3.4）。`index.ts`（バレル）はドメイン別の export を 1 行ずつ持つため、追加は 1 行追加で行う。
  5. **E2E spec**: `e2e/<wp>/…` はディレクトリごと WP 所有（§3.5）。`e2e/` 直下の共通ヘルパ・設定は WP7 所有。
- **契約変更**: `packages/shared` の既存スキーマの意味変更・削除は、影響する実装の合意（Issue での依頼→応答）なしに禁止。追加は可（後方互換必須）。
- **結合点（インターフェース）**: 各 WP の「提供インターフェース」欄に列挙する関数/エンドポイント/スキーマが契約。変更時は Issue で合意する。

---

## 2. WP 一覧・依存関係

```
WP0 (基盤) ──┬─► WP1 (掲示板コアAPI) ──┬─► WP2 (掲示板フロントUI) ─► WP7 (テスト/CI/ドキュメント)
             ├─► WP3 (プラグイン) ─────┤            ▲
             ├─► WP4 (GitHub+アップローダ) ──────────┤(WP4はWP2に埋込コンポ提供)
             ├─► WP5 (AI運営) ───────────────────────┘
             └─► WP6 (アカウント/特別管理人/管理画面) ─┘
```

| WP | 名称 | 依存 | 並行可能相手 |
|---|---|---|---|
| WP0 | 基盤スキャフォールド/共通スキーマ | なし（**最初に完了させる**） | — |
| WP1 | 掲示板コアAPI | WP0 | WP3/WP4/WP5/WP6（WP0 完了後は全WP並行） |
| WP2 | 掲示板フロントUI | WP0、WP1（契約確定後はモックで先行可） | WP1 とは契約ベースで並行可 |
| WP3 | プラグイン（サーバ+SDK+UI） | WP0、WP1（boards/threads 参照）、WP4（github サービス） | WP4 の github サービスはスタブ契約で並行可 |
| WP4 | GitHub連携+アップローダ | WP0、WP1（posts への添付紐付け点のみ） | WP1 と並行可（`attachToPost` は WP1 が WP4 の export を呼ぶ） |
| WP5 | AI運営（REST+MCP+ダッシュボード） | WP0、WP1（操作対象の掲示板API内部関数）、WP3（プラグイン審査 action） | 政策エンジンは WP0 の shared スキーマ確定後すぐ着手可 |
| WP6 | アカウント/特別管理人/TOTP/管理画面 | WP0、WP1（board_staff の権限ミドルウェア） | アカウント認証部分は WP0 完了後すぐ着手可 |
| WP7 | テスト/CI/ドキュメント | 全WP（段階的: CI 雛形は WP0 直後から） | 全期間並行 |

---

## 3. 共有資源の割当表

### 3.1 フロントルート（`apps/web/src/app/` 配下、すべて排他）

| ルート | 所有WP | 内容 |
|---|---|---|
| `layout.tsx`, `globals.css`, `page.tsx`(トップ), `_shell/` | WP2 | サイト共通レイアウト・トップページ・シェル |
| `b/[slug]/page.tsx`, `b/[slug]/t/[id]/page.tsx`, `b/[slug]/manage/`, `boards/new/` | WP2 | 板・スレ閲覧/投稿UI、板管理UI（スタッフ任免の呼び出しは WP6 の API を叩く） |
| `settings/` | WP2 | 個人設定（NG・表示・忍法帖表示） |
| `plugins/`, `b/[slug]/plugins/` | WP3 | プラグイン一覧/作成/詳細/板導入UI |
| `account/` (登録・ログイン・TOTP設定・GitHub連携) | WP6 | アカウント系UI |
| `admin/` (全体ダッシュボード・招待・AI承認キュー・監査・通報・使用量) | WP6 | 管理画面。うち `/admin/ai/` サブツリーのみ WP5 が所有（表の次の行参照） |
| `admin/ai/` (AIダッシュボード・キュー承認UI) | WP5 | WP6 の admin レイアウトの下に配置（レイアウト編集権は WP6） |
| `admin/reports/` | WP1 | 通報処理UI（全体）。板スタッフ向けは `b/[slug]/manage/reports`（WP2 所有、WP1 API 呼び出し） |
| `search/`, `ranking/`, `headline/` | WP1 | 検索・ランキング・ヘッドライン UI（API は WP1。表示コンポーネントは WP1 が所有） |
| `compat/` なし（専ブラ互換は Worker 側のみ） | — | フロントルートを作らない |

静的エクスポート注意: 動的セグメント（`[slug]`,`[id]`）はシェル+クライアントルーティング方式（DESIGN §6.1）。`vercel.json`・`next.config.ts` は WP0 所有（変更は Issue で依頼）。

ルート以外のフロント資源の所有: `apps/web/src/components/*`（共通UI）= WP2。ただし WP 提供コンポは例外で、`components/uploader/*`・`components/github-link-panel.tsx` = WP4、`components/ai-board-panel.tsx` = WP5、`features/plugin-host/*` = WP3。消費側は import のみ（編集禁止）。`apps/web/public/*` = WP2（独自生成素材）。

### 3.2 API ルートファイル（`apps/api/src/routes/` 配下、すべて排他。index.ts が mount 済み）

| ファイル | mount 先 | 所有WP |
|---|---|---|
| `meta.ts` | `/v1/meta/*`(health, usage) | WP0 |
| `auth.ts` | `/v1/auth/*`(register, login, logout, session, totp/*, recovery) | WP6 |
| `github-auth.ts` | `/v1/github/oauth/*`, `/v1/github/link*` | WP4 |
| `accounts.ts` | `/v1/accounts/*`(自分情報, アカウント停止はadmin) | WP6 |
| `invites.ts` | `/v1/admin/invites/*`(発行, accept) | WP6 |
| `admin.ts` | `/v1/admin/*`(site settings, suspensions, audit, owner setup) ※ invites・ai 除く | WP6 |
| `boards.ts` | `/v1/boards/*`(一覧, 作成, 詳細, 設定, スタッフ任免) | WP1 |
| `threads.ts` | `/v1/threads/*`(一覧, 作成, レス取得 ?since, 実況) | WP1 |
| `posts.ts` | `/v1/posts/*`(作成, kome, 削除/非表示, 投票, 安価) | WP1 |
| `search.ts` | `/v1/search/*` | WP1 |
| `ranking.ts` | `/v1/ranking/*`, `/v1/headline/*` | WP1 |
| `reports.ts` | `/v1/reports/*`(通報作成, 一覧, 処理) | WP1 |
| `compat.ts` | `/compat/*`(subject.txt, dat, bbs.cgi 互換, rss) | WP1 |
| `rt.ts` | `/v1/rt/ticket`, `/rt`(WS) | WP1 |
| `uploads.ts` | `/v1/uploads/*`(prepare, proxy, commit, history, delete) | WP4 |
| `github-files.ts` | `/v1/github/files/*`(repo/gist CRUD プロキシ), `/v1/github/hooks/*` | WP4 |
| `plugins.ts` | `/v1/plugins/*`(CRUD, code 配信, install, review, hooks/github) | WP3 |
| `plugin-net.ts` | `/v1/plugin-net/*`(サンドボックス net:fetch プロキシ) | WP3 |
| `ai.ts` | `/v1/ai/*`(agents CRUD, policies, queue, audit, stop, webhooks CRUD) | WP5 |
| `mcp.ts` | `/mcp`, `/mcp/legacy` | WP5 |

Worker 内部ライブラリ（`apps/api/src/lib/`）も同様に排他:
| ファイル/ディレクトリ | 所有WP | 内容 |
|---|---|---|
| `lib/env.ts`, `lib/context.ts`, `lib/middleware/*`(auth, origin, device, error) , `lib/db.ts`, `lib/do.ts` | WP0 | 共通基盤。`requireRole`/`requireBoardStaff` は WP0 が実装（板スタッフ判定の D1 クエリは WP1 のマイグレーション後に WP0 が追加実装 — 順序依存は WP0 が吸収） |
| `lib/pipeline.ts`, `lib/commands.ts`(コマンド解釈), `lib/id.ts`(表示ID), `services/board/*` | WP1 | 書き込みパイプライン（DESIGN §6.3） |
| `lib/trip.ts`(DESトリップ), `lib/shiftjis.ts` | WP0 | shared から import する薄いラッパ（実体は shared） |
| `services/uploads/*`, `services/github/*` | WP4 | アダプタ実装(`adapters/catbox.ts`,`cloudinary.ts`,`gist.ts`,`github.ts`,`mock.ts`)・github service |
| `services/plugins/*` | WP3 | レジストリ・審査補助・静的検査 |
| `services/ai/*`(policy-engine.ts, risk.ts, queue-exec.ts, monitor.ts, webhook.ts) | WP5 | 政策エンジン（REST/MCP 共通の唯一の強制点） |
| `durable/realtime-hub.ts`, `durable/rate-limiter.ts` | WP1 | DO クラス（SQLite-backed、Hibernation） |
| `durable/ai-gate.ts` | WP5 | DO クラス（緊急停止フラグ） |
| `cron.ts` | WP7 が雛形、各 WP が自分の handler 関数を `services/*/cron.ts` に提供し `cron.ts` は import のみ | Free 5 cron 上限（DESIGN §3.3）: ①監視/警報(WP5) ②ランキングsnapshot(WP1) ③板自動削除/prune(WP1) ④添付リンク死活(WP4) ⑤webhook再送/ログ掃除(WP5)。割当を変えるときは設計変更として扱う |

### 3.3 D1 マイグレーション番号帯（`apps/api/migrations/NNNN_*.sql`、帯域排他）

| 帯域 | 所有WP | 内容 |
|---|---|---|
| 0001–0099 | WP0 | `accounts`, `sessions`, `site_config`, `audit_log` + 共通索引 |
| 0100–0299 | WP1 | `boards`, `board_staff`, `threads`, `thread_subs`, `thread_state`, `posts`, `posts_fts`, `backlinks`, `tags`, `thread_tags`, `polls`, `poll_votes`, `board_bans`, `reports`, `counters`, `ranking_snapshots`, `devices` |
| 0300–0399 | WP3 | `plugins`, `plugin_versions`, `plugin_installs`, `plugin_state`, `plugin_reviews` |
| 0400–0499 | WP4 | `attachments`, `uploader_adapters`, `github_links`, `github_ops_log` |
| 0500–0599 | WP5 | `ai_agents`, `ai_policies`, `ai_queue`, `ai_audit`, `webhooks`, `webhook_deliveries` |
| 0600–0699 | WP6 | `account_totp`, `recovery_codes`, `invites`, `suspensions` |
| 0700–0799 | WP7 | テスト用シードデータ専用（本番適用されない fixture は `e2e/fixtures/` に置き、0700 帯は schema 調整パッチ用予備） |

ルール: **他WPのテーブルを自分のマイグレーションで ALTER しない**。必要なら Issue で依頼し、所有者が自分の帯域で追加する。seed データ（デモ板等）は `e2e/fixtures/seed.sql`（WP7）。

### 3.4 packages/shared ファイル割当（`packages/shared/src/`）

| ファイル | 所有WP |
|---|---|
| `index.ts`(バレル), `types/env.ts`, `types/context.ts`, `errors.ts`, `constants.ts`(上限値・予約) | WP0 |
| `lib/des.ts`(トリップ用DES), `lib/shiftjis.ts`, `lib/ulid.ts`, `lib/hmac.ts`, `lib/totp.ts` | WP0 |
| `schemas/common.ts`(envelope, pagination), `schemas/account.ts`, `schemas/permission.ts`(ロール・権限マトリクスの機械可読版) | WP0 |
| `schemas/board.ts`, `schemas/thread.ts`, `schemas/post.ts`, `schemas/commands.ts`(コマンド記法), `schemas/anchor.ts`, `schemas/report.ts`, `schemas/realtime.ts`(WSイベント), `schemas/compat.ts` | WP1 |
| `schemas/plugin.ts`(manifest, permissions, RPC envelope) | WP3 |
| `schemas/upload.ts`, `schemas/github.ts` | WP4 |
| `types/uploader-adapter.ts`(アダプタ IF 型) | WP0 が初期提供。変更は型の提供元と合意する |
| `schemas/risk.ts`(action カタログ), `schemas/ai.ts`(agent/policy/queue), `schemas/mcp.ts`, `schemas/webhook.ts` | WP5 |
| `schemas/admin.ts`(invite, suspension), `schemas/auth.ts`(session, totp) | WP6 |

`packages/plugin-sdk/` 全体 = WP3。`packages/mcp/` 全体 = WP5。

### 3.5 E2E spec（`e2e/`）

| ディレクトリ | 所有WP | 内容 |
|---|---|---|
| `e2e/playwright.config.ts`, `e2e/helpers/*`, `e2e/fixtures/*` | WP7 | 基盤（起動スクリプト・スタブ外部サービス・シード） |
| `e2e/core/*.spec.ts`（投稿〜実況〜kome、板作成、検索、ランキング） | WP1+WP2 | |
| `e2e/plugin/*.spec.ts`（作成→実行→公開→導入、sandbox セキュリティ） | WP3 | |
| `e2e/upload/*.spec.ts`（アップロード、GitHub連携モック） | WP4 | |
| `e2e/ai/*.spec.ts`（REST+MCP 政策シナリオ、injection） | WP5 | |
| `e2e/account/*.spec.ts`（登録、TOTP、特別管理人就任、admin権限） | WP6 | |
| `e2e/security/*.spec.ts`（権限マトリクス全行、CSRF、XSS、sandbox escape） | WP7 | |

---

## 4. WP 詳細

> 全 WP 共通の受入条件（以下、各 WP では差分のみ記載）:
> - a. `pnpm lint && pnpm typecheck && pnpm test`（自分の担当範囲）がパス。
> - b. 担当ファイル以外を変更していない（変更は Issue で合意済み）。
> - c. zod スキーマは `packages/shared` を使い、ローカル重複定義をしない。
> - d. 秘密情報をリポジトリに置かない。
> - e. 完了定義は「動くコード+テスト」であり、スタブ/TODO 残しは不可（DESIGN §15 の制約に該当する場合のみ、制約を README か Issue に明記）。

### WP0 基盤スキャフォールド/共通スキーマ（最初に完了）

- **担当範囲**: monorepo 初期化（`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`）、`apps/web/`（Next 初期設定・`next.config.ts`・`vercel.json`・layout 骨格・rewrites プロキシ設定）、`apps/api/`（wrangler.toml、`src/index.ts`、§3.2 の全ルートファイルの**空 mount スタブ**、`lib/` 共通基盤、migrations 0001–0099）、`packages/shared/`（§3.4 の WP0 所有分）、`.github/workflows/ci.yml` 雛形（WP7 が引き継ぐ）、`docs/design/*`（本2ファイル）、`.env.example`、`README.md` 骨格。
- **依存**: なし。
- **提供インターフェース**:
  - `lib/context.ts`: `AppContext`（env, device_hash, ip, account, session）を生成するミドルウェア。
  - `requireRole(...)` / `requireBoardStaff(level)` / `requireTurnstile()` / `originGuard` ミドルウェア。
  - `lib/db.ts`: batch/transaction ヘルパ、rows_written カウントユーティリティ。
  - `lib/totp.ts`・`lib/des.ts`・`lib/shiftjis.ts`（RFC6238 テストベクトル・2ch互換トリップ・SJIS 変換の単体テスト付き）。
  - `schemas/common.ts`（`ApiResponse<T>` envelope, cursor pagination）, `schemas/permission.ts`（DESIGN §5.4 マトリクスの機械可読版: `can(role, action)`）。
  - `uploader-adapter.ts` 型（WP4 が実装）。
  - DO namespace 宣言（wrangler.toml: `REALTIME`・`RATE_LIMITER`・`AI_GATE`、**全て `new_sqlite_classes`**）。
  - スパイク結果: FTS5 trigram 可否・D1 行サイズ実測・Turnstile テストキー動作 → DESIGN §A に記録し `constants.ts` に反映。
- **受入条件**: 共通条件 + ①`pnpm dev`（turbo 経由で wrangler dev + next dev + rewrites プロキシ）がローカルで起動し、`GET /v1/meta/health` が web 同一オリジン `/api/meta/health` 経由で 200 を返す ②全ルートスタブが mount 済みで 404 にならない ③migrations 0001 適用済み ④`can()` のユニットテストが §5.4 マトリクスの全セルをカバー。

### WP1 掲示板コアAPI

- **担当範囲**: §3.2 の WP1 ルートファイル群、`lib/pipeline.ts`・`lib/commands.ts`・`lib/id.ts`、`services/board/*`、`durable/realtime-hub.ts`・`rate-limiter.ts`、migrations 0100–0299、shared の WP1 スキーマ群、フロント `search/`・`ranking/`・`headline/`・`admin/reports/` ルート。
- **依存**: WP0。WP4 の `attachToPost()`（契約: `services/uploads/attach.ts` が `attachToPost(postId, attachmentIds[])` を export。WP4 未完了時は no-op スタブを WP4 が提供）。
- **提供インターフェース**:
  - REST: boards/threads/posts/search/ranking/reports/compat/rt（§3.2 の mount 先）。
  - 内部関数（他 WP が import）: `createPost()`（WP5 の medium 投稿が使用）、`hidePost()`/`deletePost()`（WP5）、`setBoardStaff()`（WP6 の UI から）、`getThread()/getBoard()`（WP3/WP5）。
  - WS イベント型 `schemas/realtime.ts`（WP2/WP3 が購読）。
  - 専ブラ互換 `/compat/*`（subject.txt/dat、Shift_JIS）。
- **受入条件**: 共通条件 + ①DESIGN §6.2 の「必須」機能の API 統合テスト（@cloudflare/vitest-pool-workers）が全てパス: 投稿（ID/トリップ/安価解決/backlinks/sage/kome）、1000レス上限、!aku/!sub/!cap の主副権限、投票 1IP1票、板作成/1週間無投稿削除 cron、通報作成/処理、FTS5+LIKE 検索、ランキング snapshot、compat dat の Shift_JIS バイト一致 ②RealtimeHub: Hibernation 使用（`ctx.acceptWebSocket` + autoResponse）、再接続で差分返却、publish→購読者受信の統合テスト ③RateLimiter の窓制限テスト ④**1投稿の rows_written ≤12 を D1 meta で assert** ⑤権限ミドルウェアの 403 テスト（§5.4 の板スタッフ行） ⑥e2e/core の API 前提部分がグリーン。

### WP2 掲示板フロントUI

- **担当範囲**: `apps/web/src/app/` の WP2 ルート（§3.1: layout, トップ, `b/`, `settings/`）、`apps/web/src/components/*`（共通UI。ただし `components/uploader/*`・`components/github-link-panel.tsx` は WP4、`components/ai-board-panel.tsx` は WP5 所有＝import して使う）、`apps/web/src/features/board-ui/*`（投稿フォーム、レス表示、安価ポップアップ、NG、お絵かきエディタ、kome オーバーレイ、実況モード、履歴/ブクマ、忍法帖表示）、`e2e/core/*.spec.ts`、`apps/web/public/*`（favicon・OGP 等の**独自生成素材**、既存サイト素材の流用禁止）。
- **依存**: WP0、WP1（契約確定後モックで先行可）。WP4（アップロード UI コンポーネント `components/uploader/*` を WP4 が提供し、WP2 が投稿フォームに組み込む）、WP3（プラグインスロット `<PluginSlot>` を WP3 が提供し layout に組み込む — layout への組み込み行は WP2 が WP3 の export を import する形）。
- **提供インターフェース**: `components/` の共有UI（他 WP の admin/plugins ページが import 可）、`features/board-ui/uploader-mount.tsx`（WP4 コンポの差し込み点）、デザイン トークン（Tailwind theme、open2ch 実測値ベース: 緑系 #CCFFCC/#EFEFEF、名前 #228811、スレタイ赤、メイリオ系フォント — ただしコード/画像は独自実装）。
- **受入条件**: 共通条件 + ①PC/スマホ両対応（レスポンシブ、sticky 投稿欄、スワイプでスレ無視）を Playwright viewport テストで確認 ②板一覧→スレ（範囲URL `?r=l50|1-100|n|3,4,8`）→投稿→WS 新着反映→kome 弾幕→安価ポップアップ→NG（3段階）→お絵かき→実況追尾 の e2e/core がグリーン ③設定ページ（NG・表示・新着音・読み上げ）が localStorage に永続化 ④静的エクスポート（`next build && output export`）が成功し、シェル+クライアントルーティングで全 URL が表示 ⑤Lighthouse mobile ≥80（performance は目標値）。

### WP3 プラグイン（サーバ+SDK+UI）

- **担当範囲**: `packages/plugin-sdk/` 全体、shared の `schemas/plugin.ts`、`apps/api/src/routes/plugins.ts`・`plugin-net.ts`、`services/plugins/*`、migrations 0300–0399、フロント `plugins/`・`b/[slug]/plugins/` ルート、`apps/web/src/features/plugin-host/*`（sandbox iframe ランナー、bridge、スロット、宣言的レンダー規則実行、プレビュー）、公式プラグイン例（`examples/plugins/`: 将棋/オセロ/ネタバレ等の遊び系、koe アダプタ）、`e2e/plugin/*.spec.ts`。
- **依存**: WP0、WP1（board/thread 実体）、WP4 の github サービス（契約: `services/github/service.ts` の `createGist()/pushToRepo()/getRateInfo()`。未完了時は WP4 スタブ）。
- **提供インターフェース**:
  - `packages/plugin-sdk`: `definePlugin({manifest, activate(api)})`、`api.ui|data|storage|net|upload|github|events|notify`（型付き）。
  - REST: `/v1/plugins/*`（一覧/検索/詳細/作成/更新/公開申請/承認/停止/install/code 配信・バージョン不変キャッシュ）。
  - ホスト: `<PluginSlot name="...">` コンポーネント（WP2 が import）、bridge RPC envelope（`schemas/plugin.ts`）。
  - 内部: `runStaticChecks(code)`（WP5 の AI 審査が呼ぶ）。
- **受入条件**: 共通条件 + ①Web エディタ（CodeMirror）でプラグイン作成→プレビュー実行→保存→公開申請→承認→板/個人インストール→更新→停止（kill イベント）の全ライフサイクル e2e がグリーン ②**GitHub 連携なしで**レジストリ公開・検索・インストール・更新が完結する e2e ③Gist/repo への発行・取込（WP4 モックで可）④sandbox セキュリティテスト: `document.cookie` 不可・親 DOM 不可・allowlist 外 fetch 拒否・`net:fetch` プロキシの監査記録・権限なし API 呼び出しの拒否 ⑤manifest 権限の全種（DESIGN §7.2）に対する bridge 許可/拒否テスト ⑥公式プラグイン例 ≥3 個が動作 ⑦plugin-sdk の型テスト（tsd 相当）。

### WP4 GitHub連携+アップローダ

- **担当範囲**: shared の `schemas/upload.ts`・`schemas/github.ts`、`apps/api/src/routes/uploads.ts`・`github-auth.ts`・`github-files.ts`、`services/uploads/*`（アダプタ: catbox/cloudinary/gist/github/mock + `attach.ts`）、`services/github/*`、migrations 0400–0499、フロント `apps/web/src/components/uploader/*`（ドラッグ&ドロップ/貼付/進捗/履歴UI。WP2 が差し込み）と `apps/web/src/components/github-link-panel.tsx`（連携UI。**`account/` ルートは WP6 所有**のため、WP6 の `account/github/page.tsx` がこのコンポを import する形）、`e2e/upload/*.spec.ts`。
- **依存**: WP0。WP1 の投稿経路とは `attachToPost()` 契約のみ。
- **提供インターフェース**:
  - `services/uploads/attach.ts`: `attachToPost(postId, ids[])`（WP1 が import）。
  - `services/github/service.ts`: `createGist()/pushToRepo()/listUserRepos()/getRateInfo()`（WP3 が import）。
  - REST: `/v1/uploads/*`・`/v1/github/*`、`UploaderAdapter` IF（DESIGN §9.1）。
  - コンポ: `<UploaderButton>`・`<UploadHistory>`・`<GithubLinkPanel>`。
- **受入条件**: 共通条件 + ①アダプタ ≥2（catbox proxy-stream + cloudinary direct）+ gist + mock が `UploaderAdapter` IF 準拠で動作し、**切替が板設定のみで可能**な統合テスト ②catbox proxy-stream が 95MB まで中継し、Worker メモリに溜めない（stream 使用）ことをテスト ③Cloudflare 側にファイル本体が一切保存されないことをテストで assert（R2/KV/DO 未使用・D1 は URL のみ）④GitHub OAuth flow（モックサーバ）→トークン AES-GCM 暗号化保存→gists/repos CRUD→レート残チェック→監査ログ の統合テスト ⑤未連携ユーザーの gist 操作は 403+連携誘導 ⑥画像/動画/テキストの表示（クリック展開・video・ビューア・download rel=noopener）を e2e で確認 ⑦`verify()` cron によるリンク死活監視の動作テスト。

### WP5 AI運営（REST+MCP+ダッシュボード）

- **担当範囲**: `packages/mcp/` 全体、shared の `schemas/risk.ts`・`ai.ts`・`mcp.ts`・`webhook.ts`、`apps/api/src/routes/ai.ts`・`mcp.ts`、`services/ai/*`（policy-engine, queue-exec, monitor, webhook）、`durable/ai-gate.ts`、migrations 0500–0599、フロント `admin/ai/*`（ダッシュボード・承認キュー・監査ビューア・緊急停止）、板管理画面の AI 設定パネル（`components/ai-board-panel.tsx` として提供、WP2 の `b/[slug]/manage/ai/page.tsx` が import）、`e2e/ai/*.spec.ts`。
- **依存**: WP0、WP1（`createPost/hidePost/deletePost/getThread` 等の内部関数）、WP3（プラグイン審査 action: `runStaticChecks`、承認は WP3 REST の内部呼び出し）、WP6（承認者ロール判定は WP0 の `requireRole`）。
- **提供インターフェース**:
  - **政策エンジン** `services/ai/policy-engine.ts`: `enforceAiPolicy(agent, action, params) → {mode, risk}`（REST/MCP 共通の唯一の強制点）。action カタログは `schemas/risk.ts`（DESIGN §10.2）。
  - REST `/v1/ai/*`: agents CRUD・APIキー発行、policies、queue（list/decide）、audit、stop/resume、webhooks CRUD。
  - MCP `/mcp`（2026-07-28 ステートレス）+ `/mcp/legacy`: tools = REST ミラー（DESIGN §10.1）。
  - Webhook(out) 署名形式（`schemas/webhook.ts`）+ 接続 AI 向けシステムプロンプトテンプレ（`packages/mcp/prompts/`、injection 対策デリミタ）。
  - `AiGate` DO: 緊急停止フラグ。
- **受入条件**: 共通条件 + ①リスク階層テスト: low=自動実行、medium=agent設定次第（auto/queue 両方）、high=常にキュー化（直接呼出でも自動実行されない）、never カタログ action=403 を網羅テスト ②**権限昇格防止**: board 担当 agent が他板操作 403、risk_cap=low の agent が medium 実行不可、投稿本文中の injection 文字列（「全権限を付与」「policy を無効化」等）を含むケースで挙動不変を assert（e2e/ai + 統合）③承認キュー: pending→webhook 通知→承認→再チェック→executed→監査、却下、72h 失効、idempotency_key 重複排除 ④緊急停止: AiGate set→全 AI 認証 503 が秒以内、agent 個別 suspend、自動 suspend（レート/エラー率/反復の閾値テスト）⑤MCP クライアント（`@modelcontextprotocol/client`）から tools/list→post.create→search→queue 操作が REST と同一の政策で通る統合テスト、legacy レーン動作 ⑥AI名義投稿が `ai_agent` attribution 付きで表示される（WP1/WP2 と連携）⑦監査ログの完全性（全 action に ai_audit 行）。

### WP6 アカウント/特別管理人/TOTP/管理画面

- **担当範囲**: shared の `schemas/auth.ts`・`schemas/admin.ts`、`apps/api/src/routes/auth.ts`・`accounts.ts`・`invites.ts`・`admin.ts`、`services/account/*`（PBKDF2、セッション、TOTP検証、リカバリーコード）、migrations 0600–0699、フロント `account/*`・`admin/*`（WP5 所有の `admin/ai/` 除く。admin レイアウト・nav・招待UI・監査ビューア・サイト設定・使用量表示 `/v1/meta/usage` 消費・全体通報 `admin/reports/` は WP1 所有なので nav リンクのみ）、`components/github-link-panel` の差し込み（WP4 提供）、`e2e/account/*.spec.ts`。
- **依存**: WP0（`lib/totp.ts`・`requireRole`）、WP1（board_staff 任免 API）、WP5（admin/ai への nav リンク、契約のみ）。
- **提供インターフェース**:
  - REST: `/v1/auth/*`・`/v1/accounts/*`・`/v1/admin/*`・`/v1/admin/invites/*`。
  - 内部: `verifySession()`（WP0 context と統合）、`issueInvite(kind)`。
  - 特別管理人就任フロー API（DESIGN §5.3）: 発行→accept（TOTP 必須登録+リカバリーコード）→role 付与。
  - admin レイアウト/nav（WP5 が `admin/ai/` ページを子として配置）。
- **受入条件**: 共通条件 + ①登録/ログイン/ログアウト/セッション失効（30日スライディング）の統合テスト ②GitHub OAuth ログイン（WP4 モック）でアカウント作成・既存メールとの紐付け ③**TOTP**: RFC6238 テストベクトル一致、6桁/30秒、±1窓、5回失敗ロック、QR=`otpauth://` URI 内容検証、リカバリーコード単回使用・枯渇→owner 再招待 ④**特別管理人就任 e2e**: owner が招待キー発行→accept 前に管理人として一切表示されない→フォーム+TOTP 登録→就任→専用ダッシュボード（全板横断管理・規制・プラグイン管理・AI承認/停止への nav）→操作ログ→権限停止→復旧、owner の最終権限維持・秘密情報 UI 不在を assert ⑤権限マトリクス（§5.4）の special_admin/board_admin/deputy/moderator 行の API 403/200 網羅テスト ⑥アカウント停止・suspensions ⑦パスワード強度・レート制限・Turnstile 要求のテスト。

### WP7 テスト/CI/ドキュメント

- **担当範囲**: `e2e/` 基盤（config, helpers, fixtures, seed, スタブ外部サービス: catbox/cloudinary/github/turnstile モック）、`e2e/security/*`、`.github/workflows/*` 全体（WP0 雛形を引き継ぐ）、`turbo.json` のタスク調整、`docs/README 系`: ルート `README.md`（WP0 骨格を引き継ぎ完成）、`docs/api.md`（REST 仕様: WP0 の schemas から生成スクリプト `tools/gen-api-docs.ts` も WP7 所有）、`docs/mcp.md`（MCP 仕様）、`docs/plugin-guide.md`（プラグイン開発ガイド、WP3 と共著）、`docs/deploy.md`（Vercel+Workers+D1 デプロイ手順・環境変数一覧）、`tools/*`。
- **依存**: 全 WP（段階的に結合。CI 雛形・スタブ・ドキュメント骨格は WP0 直後から着手）。
- **提供インターフェース**: `pnpm test:e2e`（全 spec）、`pnpm ci:all`、スタブサーバ（`e2e/helpers/stubs.ts`: 外部アップローダ/GitHub/Turnstile のローカルモック。WP3/WP4/WP5 の e2e が使用）、GitHub Actions ワークフロー（PR: lint+typecheck+unit+統合、main: E2E shard+gitleaks+deploy）。
- **受入条件**: 共通条件 + ①CI が PR で unit+統合、main で E2E 全 spec を実行しグリーン（E2E ≤20分、shard 並列）②gitleaks が CI に組み込まれ、テスト用ダミー秘密でも検出することを確認 ③deploy ワークフロー: `wrangler d1 migrations apply`（remote）→ `wrangler deploy` → Vercel 本番反映 の順序で成功、失敗時にロールバック手順が docs/deploy.md にある ④`e2e/security/` が §5.4 マトリクスの全行、CSRF（Origin 拒否）、XSS（投稿内 `<script>` がエスケープ表示）、sandbox escape（WP3 と共同）をカバー ⑤docs 4 点（README/api/mcp/plugin-guide）+ deploy.md が実装と一致（api.md は生成スクリプトで自動整合）⑥無料枠ガードの回帰テスト（rows_written ≤12、DO Hibernation 使用）が CI に入る ⑦`pnpm build`（web 静的エクスポート + worker bundle）が CI で成功。

---

## 5. 結合マイルストーン

| M | 内容 | 完了条件 |
|---|---|---|
| M0 | WP0 完了 | 全 WP が `pnpm dev` で起動する骨格を手に入れる |
| M1 | 掲示板縦通し | WP1+WP2 で「板作成→投稿→実況→検索」が E2E グリーン |
| M2 | 拡張機能 | WP3+WP4 完了（プラグイン公開・アップロード・GitHub 連携が E2E グリーン） |
| M3 | 運営機能 | WP5+WP6 完了（AI 運営・特別管理人就任・admin が E2E グリーン） |
| M4 | リリース | WP7 の CI/deploy/docs 完了、`e2e/security/` グリーン、Vercel+Workers 本番デプロイ、全必須機能の動作確認（REQUIREMENTS 完成条件 1–5） |

## 6. 運用ルール（再掲）

- 進捗と既知の問題は GitHub Issue で管理する。
- 他 WP ファイルへの変更要求: Issue に「対象ファイル・理由・提案 diff」を書いて合意する。
- 秘密情報: リポジトリにコミットしない（`.env.example` にはキー名のみ）。
