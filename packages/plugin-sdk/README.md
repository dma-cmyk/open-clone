# plugin-sdk — おーぷんクローン プラグイン SDK

ユーザー製プラグインを書くための型付き API です。プラグインは **`sandbox="allow-scripts"` の iframe（不透明オリジン）** で実行され、
ホスト（掲示板の Web UI）と postMessage RPC で通信します。DOM は iframe 内だけ、外部通信は `net.fetch` プロキシ経由のみです。

## 最小例

```js
// plugin.js（単一ファイル。manifest.json とセットで保存する）
register({
  slots: {
    "thread-post-inline": ({ data, root }) => {
      // data.post.body はプレーンテキスト
      root.textContent = data.post.body;
    },
  },
});
```

`manifest.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "summary": "スレに何か表示する",
  "scope": ["personal", "board", "site"],
  "permissions": ["ui:slot"],
  "slots": ["thread-post-inline"],
  "entry": "plugin.js"
}
```

## 権限（manifest.permissions）

| 権限 | できること | 審査 |
|---|---|---|
| `ui:slot` | スロットへの UI 描画 | 低 |
| `data:read:thread` | スレ・レス取得 | 低 |
| `data:read:board` | 板情報取得 | 低 |
| `data:write:post` | 閲覧者本人としての投稿（確認 UI あり） | 中 |
| `storage:shared` | 共有 KV（64KB/スコープ） | 低 |
| `net:fetch` | `connectAllowlist` のオリジンへの外部 fetch（プロキシ・監査付き） | 中 |
| `upload:start` | アップローダー起動 | 中 |
| `github:gist` / `github:repo` | 閲覧者の GitHub 連携リソース操作（都度同意） | 高 |
| `events:subscribe` | スレ/板のリアルタイムイベント購読 | 低 |
| `notify` | トースト通知 | 低 |
| `ai:complete` | サイトの AI 補助 API | 中 |

**宣言していない権限の RPC はホストが `PERMISSION_DENIED` で拒否します。** 権限は最小限にしてください。

## API

```ts
register({
  async activate(api) {
    const thread = await api.data.thread();
    await api.storage.set("lastThread", String(thread?.id ?? ""));
    await api.notify.show("読み込みました");
  },
  slots: {
    "thread-head": async ({ data, api, root }) => {
      const posts = await api.data.posts(data.threadId);
      root.textContent = `${posts.length} レス`;
    },
  },
  hooks: {
    // 投稿前フック: 本文を変換（プレーンテキストのみ）
    beforePost(draft) {
      return { body: draft.body.replace(/^>>/, "＞＞") };
    },
  },
  events: {
    post(event) {
      console.log("new post", event.post.num);
    },
  },
  onKill(reason) {
    console.log("stopped:", reason);
  },
});
```

- `api.ui.resize(height)` / `api.ui.setTitle(title)`
- `api.data.thread(threadId?)` / `api.data.board({slug|boardId})` / `api.data.posts(threadId)` / `api.data.createPost(draft)`
- `api.storage.get/set/delete/list`
- `api.net.fetch({url, method, headers, body})` — `connectAllowlist` のオリジンのみ
- `api.upload.start({accept, maxBytes})`
- `api.github.createGist({filename, content, public})` / `api.github.pushFile({owner, repo, path, content})`
- `api.events.subscribe(["post", "thread"])`
- `api.notify.show(message, {level})`
- `api.ai.complete(prompt, {system, maxTokens})`

## 宣言的レンダー規則（投稿表示変換）

JS を書かずに投稿表示を変換できます（ホストが実行。キャプチャは自動エスケープ）。

```json
{
  "render": {
    "post": [
      { "pattern": "&gt;&gt;(\\d+)", "flags": "g", "template": "▶$1", "kind": "link" },
      { "pattern": "\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]", "flags": "g", "template": "$1", "kind": "spoiler" }
    ]
  }
}
```

## 実行環境の制約

- `document.cookie` / `localStorage` / 親 DOM / 直接 `fetch` は **使えません**（不透明オリジン + CSP）。
- 無限ループ・`eval`・`new Function` は静的検査で公開がブロックされます。
- コードは 512KB まで。`storage:shared` はスコープあたり 64KB まで。
- サーバー側では実行されません（Cloudflare Workers Free にユーザーコード隔離機構がないため）。

## 開発の流れ

1. サイトの `/plugins/new/` でコードと manifest を書き、その場でプレビュー実行。
2. 保存 → 公開申請（`site` スコープは承認キュー、`personal` は審査不要）。
3. 個人用 / 板用（板管理人）/ サイト全体（サイト管理者）にインストール。
4. 版を追加すると、固定していないインストールは更新できます。
5. GitHub 連携なしでもレジストリ内で公開・検索・導入・更新が完結します（Gist/repo は任意）。
