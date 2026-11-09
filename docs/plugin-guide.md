# プラグイン開発ガイド

おーぷんクローンのプラグインは、**ブラウザ内のサンドボックス iframe** で動作する JavaScript です。
サーバー側（Workers）でユーザーコードを実行することはありません（DESIGN §15-1 の制約）。

- 共有スキーマ: `packages/shared/src/schemas/plugin.ts`（manifest / 権限 / RPC / REST 入力）
- SDK: `packages/plugin-sdk`（`definePlugin()` と `PluginApi` 型）
- ホスト: `apps/web/src/features/plugin-host/*`（`<PluginSlot>` / iframe ランナー / bridge / CSP / プレビュー）
- API: `/v1/plugins/*`（[`docs/api.md`](api.md) §3 で実装状況を確認）
- 公式サンプル: `examples/plugins/`（spoiler / dice / gallery / gist-embed）

> **実装状況**: `ai.complete` / `github.*` / `upload.start` はホスト側で実装済みです。
> - `ai.complete`: サイト管理者が接続先（`plugin.ai.baseUrl` / `plugin.ai.model`）と Worker secret
>   `PLUGIN_AI_API_KEY` を設定した場合のみ動作します。未設定なら `503 AI_DISABLED`（ダミー応答は返しません）。
>   利用者への同意確認・レート制限（10 回/分）・日次上限（100 回/端末・プラグイン）・監査ログがあります。
> - `upload.start`: ホストがアップロードダイアログを開き、完了後に `{ started: true, url }` を返します。
> - `github.*`: 閲覧者が GitHub 連携済みの場合のみ、本人リソースを操作します。
>
> 実際に受け付けるメソッドは `PLUGIN_RPC_PERMISSIONS`（shared）と
> `apps/web/src/features/plugin-host/bridge.ts` を正としてください。

## 1. 実行モデル

```text
┌──────────────────────── web (site origin) ────────────────────────┐
│ <PluginSlot name="...">                                            │
│   └─ <iframe sandbox="allow-scripts" srcdoc="...">  ← 不透明オリジン │
│        ・Cookie / localStorage / 親 DOM にアクセス不可              │
│        ・CSP <meta>: default-src 'none'; script-src 'unsafe-inline' │
│        ・postMessage(JSON-RPC 風) ⇄ host bridge                    │
│   host bridge: 権限チェック + 監査 + API 呼び出し                   │
└────────────────────────────────────────────────────────────────────┘
```

- iframe は `sandbox="allow-scripts"` のみ。**`allow-same-origin` は付けない**
- プラグインから親 DOM を直接操作することはできない。UI は iframe 内に描画し、ホストがスロットに配置する
- ホストとの通信は `{ v: 1, id, method, params }` の JSON-RPC 風エンベロープ（`pluginRpcRequestSchema`）
- ハンドシェイクで nonce を交換し、ホストは `event.source === iframe.contentWindow` を検証する
- 宣言的レンダー規則（regex → template）はホストが実行する。テンプレートへ埋め込むキャプチャ値は**ホストが HTML エスケープ**する

## 2. manifest

`manifest.json`（または API の `manifest` フィールド）。`pluginManifestSchema` で検証されます。

```json
{
  "name": "example-plugin",
  "version": "1.0.0",
  "summary": "スレッドに動作確認ボタンを追加する例",
  "description": "任意。20,000 文字まで",
  "scope": ["personal", "board"],
  "permissions": ["ui:slot", "data:read:thread"],
  "connectAllowlist": [],
  "entry": "plugin.js",
  "slots": ["post-form-after"],
  "hooks": ["beforePost"],
  "render": {
    "post": [
      {
        "pattern": "\\|\\|(.+?)\\|\\|",
        "flags": "g",
        "template": "<span class=\"spoiler\">$1</span>",
        "kind": "spoiler"
      }
    ]
  },
  "author": "your-name",
  "license": "MIT",
  "homepage": "https://example.com/plugin"
}
```

| フィールド | 必須 | 制約 |
|---|---|---|
| `name` | ✓ | 英小文字始まり、英小文字/数字/ハイフン 3〜41 文字（レジストリ slug） |
| `version` | ✓ | semver（例 `1.0.0`） |
| `summary` | ✓ | 1〜200 文字 |
| `description` | | 最大 20,000 文字 |
| `scope` | ✓ | `personal` / `board` / `site` の配列（1〜3） |
| `permissions` | | 下記の権限。未宣言の RPC はホストが拒否 |
| `connectAllowlist` | `net:fetch` 時 ✓ | `https://host` 形式のオリジンのみ。最大 20。`net:fetch` が無い場合は指定不可 |
| `entry` | | エントリファイル名（既定 `plugin.js`）。単一 bundle |
| `slots` | `ui:slot` 時 ✓ | 下記スロット。最大 8 |
| `hooks` | | `beforePost` / `onPostRendered`。最大 4 |
| `render.post` | | 宣言的レンダー規則。最大 20 |
| `author` / `license` / `homepage` | | 任意 |

### コードサイズ

- プラグインコード: **512KB** まで（`PLUGIN_CODE_MAX_BYTES`）
- `storage:shared` の共有 KV: **64KB** まで（`PLUGIN_STATE_MAX_BYTES`）

## 3. 権限

`PLUGIN_PERMISSIONS` / `PLUGIN_PERMISSION_RISK`（`packages/shared/src/schemas/plugin.ts`）。

| 権限 | 内容 | 審査レベル |
|---|---|---|
| `ui:slot` | スロットへの UI 描画 | 低 |
| `data:read:thread` | スレッド・レスの閲覧（閲覧者の権限で実行） | 低 |
| `data:read:board` | 板情報の閲覧 | 低 |
| `data:write:post` | 投稿（**閲覧者本人の操作として**。確認 UI を出せる） | 中 |
| `storage:shared` | `plugin_state` の共有 KV（板/サイト単位） | 低 |
| `net:fetch` | ホストプロキシ経由の外部 fetch（allowlist + 監査） | 中 |
| `upload:start` | アップローダ起動 | 中 |
| `github:gist` / `github:repo` | 閲覧者が GitHub 連携済みの場合のみ、本人リソースを操作（都度同意） | 高 |
| `events:subscribe` | 現在のスレ/板のリアルタイムイベント購読 | 低 |
| `notify` | トースト等の通知 | 低 |
| `ai:complete` | ホスト経由の AI 補完（レート制限・監査付き） | 中 |

- manifest の最大リスクがそのまま公開時の審査レベルになります（`manifestRiskLevel()`）
- 板公開は板管理人審査、サイト公開は**承認キュー（人間承認）必須**

### RPC と権限

`PLUGIN_RPC_PERMISSIONS` がメソッド→権限の対応表です。主なもの:

| メソッド | 必要権限 |
|---|---|
| `handshake` / `ui.resize` / `ui.setTitle` / `log` | 不要 |
| `storage.get/set/delete/list` | `storage:shared` |
| `data.thread.get` / `data.posts.list` | `data:read:thread` |
| `data.board.get` | `data:read:board` |
| `data.post.create` | `data:write:post` |
| `events.subscribe` | `events:subscribe` |
| `upload.start` | `upload:start` |
| `github.gist` / `github.repo` | `github:gist` / `github:repo` |
| `notify` | `notify` |
| `ai.complete` | `ai:complete` |
| `net.fetch` | `net:fetch` |

未知のメソッドはホストが拒否します。`net.fetch` は `connectAllowlist` 外へ転送せず、全リクエストを監査に記録します。

### AI 連携（`ai:complete`）

- フロー: `api.ai.complete(prompt, { system?, maxTokens? })` → ホストが利用者へ同意確認 → `POST /v1/ai/complete`
- サーバは manifest の `ai:complete`、導入スコープ（personal / board / site）、
  実装済み版の manifest を照合してから、サイト設定の OpenAI 互換 API へ中継します
- 接続先が未設定なら **`503 AI_DISABLED`**。プラグイン側で握りつぶさず、UI に「AI 連携は現在無効」と表示してください
- 上限: 10 回/分（端末×プラグイン）、100 回/日（端末×プラグイン）、プロンプト 4,000 文字、system 2,000 文字、
  `maxTokens` 512、応答 8,000 文字。超過は `429 RATE_LIMITED` / `400 VALIDATION` / `502 BAD_GATEWAY`
- 監査: `plugin_ai_log` にプラグイン・版・スコープ・呼び出し元端末/アカウント・文字数・モデル・結果を記録
  （プロンプト本文は保存しません）

### アップローダ（`upload.start`）

- フロー: `api.upload.start()` → ホストがアップロードダイアログを表示 → 利用者がファイルを選択 →
  WP4 のアップローダで送信 → `{ started: true, url }` を返す
- キャンセル時は `{ started: false }`。URL は投稿への添付（`data.post.create` の `attachments`）に使えます
- ファイル本体は Cloudflare に保存されません（外部保存先の URL のみ）

## 4. SDK

`packages/plugin-sdk` が `definePlugin()` と `PluginApi` 型を提供します（型は `shared` の manifest スキーマを再エクスポート）。

```ts
import { definePlugin } from "plugin-sdk";

export default definePlugin({
  // 開発時のみ。ホストは D1 に保存された manifest を正とする。
  manifest: {
    name: "example-plugin",
    version: "1.0.0",
    summary: "例",
    scope: ["personal"],
    permissions: ["ui:slot", "data:read:thread", "notify"],
    slots: ["post-form-after"],
  },
  activate(api) {
    api.log("activated", api.plugin.id, api.context.path);
  },
  slots: {
    "post-form-after": async ({ root, api }) => {
      const button = root.ownerDocument.createElement("button");
      button.textContent = "動作確認";
      button.addEventListener("click", async () => {
        const thread = await api.data.thread();
        await api.notify.show(`レス数: ${thread?.postCount ?? 0}`);
      });
      root.append(button);
    },
  },
  hooks: {
    beforePost(draft) {
      // 本文はプレーンテキスト。返した patch が下書きへ適用される。
      return draft.body.includes("NG") ? { body: draft.body.replaceAll("NG", "**") } : undefined;
    },
  },
  onKill(reason) {
    // ホストが配信停止したとき（kill イベント）
    console.warn("killed", reason);
  },
});
```

`PluginApi` の名前空間（`packages/plugin-sdk/src/types.ts`）:

| 名前空間 | メソッド | 必要権限 |
|---|---|---|
| `api.ui` | `resize(height)` / `setTitle(title)` | 不要 |
| `api.data` | `thread(threadId?)` / `board({slug?, boardId?})` / `posts(threadId)` / `createPost(draft)` | `data:read:thread` / `data:read:board` / `data:write:post` |
| `api.storage` | `get` / `set` / `delete` / `list` | `storage:shared` |
| `api.net` | `fetch({url, method, headers, body})` | `net:fetch` |
| `api.upload` | `start(options?)` | `upload:start` |
| `api.github` | `createGist(input)` / `pushFile(input)` | `github:gist` / `github:repo` |
| `api.events` | `subscribe(topics)` | `events:subscribe` |
| `api.notify` | `show(message, options?)` | `notify` |
| `api.ai` | `complete(prompt, options?)` | `ai:complete` |
| `api.log` | ホストのデバッグログへ出力 | 不要 |

- `api.context` に `pluginId` / `version` / `scope` / `boardId` / `threadId` / `path` / `account` / `theme` が入ります
- 未宣言の権限を使う呼び出しは `PERMISSION_DENIED` で失敗します（握りつぶさずに UI へ出す）

## 5. スロットとフック

### スロット（`PLUGIN_SLOTS`）

WP3 の汎用名:

| スロット | 位置 |
|---|---|
| `thread-head` | スレ画面上部 |
| `thread-post-inline` | 各レス内 |
| `thread-post-footer` | 各レス下部 |
| `post-form-after` | 投稿フォーム直下 |
| `board-head` | 板画面上部 |
| `sidebar` | サイドバー |
| `plugin-page` | プラグイン専用ページ |

WP2 の `components/plugin-slot.tsx` が提供する互換名（同じ集合に含まれる）:
`site-header` / `site-top` / `board-top` / `board-sidebar` / `thread-top` / `thread-nav` /
`post-form-extra` / `thread-bottom` / `board-manage` / `post-actions`。

実際に描画されるスロットは配置先ページの実装に依存します（`<PluginSlot name="..." />` が置かれた箇所のみ）。

### フック（`PLUGIN_HOOKS`）

- `beforePost`: 投稿前（閲覧者の確認 UI を挟める）
- `onPostRendered`: レス描画後

### 宣言的レンダー（`render.post`）

正規表現 → テンプレートの置換を**ホスト**が実行します。プラグイン JS は不要です。
`$1`〜`$9` はキャプチャ値に置換され、**必ず HTML エスケープ**されます。

```json
{
  "pattern": "\\|\\|(.+?)\\|\\|",
  "flags": "g",
  "template": "<span class=\"spoiler\">$1</span>",
  "kind": "spoiler"
}
```

`kind`: `spoiler` / `dice` / `link` / `image` / `text`。

#### 正規表現の制限（ReDoS 対策）

レンダー規則は**閲覧者のブラウザ**で実行されるため、破滅的バックトラック（ReDoS）を起こす
正規表現は作成時に拒否されます。公開申請・版の追加・審査（静的検査）とサーバー側の manifest
検証の両方で、`shared` の `analyzeRegexPattern` による同じ判定を行います。

拒否される形:

- 入れ子の量指定子: `(a+)+`、`(a*)*`、`(a?){2,}` など、繰り返すグループの末尾が可変長
- 空文字に一致し得るグループの繰り返し: `(a*)+`、`(a|)+`
- 重なる選択肢の繰り返し: `(a|aa)+`、`(a|a)+`、`(\d|\w)+`
- 可変長の要素を含む並びの繰り返し: `(a+[ab])+`、`(\w+a)+`、`(\d+\.)+` など
  （2 要素以上の並びのいずれかが可変長なら拒否。固定長だけの `(abc)+` は許可）
- 後方参照: `\1`、`\k<name>`
- 過大な長さ（200 文字超）・過大な繰り返し回数（`{m,n}` の 1000 超）

公式サンプルの `\[spoiler\]([\s\S]*?)\[/spoiler\]` は通ります。疑わしきは拒否する
（安全側に倒す）判定のため、`(ab?)+` のような一部の安全な形も拒否されます。分割できる
規則に書き換えてください。

ブラウザ側でも実行時の保険があります。1 規則あたりのマッチ数は 500、経過時間は 50ms を上限とし、
超えた規則はそのページ以降無効化します（静的判定をすり抜けた場合の最終防御）。本文が
10,000 文字を超える場合は規則を適用しません（通常の投稿上限は 4,096 バイト）。

## 6. ライフサイクル

```text
作成 (/plugins/new) → 保存 (private) → プレビュー実行
 → 公開申請 (publish)
     personal: 審査不要
     board:    板管理人が承認
     site:     承認キュー（owner / special_admin / AI 提案 → 人間承認）
 → インストール (personal / board / site)
 → 更新（semver。pinned で自動追随を停止）
 → 通報 → 審査 → 停止（status=disabled、配信停止 + 既存インストールへ kill イベント）
```

### API（抜粋）

| メソッド | パス | 用途 |
|---|---|---|
| `POST` | `/v1/plugins` | 作成（最初の版） |
| `POST` | `/v1/plugins/:id/versions` | 版の追加 |
| `POST` | `/v1/plugins/:id/publish` | 公開申請（scope / visibility） |
| `GET` | `/v1/plugins` | 検索・一覧 |
| `GET` | `/v1/plugins/:id` | 詳細 |
| `GET` | `/v1/plugins/:id/code?version=` | コード配信（バージョン不変キャッシュ） |
| `POST` | `/v1/plugins/:id/install` | 導入（scope / boardId / version / pinned） |
| `POST` | `/v1/plugins/:id/update` | 更新 |
| `POST` | `/v1/plugins/:id/uninstall` | 解除 |
| `POST` | `/v1/plugins/:id/report` | 通報 |

入力スキーマは `pluginCreateSchema` / `pluginVersionCreateSchema` / `pluginPublishSchema` /
`pluginInstallSchema` / `pluginUpdateSchema` / `pluginUninstallSchema`。

### 作成例

```sh
curl -X POST https://<api-domain>/v1/plugins \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://<web-domain>' \
  -b 'oc_sess=<session>' \
  -d '{
    "manifest": {
      "name": "hello-plugin",
      "version": "1.0.0",
      "summary": "挨拶を表示する",
      "scope": ["personal"],
      "permissions": ["ui:slot"],
      "slots": ["sidebar"]
    },
    "code": "// plugin.js\nconsole.log(\"hello\");\n",
    "visibility": "private"
  }'
```

## 7. GitHub での配布・取り込み（任意）

- **GitHub 連携なしでも完結**: コードは D1 に保存され、レジストリ検索・導入・更新がサイト内で機能します
- 連携時: Gist / リポジトリへ発行（`source_ref` を記録）、webhook `/v1/plugins/hooks/github` で更新検知
- GitHub はメディア CDN ではありません。プラグインのコード配布のみを想定（容量・レート制限を遵守）
- 未連携ユーザーの Gist 操作は `403` + 連携誘導（WP4）

## 8. 審査・通報・停止

- **静的検査**（`runStaticChecks`）: 禁止パターン、巨大ループ、remote eval、manifest とコードの不整合
- **AI 審査**: サイト公開は high リスク → 承認キュー → 人間が原文を確認して承認
- **通報理由**: `malicious` / `spam` / `broken` / `inappropriate` / `other`
- 停止時は配信を止め、既存インストールへ `kill` イベントを送る（iframe は即時停止）
- 監査: インストール・更新・停止・審査はすべて記録

## 9. セキュリティ上の制約（開発者が守るべきこと）

1. `document.cookie` / `localStorage` / 親 DOM にアクセスできない（不透明オリジン）
2. `net:fetch` はホストプロキシ経由。`connectAllowlist` 外は転送されない
3. 未宣言の権限を使う RPC は失敗する。エラーを握りつぶさない
4. 投稿本文を HTML として挿入しない（ホストがエスケープする）
5. ユーザー入力を `eval` / `new Function` に渡さない
6. 重い同期処理を避ける（UI スレッドをブロックしない）

## 10. ローカル開発

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm --filter api db:migrate:local
pnpm dev            # web :3000 + api :8787（turbo）
```

- `/plugins/new` のエディタ（CodeMirror）で保存 → プレビュー（`preview=true` の sandbox iframe。API 呼び出しなし）→ 公開申請
- 公式サンプル: `examples/plugins/`（`spoiler` / `dice` / `gallery` / `gist-embed`）。各ディレクトリに `manifest.json` と `plugin.js`
- サンプルは `/plugins/new` に貼り付けるか、`POST /v1/plugins` の `manifest` + `code` に流し込んで登録します
- プラグインの E2E は `e2e/plugin/*.spec.ts`（`pnpm --filter e2e test:e2e` の一部）