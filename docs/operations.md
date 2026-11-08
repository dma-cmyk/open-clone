# 運用ガイド

本番運用（無料枠）での監視・緊急停止・障害対応をまとめます。設計の正本は
[`docs/design/DESIGN.md`](design/DESIGN.md) §10・§12・§13、デプロイ手順は [`docs/deploy.md`](deploy.md)。

> **実装状況**: AI 緊急停止（`/v1/ai/stop`・`/v1/ai/resume`）と使用量 API（`/v1/meta/usage`）は実装済み。
> ルート別の実装状況は [`docs/api.md`](api.md) §3 を参照（生成物のため常に最新）。

## 1. 日常監視

### 1.1 ヘルスチェック

```sh
curl -fsS https://<api-domain>/v1/health
curl -fsS https://<web-domain>/api/v1/health   # rewrites 経由
```

`{ "ok": true, "data": { "status": "ok", ... } }` が返ること。5xx / タイムアウトは §4 へ。

### 1.2 使用量（無料枠）

```sh
curl -fsS https://<api-domain>/v1/meta/usage
```

返却されるのは `freeTierBudget`（Free 枠の定数）と `d1.counts`（accounts / sessions / audit_log の件数）のみです。
**日次の Workers リクエスト数・D1 rows read/write の実測値や 80% 自動警報は実装されていません**。
以下は Cloudflare ダッシュボード（Workers & Pages → Usage、D1 → Metrics）で手動確認する運用とします。

| 資源 | Free 上限 | 警報ライン（手動確認） | 対応 |
|---|---|---|---|
| Worker requests | 100,000 / 日 | 80,000 | キャッシュ・ポーリング間隔見直し |
| D1 rows read | 5,000,000 / 日 | 4,000,000 | 索引追加・一覧 limit 見直し |
| D1 rows written | 100,000 / 日 | 80,000 | 投稿 1 件 ≤12 行の回帰テストを確認 |
| D1 storage | **500MB / DB** | 400MB | 古い audit / 削除済み行の prune、板 archive |
| DO requests | 100,000 / 日 | 80,000 | publish 回数・WS 再接続の見直し |
| DO duration | 13,000 GB-s / 日 | 10,000 | Hibernation が有効か確認 |
| Cron | 5 個（アカウント全体） | — | 追加不可（4 枠使用 + 既存 Worker 1 枠） |

- 上限超過は**課金ではなくサービス停止**です。現在は自動通知なし。週次のダッシュボード確認を運用に組み込む
- D1 の実容量: `wrangler d1 info open-clone` / ダッシュボード

### 1.3 監査ログ

- 管理操作: `audit_log`（`/v1/admin/audit`、owner / special_admin / 板管理人は自板関連）
- AI 操作: `ai_audit`（`/v1/ai/audit`、agent は自分の分のみ）
- GitHub 操作: `github_ops_log`
- 保持期間: `site_config`（既定 365 日）。cron で掃除

### 1.4 既知の仕様（設計判断）

- **レス上限到達**: 1000 レス（スレ主は 1005）で `POST /posts` は `409 CONFLICT` を返し、以降は書き込めません。
  `threads.status` は `active` のままなので、専ブラの dat は `LIMIT 1000` で打ち切られます。
  open2ch の over1000/dat落ちに相当する状態遷移は実装していません（スレ自体は閲覧可能）。
- **compat `bbs.cgi` の Turnstile**: 専ブラは Turnstile を解けないため `skipTurnstile: true` で書き込みます。
  そのため一般 HTTP クライアントがフォームを模倣すると Turnstile を迂回できます。最終防衛は RateLimiter DO
  （device/IP 窓）とアク禁です。compat 経路を公開する場合は、この前提でレート制限値と監視を調整してください。

## 2. 緊急停止

### 2.1 AI の全停止（最優先）

AI が暴走・誤操作・侵害の疑いがある場合、**全 AI 認証を即時 503** にします。

```sh
# owner / special_admin（step-up は /stop では要求しない。停止は fail-closed のため即時許可）
curl -X POST https://<api-domain>/v1/ai/stop \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -b 'oc_sess=<session>' \
  -d '{"scope":"global","reason":"異常な一括削除を検知"}'
```

- `AiGate` Durable Object のフラグを set。以降の AI リクエストは `503 AI_STOPPED`
- 反映は秒以内（DO 読取 1 回）
- 解除は owner / special_admin のみ（`POST /v1/ai/resume` `{"scope":"global"}`）。**AI 自身は解除できない**（never action）
- 停止・解除は監査に記録。板単位は `{"scope":"board","boardId":N}`、agent 単位は `{"scope":"agent","agentId":"..."}`
  （board_admin は自板の `scope:"board"` のみ実行可能）

### 2.2 個別 agent / 板の停止

```sh
# agent 単位（agent を停止状態にする。再開は /agents/<id>/resume）
curl -X POST https://<api-domain>/v1/ai/agents/<id>/suspend \
  -H 'Origin: https://<web-domain>' -b 'oc_sess=<session>'

# 板単位の AI 停止（設計の /boards/:id/stop は未実装。現状は scope=board の /stop を使う）
curl -X POST https://<api-domain>/v1/ai/stop \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' -b 'oc_sess=<session>' \
  -d '{"scope":"board","boardId":12,"reason":"板内の誤削除が多発"}'
```

### 2.3 プラグインの停止（kill）

```sh
curl -X POST https://<api-domain>/v1/plugins/<id>/disable \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -b 'oc_sess=<session>' \
  -d '{"reason":"悪意あるコードの通報"}'
```

- 配信を停止し、既存インストールへ `kill` イベントを送信（iframe 即時停止）
- サイト全体のプラグインは owner / special_admin、板導入分は板管理人

### 2.4 アカウント停止

```sh
curl -X POST https://<api-domain>/v1/admin/suspensions \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -b 'oc_sess=<session>' \
  -d '{"accountId":"01J...","scope":"site","reason":"スパム","durationHours":168}'
```

- `scope`: `site` / `board`（board は `boardId` 必須）。対象は `accountId` / `email` / `deviceHash` のいずれか
- 期限は `durationHours` または `expiresAt`（Unix 秒）。省略は無期限
- owner / special_admin のみ。**step-up（TOTP 再認証）必須**
- 解除: `POST /v1/admin/suspensions/:id/lift`（同じく step-up 必須）

## 3. 定期実行（Cron）

`apps/api/wrangler.toml` の 4 枠。**Free プランの cron 上限はアカウント全体で 5 枠**で、
既存 Worker が 1 枠使っているため 4 枠に統合しています（毎時の 2 本を 1 本の式にまとめている）:

| cron | 内容 | 担当 |
|---|---|---|
| `*/10 * * * *` | 監視・異常検知・警報 | WP5 |
| `5,20 * * * *` | 毎時 :05 ランキング snapshot / :20 webhook 再送・ログ掃除 | WP1 / WP5 |
| `15 3 * * *` | 板の自動削除 / prune | WP1 |
| `*/30 * * * *` | 添付リンク死活監視 | WP4 |

- 統合した式は `apps/api/src/cron.ts` が発火時刻の分（:05 / :20）で振り分ける
- ローカルで手動実行: `curl "http://localhost:8787/cdn-cgi/local/scheduled"`
- 追加は不可（アカウント全体の 5 枠を使い切っている）。必要なら既存の割当を設計変更

## 4. 障害対応プレイブック

### 4.1 API が 5xx を返す

1. `curl -i https://<api-domain>/v1/health` で status / body を確認
2. Cloudflare ダッシュボード → Workers → `open-clone-api` → Logs（`wrangler tail` でも可）
3. 直近のデプロイが原因なら [`docs/deploy.md`](deploy.md) §7 のロールバック
4. D1 エラー（`D1_ERROR`）なら migrations の適用漏れを確認:
   `wrangler d1 migrations list open-clone --remote`
5. 秘密の欠落（`MISCONFIGURED`）なら `wrangler secret list` と値を確認

### 4.2 ログインできない / セッションが切れる

- Cookie は `HttpOnly; Secure; SameSite=Lax`。**HTTPS 必須**（localhost 以外）
- 直接モード（別オリジン API）ではサードパーティ Cookie 制限の影響を受ける。既定の rewrites プロキシモードを使う
- TOTP ロック（5 回失敗 / 15 分）は `429 TOTP_LOCKED`。待機またはリカバリーコード
- セッションは 30 日スライディング。失効時は再ログイン

### 4.3 投稿できない（429 / 403）

| エラー | 原因 | 対応 |
|---|---|---|
| `429 RATE_LIMITED` | 連投制限（投稿 30 秒 3 回など） | 待機。板設定の cooldown を確認 |
| `403 BANNED` | 板アク禁 / スレ内 `!aku` | 解除は板管理人。異議は通報経由 |
| `400 TURNSTILE_FAILED` | Turnstile トークン不正・期限切れ | 再読み込み。サイトキー/secret の一致を確認 |
| `403 BAD_ORIGIN` | Origin が許可リスト外 | `ALLOWED_ORIGINS` を確認 |

### 4.4 添付アップロードが失敗する

- **Catbox 障害**: 板設定で Cloudinary へ切替（画像のみ・10MB まで）。`uploader_adapters` と板設定を確認
- **Cloudinary クレジット切れ**: 25 credits/月。Catbox へ戻すか、当月の利用を停止
- **GitHub レート制限**: authenticated 5,000 req/h。`/v1/github/files/rate` で残量確認、待機
- **`400 TURNSTILE_FAILED`（アップロード）**: アップロードの要否は投稿と同じ板設定 `turnstile`（off / anonymous / always）とログイン状態で決まる。板 ID を伴わないアップロードだけサイト設定 `uploader.require_turnstile`（既定 true）に従う。板設定が off なら匿名でもウィジェットなしで通る
- リンク切れは `*/30` の cron が検知。`attachments` の状態を確認

### 4.5 Turnstile が全滅する

- Cloudflare の Turnstile 障害時は、板設定 `default_turnstile_required=false` で一時的に要求を外す（スパム増加に注意）
- secret / site key の不一致、ドメイン未登録（workers.dev / vercel.app）を確認
- ローカルは公式テストキー（`1x000...`）で動作

### 4.6 プラグインが暴走・情報漏えいの疑い

1. 該当プラグインを `disable`（§2.3）
2. 監査ログで `net.fetch` / `github.*` / `data.write` の呼び出し履歴を確認
3. 通報・審査キューを確認し、必要なら作者アカウントを停止
4. サンドボックスは不透明オリジンのため Cookie / 親 DOM への直接アクセスは不可。**権限宣言の範囲外呼び出しはホストが拒否**する

### 4.7 D1 容量が 80% を超えた

1. `wrangler d1 info open-clone` でサイズ確認
2. 削除済み投稿・古い audit / webhook_deliveries を prune（cron の対象を確認）
3. 板単位の archive（読み取り専用化）を検討
4. 500MB 到達時は書き込みが失敗する。恒常化するなら Paid プラン（D1 10GB）へ昇格を運営判断

## 5. バックアップ・復元

```sh
# エクスポート（remote）
wrangler d1 export open-clone --remote --output backup-$(date +%F).sql

# 復元（新しい DB に対して）
wrangler d1 execute open-clone-restore --remote --file backup-2026-11-08.sql
```

- D1 の Time Travel（30 日）も利用可能: `wrangler d1 time-travel restore open-clone --timestamp=<unix>`
- 添付本体は外部サービス（Catbox / Cloudinary / Gist）にあり、D1 には URL のみ。**Cloudflare 側のバックアップ対象外**
- 秘密情報は Wrangler secrets / Vercel env。リポジトリに置かない

## 6. 定期メンテナンス

- 依存更新: `pnpm update` → `pnpm -r typecheck && pnpm -r test` → E2E
- 秘密ローテーション: `ID_SALT` は表示 ID が変わるため計画的に。`ENC_KEY` は既存暗号文の再暗号化が必要（要確認）
- `OWNER_BOOTSTRAP_KEY` は初回セットアップ後にローテーション
- 監査ログの保持期間と prune の動作確認
- 無料枠の使用量レビュー（週次）

## 7. エスカレーション

| 事象 | 一次対応 | エスカレーション |
|---|---|---|
| AI の異常操作 | §2.1 全停止 | owner |
| 大規模スパム | レート制限・アク禁・アカウント停止 | owner / special_admin |
| 個人情報・違法投稿 | 非表示 → 通報処理 → 必要なら削除 | owner |
| 侵害の疑い | セッション全失効・秘密ローテーション | owner（インフラは Cloudflare 側） |
| 無料枠枯渇 | §4.7 / 使用量削減 | owner（Paid 昇格判断） |