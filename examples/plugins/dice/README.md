# dice（サンプル）

レス下（`thread-post-footer`）に「🎲 1d6」ボタンを表示し、`crypto.getRandomValues` で 1〜6 を出します。
`ui:slot` 権限のみ要求します。ホスト DOM には触れず、iframe 内の `root` にのみ描画します。
