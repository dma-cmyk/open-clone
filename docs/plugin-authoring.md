# プラグイン作成ガイド（個人用トークン + `/mcp-plugin`）

おーぷんクローンでは、利用者自身の AI（Claude Code など）に **自分のプラグインを作らせる**ための
個人用トークンと、専用の MCP レーン `/mcp-plugin` を提供します。

- 人間が発行するトークン: `ocp_` + 43 文字（256 bit 乱数）。**発行応答で 1 回だけ**表示
- MCP エンドポイント: `https://<api-domain>/mcp-plugin`（MCP 2026-07-28 ステートレス）/
  `https://<api-domain>/mcp-plugin/legacy`（2025 世代互換）
- 認証: `Authorization: Bearer ocp_...`
- 実装: `apps/api/src/routes/mcp-plugin.ts`、`apps/api/src/routes/plugin-tokens.ts`、
  `apps/api/src/services/plugin-authoring/*`、契約スキーマは
  `packages/shared/src/schemas/plugin-authoring.ts`
- 画面: `/account/plugin-tokens`（発行・一覧・失効・接続手順）

> **AI 運営の API キー（`ocai_`）とは別物です。** `/mcp-plugin` は `ocai_` を受け付けず、
> `/mcp` は `ocp_` を受け付けません（接頭辞で相互拒否）。トークンは掲示板の投稿・管理・審査には使えません。

## 1. トークンを発行する

1. `/account/plugin-tokens` を開く（ログインと TOTP の設定が必要）
2. 識別名（任意・100 文字まで。例「自宅の Claude Code」）を入れて **発行する**
3. TOTP の再認証（step-up）を求められたらコードを入力する
4. 表示された `ocp_...` を**その場でコピー**する。**再表示はできません**

| 項目 | 値 |
|---|---|
| 有効期限 | 発行から 90 日（延長は再発行） |
| 同時有効本数 | 5 本 |
| 表示 | 一覧は `ocp_xxxxxxxx`（prefix）・識別名・作成日・期限・最終使用のみ |
| 保存 | DB には SHA-256 ハッシュのみ（平文は保存しない） |
| 失効 | 画面の「失効」（個別）/「すべて失効」（step-up 必須） |
| アカウント停止 | 停止中は全トークンが即時拒否（403） |

## 2. 接続する

画面の「接続手順」タブに、`NEXT_PUBLIC_API_ORIGIN`（未設定時は `apps/web/vercel.json` の
プロキシ先）を使った実際の URL が表示されます。

### Claude Code

```sh
claude mcp add --transport http open-clone-plugins \
  https://<api-domain>/mcp-plugin/legacy \
  --header "Authorization: Bearer ocp_xxxxxxxx"
```

2026-07-28 対応のクライアントなら `/mcp-plugin`（末尾の `/legacy` を外す）を使えます。

### 汎用の MCP クライアント（Bearer ヘッダーを設定できるもの）

```json
{
  "mcpServers": {
    "open-clone-plugins": {
      "type": "http",
      "url": "https://<api-domain>/mcp-plugin/legacy",
      "headers": {
        "Authorization": "Bearer ocp_xxxxxxxx"
      }
    }
  }
}
```

### ChatGPT

**現在は未対応です。** ChatGPT のカスタムコネクタで Bearer ヘッダーによる MCP 認証が使えることを
確認できていないため、接続手順は案内していません。Bearer ヘッダーを設定できる MCP クライアントを
利用してください。

### 動作確認

接続後に AI へ「テンプレート一覧を見せて」（`authoring.list_templates`）と伝え、一覧が返れば成功です。

| 応答 | 意味 |
|---|---|
| 401 | トークンの値が違う / 失効済み / 期限切れ |
| 403 | Origin が許可されていない、またはアカウント停止中 |
| 429 | 回数の上限（30 回/分・日次上限） |

### Origin（CSRF ガード）との関係

ブラウザ以外の MCP クライアントは `Origin` ヘッダーを送りません。API の `originGuard` は
**`Authorization: Bearer` があり、セッション Cookie を使わず、パスが `/mcp`・`/mcp/legacy`・
`/mcp-plugin`・`/mcp-plugin/legacy` に完全一致する場合だけ** Origin なしを許可します
（報告書29 決定1）。Origin が付いている場合は従来どおり許可リスト（`ALLOWED_ORIGINS`）と照合し、
不許可は 403 です。Cookie 認証の REST（`/v1/*`）には緩和を入れていません。

## 3. ツール一覧（`authoring.*` の 9 本）

`/mcp-plugin` は下記の 9 本だけを公開します。投稿・審査・管理のツールは登録されません。
入出力は `packages/shared/src/schemas/plugin-authoring.ts` の strict schema が正本です。

| ツール | 入力 | 出力（概要） | 危険度 |
|---|---|---|---|
| `authoring.list_templates` | なし | `{ templates: [{ id, label, description, parameters, baseManifest }] }` | low |
| `authoring.create_draft` | `{ manifest, code, changelog?, visibility?, templateId? }` | `{ pluginId, name, version, checks, warnings }` | medium |
| `authoring.add_version` | `{ pluginId, version?, manifest?, code, changelog?, templateId? }` | `{ pluginId, version, checks, warnings }` | medium |
| `authoring.check` | `{ code, manifest? }` | `{ checks: { allowed, reasons, riskScore }, warnings }`（保存しない） | low |
| `authoring.preview` | `{ pluginId }` | `{ manifest, checks, warnings, regex[], versions[], reviews[], previewUrl }` | low |
| `authoring.publish` | `{ pluginId, scopes[], visibility? }` | `{ status, needsReview, reviewId?, message?, checks }` | high（site 含む） |
| `authoring.install_self` | `{ pluginId, version?, pinned?, uninstall? }` | `{ scope: "personal", installed, uninstalled, version?, pinned }` | medium |
| `authoring.get` | `{ pluginId }` | `{ plugin: { …, manifest }, versions[], reviews[] }` | low |
| `authoring.list` | `{ limit?, cursor?, status?, q? }` | `{ plugins[], nextCursor? }` | low |

- `code` は **64KB** まで（既存 REST の 512KB より厳しい上限）。
- すべてのツールで「**トークン所有者 = プラグイン所有者**」を DB で確認し、他人のプラグインは
  **404**（存在を隠す）。サイト管理者バイパスはありません。
- `create_draft` / `add_version` / `publish` は保存前に `runStaticChecks` を必ず通し、
  不合格なら 400（`details.reasons`）で拒否します。
- `publish` で `site` スコープを含めると、既存の `plugin_reviews` に **pending** が作られて止まります。
  トークンから審査を承認する手段はありません（承認は owner / 特別管理人の人間セッションのみ）。
- `install_self` の導入先は常に **personal（トークン所有者）** です。`scope` キーは strict schema が拒否します。
- `templateId` を指定すると、changelog の先頭に `[template:<id>]` が付記されます（新カラムは作りません）。

### `authoring.preview` が返すもの / 返さないもの

- 返す: 静的検査結果、権限警告、正規化済み manifest、render 規則の安全性（`analyzeRegexPattern`）、
  版・審査状態、**ブラウザ確認用 URL**（`/plugins/new?id=<pluginId>`）
- 返さない: 実際の描画結果。プラグインの実行はブラウザの sandbox iframe 前提で、Workers では実行しません
  （報告書29 決定2）。

## 4. 上限と監査

| 上限 | 値 |
|---|---|
| 分窓 | 30 回/分（トークン単位） |
| 日次・下書き作成 | 10 回/日 |
| 日次・版追加 | 60 回/日 |
| 日次・静的検査（check/preview） | 120 回/日 |
| 日次・公開申請 | 20 回/日 |
| 下書き保有数 | 50 件 |
| コードサイズ | 64KB |

上限超過は `429 RATE_LIMITED`（`retryAfterSeconds` 付き）です。日次カウンタ（UTC 日）は
`plugin_author_usage`、呼び出し監査は `plugin_author_audit` に保存します。監査には
`params_digest`（SHA-256）と先頭 200 文字の要約のみを残し、**コード全文は保存しません**
（正本は `plugin_versions`）。usage は 8 日、監査は 90 日で、既存の毎時 :20 cron が掃除します
（新規 cron は増やしません）。

## 5. AI が作った下書きの確認

外部 AI が作成した下書きは `/plugins/?tab=mine`（「自分のプラグイン」タブ）に表示されます。

1. `/plugins/view/?id=<id>` でコード・manifest・版を確認
2. 「静的検査を再実行」で保存済みコードを再検査（`POST /v1/plugins/preview-check`）
3. 「プレビュー（sandbox）」でブラウザ上の sandbox iframe プレビューを開く
4. 「個人用にインストール」「公開申請」を実行する（site は審査待ち）

## 6. 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_API_ORIGIN` | `https://open-clone-api.dma-cmyk.workers.dev`（`apps/web/vercel.json` のプロキシ先と同じ） | `/account/plugin-tokens` の接続手順に表示する API オリジン |

Vercel の環境変数にも同じ値を設定してください（未設定でも既定値で動作します）。

## 7. 注意事項

- トークンはパスワードと同じです。AI の設定ファイルやチャットに貼らず、信頼できるツールにだけ設定してください。
- 漏洩が疑われる場合は、`/account/plugin-tokens` で即時失効してください（パスワード変更では失効しません）。
- トークンでできるのは「自分のプラグインの作成〜個人導入」までです。投稿・板/サイトへの導入・審査・
  他人のプラグイン操作はできません。
- `render.post` の規則は閲覧者のブラウザで実行されます。2,048 文字を超える本文には適用されません（既知の制約 L-4）。