# AI ペット（サイト組み込みの AI チャット）

おーぷんクローンの全ページ右下に住む AI ペットの使い方と、中継 API の説明です。
API キーは利用者のブラウザにだけ保存し、このサイトのサーバーは中継のたびに受け取って事業者へ送るだけで、
DB・ログ・監査には残しません。

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

- **置き場所**: 全ページの右下（`app/layout.tsx` の `<PetRoot />`）。呼び出しボタンは PC 64px、狭い画面は 52px。
  パネルは初めて開いたときに読み込む（`features/pet/ui/pet-root.tsx` の dynamic import）。
  サイトツアー中はボタンを出さない。
- **パネル**: `role="dialog"`。PC は右下 380×560 前後、スマホ（700px 以下）は全画面。
  上の帯に絵・名前・設定・消去（会話を消す）・しまう・閉じる。Esc で閉じる（確認カードがあれば取り消し）。
- **会話**: 利用者の発言・ペットの返事・「〇〇しています」の行・確認カードを並べる。
  返事は文字として表示し（HTML として解釈しない）、改行を残す。同じサイト内のパス（`/b/...`）だけをリンクにする。
- **入力**: Enter で送信、Shift+Enter で改行。日本語の変換中の Enter では送らない（`isComposing` と `keyCode 229`）。
  送信中はボタンが「止める」になり、待ちを中断できる（確認カードも取り消しになる）。
- **確認カード**: 掲示板に何かを残す・変える操作の前に必ず出る。対象と内容をそのまま表示し、
  「実行」を押したときだけツールが走る。取り消すと AI には `CANCELED` が返る。
  削除・管理操作は警告色で「実行する（取り消せません）」。板が Bot 確認を要する書き込みで、
  その板の 30 分パスが無いときは Turnstile を出し、通るまで「実行」を押せない。
- **最初の設定**: 事業者（OpenAI / Anthropic / Google Gemini / OpenRouter / DeepSeek / OpenAI 互換の URL）・
  モデル・API キー・「この端末に覚えておく」を入れる。API キーはパスワード欄（表示切替あり）で、
  発行画面へのリンクを出す。「接続を試す」はツール無しで短い文を 1 回だけ送る。
  案内として「頼んだ内容とペットが読んだページの文章が事業者に送られる」「料金は自分のキーにかかる」
  「キーはこのサイトのサーバーに保存されない」を出す。
- **モデル一覧**: 「モデル一覧を取得」を押したときだけ `POST /api/v1/pet/models` にキーを送る。
  取った一覧は入力中の文字で絞り込み（部分一致・大文字小文字を区別しない）、↑↓・Enter・Esc で選べる
  （`role="combobox"` / `listbox`）。取得できないときは理由を出し、自由入力のまま保存できる。
  一覧はこの端末にも保存しない（キーや事業者が変われば捨てる）。
- **見た目**: 既定の 4 体（ねこ・いぬ・ことり・ロボ）か、アップロードした画像。
  アップロードは png・jpeg・webp・gif の 5MB まで。ブラウザで 256×256 の PNG に縮めてこの端末にだけ保存する
  （サーバーには送らない）。名前は 20 文字まで。待機はふわふわ、考え中は揺れ、話すとぴょん。
  `prefers-reduced-motion` では動かさない。画像が読めないときは名前の頭文字で表示する。
- **保存**: 「この端末に覚えておく」がオンなら localStorage、オフなら sessionStorage（タブを閉じるまで）。
  API キーは中継のたびに `X-Pet-Api-Key` ヘッダーで送るだけで、サーバーは保存しない。
- **履歴**: sessionStorage に最大 40 件。「消去」で消える。移動（navigate）ツールは履歴を保存してから実行する。
- **音声入力**: ブラウザの音声認識（Web Speech API、`ja-JP`。Chrome は `webkitSpeechRecognition`）。
  対応していないブラウザではマイクを出さない。初回に「音声はブラウザの音声認識で文字にされます
  （Chrome では Google のサーバーに送られます）」と案内する。本番の `Permissions-Policy` は
  `microphone=(self)`（`apps/web/vercel.json`）。
- **会話の進行**: `features/pet/agent.ts`。1 回の依頼でツールは 8 往復まで。ツール結果は JSON にして
  8000 文字で切る。読むツールはその場で、書くツールは必ず確認カードを挟む。移動ツールはその回の最後に、
  履歴を保存してから実行する。中継の失敗は「キーが違う・回数の上限・時間切れ・モデル名」を切り分けた日本語で出す。
- **ヘッダー**: 「ペット」ボタンで、しまった後もいつでも呼び戻せる。