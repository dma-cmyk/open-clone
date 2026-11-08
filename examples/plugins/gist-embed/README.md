# gist-embed（サンプル）

レスに `https://gist.github.com/<user>/<id>` が含まれる場合、`api.net.fetch`（ホストのプロキシ）で
Gist API を読み、コードブロックとして表示します。iframe から直接 fetch はできません。
`connectAllowlist` は `https://api.github.com` のみ。監査ログは `/v1/plugin-net/log`（管理者）に残ります。
