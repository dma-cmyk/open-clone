# 公式プラグインサンプル

`/plugins/new/` の「サンプルを読み込む」から同じ内容を読み込めます。各ディレクトリは
`manifest.json` + `plugin.js` の 1 ファイル構成です。

| プラグイン | 権限 | 内容 |
|---|---|---|
| `spoiler` | なし | `[spoiler]` をネタバレ表示（宣言的レンダー規則のみ） |
| `dice` | `ui:slot` | レスごとのサイコロボタン |
| `gallery` | `ui:slot`, `data:read:thread`, `net:fetch` | 画像 URL のサムネイル一覧 |
| `gist-embed` | `ui:slot`, `net:fetch` | Gist URL をコード表示（プロキシ経由） |

使い方:

1. サイトの `/plugins/new/` でサンプルを読み込み、内容を確認して保存。
2. 公開申請（`personal` のみなら即時公開、`site` を含むと審査キュー）。
3. 個人用 / 板用 / サイト全体にインストール。
4. スレ画面（WP2）または `/plugins/demo/` で表示を確認。

サンドボックスの制約（`document.cookie` 不可・親 DOM 不可・直接 fetch 不可・storage は 64KB）は
`packages/plugin-sdk/README.md` を参照してください。
