# gallery（サンプル）

スレ内レスの画像 URL を集めてサムネイル一覧（`thread-head`）にします。
`data:read:thread` でレスを取得し、`net:fetch` では **画像ホストのオリジンだけ** を allowlist に指定します
（通信はホストのプロキシ経由、iframe からの直接通信は CSP で遮断）。
