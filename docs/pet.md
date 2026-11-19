# AI ペット

サイトに組み込んだ AI チャット（ペット）。利用者が自分の AI 事業者の API キーとモデルを設定して使う。
設計は `ドキュメント/サブエージェント報告書/おーぷんクローン_AIペット/00_依頼内容と設計_オーケストレーター.md`。

## 中継 API

ブラウザはサイトの CSP（`connect-src`）のため AI 事業者へ直接つながない。`apps/api` の中継 API が
1 回だけ受け取り、事業者ごとの形に組み直して送る。**API キーはサーバーに保存しない**
（DB・ログ・監査・エラー文のどこにも残さない）。

### `POST /v1/pet/chat`

本文は `petChatRequestSchema`（`packages/shared/src/schemas/pet.ts`）。キーはヘッダーで渡す。

| ヘッダー | 内容 |
|---|---|
| `X-Pet-Api-Key` | 事業者の API キー（必須・512 文字まで・印字可能 ASCII のみ。無い／不正は 400） |
| `Origin` | サイトのオリジン（既存の mutation と同じ CSRF 検査） |

成功は `{ ok: true, data: PetChatResponse }`。`PetChatResponse` は事業者の違いを吸収した形:

- `message.content`: 本文（ツール呼び出しだけなら `null`）
- `message.toolCalls[]`: `{ id, name, arguments }`（`arguments` は JSON 文字列）
- `finishReason`: `stop` / `tool_calls` / `length` / `other`
- `model`: 事業者が返したモデル名（無ければ要求の値）
- `usage`: `{ inputTokens, outputTokens }`（不明は `null`）

事業者ごとの組み立て:

- openai 形式（openai / gemini / openrouter / deepseek / custom）
  - `POST {base}/chat/completions`、`Authorization: Bearer <key>`
  - `messages` の先頭に `system`。ツールは `{type:"function", function:{name, description, parameters}}`（空なら送らない）
  - assistant の `tool_calls` / tool の `tool_call_id` をそのまま対応させる
  - `maxTokens` があるときだけ `max_tokens` を送る
  - openrouter には `HTTP-Referer`（サイト URL）と `X-Title: open-clone` を付ける
- anthropic 形式
  - `POST {base}/messages`、`x-api-key`、`anthropic-version: 2023-06-01`
  - `system` は最上位。`max_tokens` は必須なので未指定なら `PET_LIMITS.maxTokensDefault`（2048）
  - assistant のツール呼び出しは `tool_use` ブロック（`input` は arguments を JSON として読む。読めなければ 400）
  - 連続する tool 結果は 1 つの user メッセージの `tool_result` ブロックにまとめる

### `POST /v1/pet/models`

設定画面の「モデル一覧を取得」用。本文は `{ provider, baseUrl? }`、キーは同じ `X-Pet-Api-Key`。

- openai 形式: `GET {base}/models` → `data[].id`
- anthropic: `GET {base}/models?limit=1000` → `data[].id` と `display_name`。`has_more` の間 `after_id` で次を取る（最大 5 回）
- 戻り値は `{ models: [{ id, label }], truncated }`。id は 1〜200 文字のものだけ、重複を除いて id 順、
  `PET_MODELS_MAX`（2000）を超えた分は捨てて `truncated: true`
- 回数制限は chat と別枠（1 分 10 回）

### 接続先

- プリセット（openai / anthropic / gemini / openrouter / deepseek）は固定 URL。
- `custom` は `baseUrl` 必須。`assertPublicHttpsUrl` で **https・公開ホスト・ポート 443** だけを許可する
  （http・私設 IP・localhost・このサイト自身は 400）。custom 以外で `baseUrl` を送ると 400。
- E2E は環境変数 `PET_PROVIDER_BASE_OVERRIDE` でスタブへ向ける（openai は `{override}/openai`、
  anthropic は `{override}/anthropic`）。custom の URL 検査は差し替えの前に行う。本番には設定しない。

### 上限と失敗

| 事業者の応答 | 返すもの |
|---|---|
| 401 / 403 | 502 `PET_PROVIDER_AUTH`（「AI 事業者が API キーを受け付けませんでした」） |
| 429 | 429 `PET_PROVIDER_RATE_LIMITED` |
| 時間切れ | 504 `PET_PROVIDER_TIMEOUT` |
| その他の 4xx / 5xx / 解釈できない | 502 `PET_PROVIDER_ERROR` |

- 要求本文は 512 KiB まで（超えたら 413 `PAYLOAD_TOO_LARGE`）。事業者応答は 1 MiB まで読む。待ちは 90 秒。
- 事業者のエラー文は 300 文字まで。キーの値・`sk-`・`Bearer` の後ろ・`AIza` など鍵らしい文字列は `[REDACTED]` にする。
- 回数制限は chat が 1 分 20 回・1 日 600 回、models が 1 分 10 回。
  キーはアカウント ID、未ログインは端末＋IP（匿名投稿と同じ考え方）。
- キー・会話本文・ツール結果は DB・`console.*`・監査・エラーの `cause` に残さない。

## 画面

（ペットの画面・設定・会話の進行・音声入力は画面担当が書く）