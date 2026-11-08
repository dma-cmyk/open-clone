# 外部サービス調査（保存先・GitHub・Cloudflare・Vercel・MCP）

- 調査日: 2026-11-08
- 対象: おーぷんクローン Phase 1（無料枠優先、R2 不使用、添付本体を Cloudflare に永続保存しない）
- 方針: 公式ドキュメント・規約を優先。CORS は `curl -X OPTIONS`（Origin: `https://example.com`）で実測。断定できない点は `[推測]`。
- 結論の要約: **添付は Catbox を既定（Worker プロキシ必須）、Cloudinary を画像の代替、Gist をテキスト/コード、Imgur は規約違反リスクで不採用**。リアルタイムは **Durable Objects + WebSocket Hibernation**。フロントは **Vercel 静的配信のみ**。MCP は **2026-07-28 仕様のステートレス Streamable HTTP** を Workers の `createMcpHandler` で実装。

---

## 1. 外部ファイル保存先の比較

### 1.1 比較表（主要候補）

| サービス | 無料枠 | 種別 | 最大サイズ | API キー | ブラウザ直アップロード (CORS) | ホットリンク | 掲示板からの規約上利用 |
|---|---|---|---|---|---|---|---|
| **Catbox.moe** | 無制限（寄付運営） | 画像/動画/テキスト/任意 | **200 MB**（GIF は 20 MB） | 不要（匿名可） | **不可**（ACAO なし・実測） | 非商用は可。商用は事前承認 | 非商用は可。広告・課金・企業利用は要承認 |
| **Litterbox** | 無制限（一時） | 画像/動画/テキスト | **1 GB** | 不要 | **可**（ACAO `*`・実測） | 可（ただし 1h/12h/24h/72h で消滅） | 一時用途のみ可 |
| **Cloudinary** | 25 credits/月 | 画像/動画 | プラン・設定依存 | 要（cloud_name + preset/secret） | **可**（Origin 反射・実測） | 可（CDN 前提） | 可（自サイト用途・非ポルノ・クレジット内） |
| **Imgur** | API 12,500 req/日・1,250 upload/日 | 画像/動画 | 画像 50 MB / GIF・動画 200 MB（動画 180 秒） | 要（Client-ID、匿名可） | 可（ACAO `*`・実測） | **規約で禁止**（CDN 化禁止） | **不可**（画像置き場/CDN 利用を明示禁止） |
| **ImgBB** | 無料 | 画像のみ | **32 MB** | 要 | 可（ACAO `*`・実測） | 可（フォーラム埋込前提） | 非商用は可。商用・自動アクセスは禁止 |
| **freeimage.host** | 無料（guest API） | 画像のみ | **64 MB** | 要 | 未実測 `[推測]` 可 | 可（埋込コードあり） | 非商用可（詳細規約は未確認） |
| **0x0.st** | 無制限（寄付） | 任意 | **512 MiB** | 不要 | 未実測（当環境から 500） | 直リンク可 | 一時用途のみ。バックアップ/CI 成果物は禁止 |
| **file.io** | 無料 | 任意 | 4 GB | 不要 | — | 不可（10 ダウンロード/日） | **不可**（API 廃止・3 日で削除） |
| **uguu.se** | 無料 | 任意 | 128 MiB | 不要 | — | 可 | **不可**（3 時間で削除） |
| **Gyazo** | 無料 | 画像/短動画 | 7 秒動画 | 要（OAuth） | — | 可 | **不適**（無料は最新 10 件のみ閲覧） |
| **GitHub Releases** | 無料 | 任意（配布物） | **2 GiB/ファイル** | 要（トークン） | — | 可（署名付き URL） | プロジェクト配布物向け。ユーザー添付には不適 |
| **GitHub Gist** | 無料 | テキスト/コード | API 1 MB/ファイル（10 MB 超は clone） | 要（`gist` スコープ） | — | 可（raw） | テキスト/コード向け |
| **GitHub リポジトリ / raw** | 無料 | 任意（コード） | 100 MB/ファイル（超過ブロック） | 要（書込） | 可（ACAO `*`・実測） | 技術的には可 | コード/プラグイン配信向け。メディア置き場は不適 |
| **jsDelivr** | 無料 | コード/静的ファイル | **20 MB/ファイル**、150 MB/パッケージ | 不要 | 可（ACAO `*`・実測） | 可 | **画像・動画の一般ホスティングは禁止**。プラグイン配信のみ可 |

### 1.2 各サービスの詳細と規約

#### Imgur（不採用）
- 匿名アップロードは `Authorization: Client-ID <id>` で可能。ただしアプリ登録（client_id/secret）が必須。
- レート: 約 **12,500 リクエスト/日**、約 **1,250 アップロード/日**（アップロードは 10 credit 消費）。IP 単位で **1,250 POST/時**。日次上限を月 5 回超えると月末までブロック。
- 商用利用はアプリ登録後に **RapidAPI** 経由へ移行が必要。
- **2023-05-15 の規約改定**で NSFW（ヌード・ポルノ・性的表現）を禁止。匿名かつ未使用・未閲覧の古い画像は削除対象。
- 現行 ToS（2026-10-02 発効）に「**他のサイトからリンクする画像ライブラリや、ウェブサイト用コンテンツとして Imgur を使うな（CDN 化禁止）**」と明記。掲示板の添付保存先としての利用は規約違反。
- CORS は `*` で技術的には可能だが、規約面で不可。
- 出典: <https://apidocs.imgur.com/>、<https://imgur.com/tos>、<https://help.imgur.com/hc/en-us/articles/26479362527771-Imgur-Terms-of-Service-Update>、<https://help.imgur.com/hc/en-us/articles/26511665959579-What-files-can-I-upload-Is-there-a-size-limit>

#### Cloudinary（画像の代替本命）
- Free: **25 credits/月**（クレカ不要）。1 credit = 1,000 transformations / 1 GB ストレージ / 1 GB 画像帯域 / 1 GB 動画帯域（Free）。変換・帯域は**直近 30 日のローリング**、ストレージは現在値。
- Free プランは「クレジット内なら本番利用可」と公式 FAQ が明記。
- **unsigned upload preset** によりブラウザから直接アップロード可能。CORS は Origin を反射（実測）。
- 規約: 「**あなたが所有・運営するウェブサイト/アプリの事業目的**に限り使用可。再商用化・再販は不可」。ポルノ・わいせつ物は禁止。
- 超過時: 即時課金ではなく、警告メール→アップグレード促し→複数回通知後にアカウント無効化。
- 注意: unsigned preset は preset 名を知る誰でもアップロードできるため、**Worker で signed upload にし、ユーザー単位のレート制限を掛ける**のが安全。動画は帯域消費が大きく Free では現実的でない。
- 出典: <https://cloudinary.com/pricing>、<https://cloudinary.com/documentation/billing_and_plans>、<https://cloudinary.com/documentation/developer_onboarding_faq_free_plan>、<https://cloudinary.com/documentation/upload_presets>、<https://cloudinary.com/tou>

#### Catbox.moe（既定候補）
- 上限 **200 MB**、匿名可、API キー不要。API は `POST https://catbox.moe/user/api.php` の multipart（`reqtype=fileupload`、`fileToUpload`）。返り値は URL のプレーンテキスト。
- 匿名ファイルは**2 年間アクセスがないと削除**。アカウント紐付けなら永続。GIF は 20 MB 上限。アルバムは 500 ファイル。
- 禁止: `.exe/.scr/.cpl/.doc*/.jar`、児童ポルノ、マルウェア、アニメ/TV 全話、過度なグロ。
- 規約: **商用サービスでの利用は事前承認が必要**（CDN、広告/収益化サイトへのホットリンク、外部サイトでの動画ストリーム等）。「ホットリンク全般」ではなく**商用目的**が対象、という注記あり。
- **CORS 実測: `Access-Control-Allow-Origin` なし**。さらに `Referer`/ブラウザ UA なしでは **412**。`Referer: https://catbox.moe/` を付けると 200 で URL を返す。→ 単純 POST 自体は送れても**応答 URL をブラウザから読めない**ため、実質 **直接アップロード不可。Worker プロキシ必須**。
- Worker の受信ボディ上限（Cloudflare Free ゾーン）は 100 MB のため、**実質上限は 95 MB 程度**に制限する。200 MB はサービス上限。
- レート制限は非公開 `[推測]`。Cloudflare からの egress がブロックされる可能性も否定できない `[推測]`（監視必須）。
- 出典: <https://catbox.moe/>、<https://catbox.moe/tools.php>、<https://catbox.moe/faq.php>、<https://catbox.moe/legal.php>

#### Litterbox（一時用途）
- **1 GB**、匿名可、`time=1h|12h|24h|72h`。API は `POST https://litterbox.catbox.moe/resources/internals/api.php`（`reqtype=fileupload`、`time`、`fileToUpload`）。CORS は `*`（実測）。Catbox 同一運営・同一規約。
- 恒久添付には使えない。「一時ファイル」「期限付き添付」専用。

#### ImgBB / freeimage.host（画像フォールバック）
- ImgBB: **32 MB**、API キー必須、CORS `*`（実測）。ToS は 18 歳以上・**商用利用禁止**・**自動アクセス（bot/script）禁止**。API を提供しているのに自動アクセスを禁止しており、掲示板からの機械的アップロードは規約解釈が微妙。
- freeimage.host: **64 MB**、guest API、画像のみ。
- いずれも **API キーをクライアントに露出させず Worker 経由**にする。

#### 0x0.st / file.io / uguu（不適）
- 0x0.st: **512 MiB**、保持 30〜365 日（サイズ依存）、アカウント不要。規約で「バックアップ」「CI 成果物」等を禁止。恒久添付には不適。CORS は当環境から 500 で未確認。
- file.io: 4 GB / 3 日 / 1 ファイル 10 ダウンロード/日。**CLI API は廃止済み**でブラウザのみ。埋込不可。
- uguu: 128 MiB / 3 時間。不可。

#### GitHub Releases / Gist / raw / jsDelivr
- Releases: 1 リリース **1,000 アセット**、**2 GiB/ファイル**、合計サイズ・帯域の上限なし。ただしリポジトリ管理者の操作が必要で、匿名ユーザーの添付先にはならない。
- Gist: API は **1 MB/ファイル**まで内容を返す。10 MB 超は clone が必要。一覧は 300 ファイルまで。`gist` スコープが必要。secret gist は「非公開」ではなく「検索されない」だけ。
- raw.githubusercontent.com: CORS `*`（実測）、`Cache-Control: max-age=300`。ファイルはリポジトリの 100 MB 上限に従う。帯域上限は公式に明示なし `[推測]`。
- jsDelivr: `/gh/` は **20 MB/ファイル**、パッケージ **150 MB**。帯域・リクエスト上限なし。HTML は `text/plain` で配信。規約で「**画像ホスティングサイトのストレージとして使うこと**」「動画・バックアップの大量ホスティング」を禁止。プラグイン配信には最適、メディアには不可。
- 出典: <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>、<https://docs.github.com/en/rest/gists/gists>、<https://cdn.jsdelivr.net/gh/jsdelivr/jsdelivr/README.md>、<https://raw.githubusercontent.com/jsdelivr/jsdelivr/master/Terms%20of%20Use.md>

### 1.3 CORS 実測結果（2026-11-08）

| エンドポイント | プリフライト | ACAO | 備考 |
|---|---|---|---|
| `https://api.imgur.com/3/image` | 200 | `*` | credentials も許可 |
| `https://api.cloudinary.com/v1_1/demo/image/upload` | 200 | Origin 反射 | `PUT/POST/GET/OPTIONS` |
| `https://catbox.moe/user/api.php` | **412** | **なし** | `Referer` 付き POST は 200 だが ACAO なし |
| `https://litterbox.catbox.moe/resources/internals/api.php` | 405 | `*` | プリフライトは 405 だが単純 POST は可（ACAO あり） |
| `https://api.imgbb.com/1/upload` | 200 | `*` | |
| `https://raw.githubusercontent.com/...` | 200 | `*` | |
| `https://cdn.jsdelivr.net/...` | 200 | `*` | |
| `https://0x0.st` | 500 | — | 当環境からブロック。未確認 |

> CORS はブラウザ側の制御であり、**サーバー間（Worker→サービス）では不要**。Catbox は Worker プロキシで回避する。

### 1.4 無料枠・規約の実務的な結論

- **恒久保存 × 無料 × 規約OK** の三条件を満たすのは実質 **Catbox（非商用）** と **Cloudinary（クレジット内）**。
- Imgur は「掲示板の添付置き場」を規約で明確に禁止しており、**採用しない**。
- GitHub はコード/テキストの配布には強いが、**ユーザー投稿メディアの保存先ではない**（リポジトリ容量推奨 <1 GB、ファイル 100 MB 上限、jsDelivr はメディア禁止）。
- 商用（広告・有料機能・企業運営）に切り替える可能性があるなら、**Catbox は事前承認が必要**。その場合は Cloudinary 有料プラン or 外部の専用ストレージへ切替できるアダプタ構造にする。

### 1.5 推薦順位（既定アップローダー）

| 種別 | 1位 | 2位 | 3位 | 不採用 |
|---|---|---|---|---|
| **画像** | **Catbox**（Worker プロキシ、≤95 MB、非商用） | **Cloudinary**（signed upload、≤10 MB、変換・安定性） | ImgBB（32 MB、API キー、予備） | Imgur（規約違反）、Gyazo（無料枠不適） |
| **動画** | **Catbox**（≤95 MB、Worker プロキシ） | Cloudinary（短尺のみ・クレジット消費大） | Litterbox（72h の一時動画） | Imgur（規約違反・180 秒）、file.io/uguu（短命） |
| **テキスト** | **GitHub Gist**（ユーザー連携時、コード/ログ） | **Catbox**（匿名テキスト、Worker プロキシ） | 0x0.st（一時ログ、30〜365 日） | file.io（API 廃止）、Litterbox（72h のみ） |

**理由（要旨）**
- 画像/動画は「ユーザーが匿名で即投稿できる」「200 MB 級」「API キー不要」を満たす Catbox が最も要件に合う。CORS がないため Worker プロキシは必須だが、Cloudflare に本体を保存しない要件とも整合する（ストリーミング転送のみ）。
- Cloudinary は規約・API・CORS の面で最も安全だが、25 credits/月は画像中心でもすぐ尽きる。**署名付きアップロード + 強いレート制限**が前提。動画は非推奨。
- テキスト/プラグインコードは GitHub（Gist/リポジトリ）が本命。ただし Gist はユーザーの GitHub 連携が必要なので、未連携ユーザーは Catbox にフォールバック。
- **アダプタ化**: `UploaderAdapter { id, capabilities, maxBytes, allowedMime, requiresProxy, upload(file, ctx) → { url, deleteUrl?, expiresAt? }, delete?(ref) }` を定義し、板ごと・サイト全体で既定を切替。UI は「保存先」を意識させない。

**実装上の必須条件**
- アップロードは Worker で受けて外部へストリーム転送。**R2/Images/Stream/Cache API に保存しない**（要件）。
- ファイル名・MIME・マジックバイト・サイズを検証。Turnstile + ユーザー単位レート制限 + 板ごと容量割当。
- Catbox へは `Referer: https://catbox.moe/` と一般的な UA を付ける（付けないと 412）。
- 削除 URL はサービスが返す場合のみ保存。返らない場合（Catbox 匿名）は「削除不可」を UI に明示。
- 外部 URL は CSP の `img-src`/`media-src` に追加。`Referrer-Policy` は `no-referrer` だと Catbox が 412 になる可能性 `[推測]` → 画像表示は直リンク、アップロードのみ Worker。

---

## 2. GitHub の制限とユーザー連携

### 2.1 容量・ファイルサイズ

| 項目 | 制限 | 出典 |
|---|---|---|
| リポジトリ推奨サイズ | **1 GB 未満**を推奨、**5 GB 未満**を強く推奨 | about-large-files |
| 通常ファイル | 50 MiB 超で警告、**100 MiB 超はブロック** | 同上 |
| ブラウザからの追加 | **25 MiB** まで | 同上 |
| Git LFS | **2 GB/ファイル**（Free/Pro）、無料 10 GiB ストレージ + 10 GiB 帯域/月 | about-git-lfs、git-lfs billing |
| Releases | 1 リリース 1,000 アセット、**2 GiB/ファイル**、合計・帯域上限なし | about-releases |
| Gist | API は **1 MB/ファイル**まで返却、10 MB 超は clone、一覧 300 ファイル | REST gists |
| Contents API (GET) | ≤1 MB は全機能、1–100 MB は raw/object のみ、**100 MB 超は非対応**。1 ディレクトリ 1,000 ファイル | REST contents |
| Contents API (PUT) | Base64 で送るため大容量に不向き。Git の 100 MB 上限に従う | REST contents |
| raw.githubusercontent.com | リポジトリの 100 MB 上限に従う。CORS `*`、キャッシュ 300 秒 | 実測 |
| jsDelivr `/gh/` | **20 MB/ファイル**、150 MB/パッケージ。帯域・リクエスト上限なし | jsDelivr README |

> Gist は git リポジトリなので、実務上は 100 MB/ファイルの Git 上限も受ける `[推測]`（公式に Gist 固有の上限は 1 MB API / 10 MB clone / 300 ファイルのみ明記）。

### 2.2 配信（raw / jsDelivr）の可否

| 配信元 | 用途 | 制限 | 判定 |
|---|---|---|---|
| `raw.githubusercontent.com` | プラグイン JS/CSS、設定 JSON、テキスト | 100 MB/ファイル、5 分キャッシュ、帯域上限は非公開 | **小さいコードのみ可**。メディア不可 |
| `cdn.jsdelivr.net/gh/...` | プラグイン配布、バージョン固定 | 20 MB/ファイル、150 MB/パッケージ、HTML は text/plain | **プラグイン配布に最適**。画像/動画ホスティングは規約違反 |
| GitHub Releases | 配布バイナリ | 2 GiB/ファイル、1,000 アセット | 配布物のみ |
| Gist raw | スニペット | 1 MB API / 10 MB clone | テキストのみ |

- jsDelivr は「画像ホスティングサイトの保存先」「動画・バックアップの大量ホスティング」を明確に禁止。**掲示板の添付 CDN には使えない**。
- GitHub raw/jsDelivr は `Access-Control-Allow-Origin: *` なので、ブラウザからの fetch は可能。

### 2.3 REST API レート制限

| 条件 | 上限 |
|---|---|
| 未認証 | **60 req/時**（IP 単位） |
| 認証済み（PAT / OAuth / GitHub App user token） | **5,000 req/時**（ユーザー単位、全アプリ合算） |
| GitHub Enterprise Cloud の App/OAuth | 15,000 req/時 |
| GitHub App installation token | 5,000 req/時〜（リポジトリ/ユーザー数で最大 12,500） |
| `GITHUB_TOKEN`（Actions） | 1,000 req/時/リポジトリ |
| OAuth App の client_id:secret（公開データ） | 5,000 req/時/アプリ |
| 二次制限 | 同時 100、REST 900 points/分、**コンテンツ生成 80/分・500/時**、OAuth token 2,000/時 |

- プラグインの Gist 保存・リポジトリ書き込みをユーザーごとに行うと、**ユーザーの 5,000/時**を共有する。バッチ/キャッシュ必須。
- 出典: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>

### 2.4 OAuth App vs GitHub App vs fine-grained PAT

| 観点 | OAuth App | GitHub App | fine-grained PAT |
|---|---|---|---|
| 作成 | GitHub 設定画面で**手動登録**（最大 100 個/所有者） | 設定画面で**手動登録** | ユーザーが**手動発行**（最大 50 個） |
| 権限 | スコープ（`repo`, `public_repo`, `gist` 等） | **fine-grained**（リポジトリ単位・権限単位） | fine-grained（リポジトリ単位） |
| トークン寿命 | 既定は長期。設定で 8 時間 + refresh 可 | user token 8 時間 + refresh、installation token 1 時間 | 長期（未使用 1 年で自動削除） |
| リポジトリ選択 | スコープ内の全リポジトリ | インストール時に選択したリポジトリのみ | 選択したリポジトリのみ |
| Gist | **可**（`gist` スコープ） | **不可**（Gists 権限が存在しない） | **可**（`gists: write`） |
| ユーザー体験 | 「Authorize」のみ | 「Install」+「Authorize」 | トークン貼り付け |
| レート | ユーザーの 5,000/時 | ユーザー 5,000/時、installation はスケール | ユーザーの 5,000/時 |
| 最適用途 | **ユーザー連携（repo + Gist）** | サイト運営の自動化・fine-grained な repo 書込 | 上級者向けフォールバック |

**推奨**
1. **メイン: OAuth App（Web flow + 任意で Device flow）**。理由: ユーザーのリポジトリと Gist の両方を 1 つの連携で扱え、ユーザーは「Authorize」だけで済む。スコープは `public_repo`（公開リポジトリのみ）と `gist` を最小限に。トークンは暗号化して D1 に保存し、refresh 対応（8 時間 + refresh）を有効化。
2. **併用: GitHub App**。サイト運営側の自動処理（プラグイン審査リポジトリへの書込、Webhook 受信、監査）に使う。fine-grained・短命・インストール単位で安全。**Gist には使えない**。
3. **フォールバック: fine-grained PAT**。OAuth App を用意できない環境や、ユーザーが自分のトークンを持ち込みたい場合のみ。UI は「トークンを貼る」で、権限は `contents:write` / `gists:write` に限定するよう案内。
4. **Device flow** は OAuth App 設定の「Enable Device Flow」を**手動でチェック**する必要がある。CLI/外部 AI エージェント向けに有効化する。
5. **人手は初回のみ必須**: OAuth App / GitHub App の作成は GitHub の Web UI でしか行えず、REST API では作成できない。client secret、callback URL、Device flow 有効化は手動。fine-grained PAT はユーザーが都度発行する。

- 出典: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps>、<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>、<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps>、<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app>、<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>、<https://docs.github.com/en/rest/gists/gists>

---

## 3. Cloudflare Workers Free / D1 / DO / Cron / Turnstile / Queues

### 3.1 無料枠一覧

| サービス | Free の枠 | 主な上限 | 超過時 |
|---|---|---|---|
| **Workers** | 100,000 req/日 | CPU **10 ms**/req、メモリ 128 MB、サブリクエスト 50/req、同時接続 6、環境変数 64、Worker 100 個、バンドル 64 MiB、Cron 5/アカウント、静的アセット 20,000 ファイル/25 MiB | **Error 1027**（fail open/closed はルート設定）。課金なし |
| **D1** | 500 万 rows read/日、10 万 rows write/日、5 GB 合計 | DB 10 個、**500 MB/DB**、クエリ 50/呼び出し、SQL 100 KB、行/BLOB 2 MB、結果 50 MB、クエリ 30 秒、Time Travel 7 日 | クエリがエラー。ストレージ満杯で書込不可（読取/削除は可） |
| **Durable Objects** | 100,000 req/日、13,000 GB-s/日、500 万 read/日、10 万 write/日、5 GB | **SQLite バックエンドのみ**、クラス 100、WebSocket メッセージ 32 MiB、Object あたり 1 GB（FAQ。公式表は 10 GB で不一致） | その操作がエラー。課金なし |
| **Cron Triggers** | 5/アカウント | UTC、CPU 10 ms、wall 15 分、反映に最大 15 分 | 6 個目は登録不可（実行量の従量上限ではない） |
| **Turnstile** | 無制限のチャレンジ・検証 | ウィジェット 20、ホスト名 10/ウィジェット、分析 7 日 | 上限なし（Free の範囲で無制限） |
| **Queues** | 10,000 operations/日 | キュー 10,000、メッセージ 128 KB、保持 24 時間（Free 固定）、retry 100、batch 100、5,000 msg/s/キュー | 操作がエラー |

**課金の有無**
- Workers Free / D1 Free / DO Free / Queues Free は**支払い方法を要求せず、上限超過は課金ではなくエラー/停止**になる。自動で有料プランに移行しない。Workers は 1027 エラー（ルート設定が fail open ならバイパス）、D1/DO/Queues は該当操作がエラーになる。
- ただし **R2 / Images / Stream / Workers Paid / Queues Paid** を有効化すると課金対象。要件どおり**これらは使わない**。
- Vercel は異なり、Hobby の上限超過は**最大 30 日間の利用停止**（後述）。

- 出典: <https://developers.cloudflare.com/workers/platform/limits/>、<https://developers.cloudflare.com/workers/platform/pricing/>、<https://developers.cloudflare.com/d1/platform/limits/>、<https://developers.cloudflare.com/d1/platform/pricing/>、<https://developers.cloudflare.com/durable-objects/platform/pricing/>、<https://developers.cloudflare.com/durable-objects/platform/limits/>、<https://developers.cloudflare.com/workers/configuration/cron-triggers/>、<https://developers.cloudflare.com/turnstile/plans/>、<https://developers.cloudflare.com/queues/platform/limits/>、<https://developers.cloudflare.com/queues/platform/pricing/>

### 3.2 無料枠の実務的なボトルネック

| 制約 | 影響 | 対策 |
|---|---|---|
| Workers CPU **10 ms** | パスワードハッシュ（Argon2/bcrypt）、大量 HTML サニタイズ、巨大 JSON パースが困難 | WebCrypto PBKDF2 を軽い反復数で、または OAuth/マジックリンク。重い処理は外部 AI/クライアントへ |
| Workers **100k req/日** | 閲覧 1 万 PV × API 10 回で上限 | 静的アセットは無料・無制限。API はバッチ + Cache API（添付本体はキャッシュしない）。SSE/WS でポーリング削減 |
| D1 **500 MB/DB** | 投稿が増えると数年で到達 | 板/year で DB をシャード（Free は 10 DB = 5 GB）。古いスレはアーカイブ DB へ |
| D1 **10 万 write/日** | 1 投稿 1〜3 行なら 3〜10 万投稿/日 | いいね・既読はバッチ化、DO で集約 |
| D1 **50 クエリ/呼び出し** | N+1 が即死 | `batch()` と JOIN、インデックス必須 |
| DO **100k req/日** | WebSocket の受信メッセージが加算 | アプリ層の heartbeat を送らない（プロトコル ping は課金対象外）。送信はユーザー操作時のみ |
| 受信ボディ **100 MB** | 200 MB の Catbox 直送不可 | 95 MB に制限。大きい動画は非対応と明示 |
| Queues **10k ops/日** | 1 メッセージ = write+read+delete の 3 ops → 約 3,300 通/日 | AI モデレーションは重要度で絞る。バッチ処理 |

### 3.3 リアルタイム更新方式の比較（無料枠観点）

| 方式 | Free でのコスト | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| **DO WebSocket + Hibernation** | 接続 1 req、受信メッセージ 1 req、**送信は無料**、アイドル中は duration 0 | 双方向・低遅延・アイドル無料・1 DO で多数接続 | DO の実装が必要。Free は SQLite のみ | **推奨** |
| DO → SSE | 接続中は DO が hibernation できず **GB-s を消費** | プロキシ/ FW に強い | duration 課金が増える。再接続管理 | 次点（フォールバック） |
| Worker が DO をポーリングして SSE | イベントごとに Worker + DO の 2 req | 実装が単純 | リクエスト数が 2 倍。スケールしない | 非推奨 |
| クライアント polling | 1 req/クライアント/間隔 | 最も単純 | 1,000 人 × 10 秒 = **864 万 req/日**で即超過 | 非常用のみ |
| ロングポーリング | 接続 1 req + 再取得 | polling より少ない | それでも接続ごとに req。DO 必須 | 非常用 |

**推奨設計**
- スレごと（または板ごとシャード）に DO を 1 つ置き、**Hibernation WebSocket** で購読者にブロードキャスト。Free は SQLite バックエンドのみなので、Wrangler の migration は `new_sqlite_classes` を使う。
- 新規レスは Worker → DO に 1 回転送（DO 1 req）。DO は SQLite に直近 N 件を保持し、再接続時に差分を返す。正本は D1。
- クライアントは**アプリ層 heartbeat を送らない**。WS のプロトコル ping/pong はランタイムが処理し、課金対象外。
- 送信メッセージ（サーバー→クライアント）は無料。**受信**だけが 100k/日に加算される。
- 試算: 同時 1,000 接続、ユーザーが 1 分に 1 回だけ操作 → 1,440 受信/日 + 接続 1,000/日。**余裕**。ただし全員が 1 分ごとにアプリ ping を送ると 144 万/日で超過。
- SSE が必要な環境（WebSocket 不可のプロキシ）のみ、DO の `ReadableStream` でフォールバック。常用しない。

- 出典: <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>、<https://developers.cloudflare.com/durable-objects/platform/pricing/>

---

## 4. Vercel Hobby の制限と静的/SSR

### 4.1 Hobby の主な枠

| 項目 | Hobby |
|---|---|
| Fast Data Transfer | **100 GB/月** |
| CDN Requests | **1,000,000/月** |
| Function Invocations | **1,000,000/月** |
| Active CPU | **4 CPU 時間/月** |
| Provisioned Memory | 360 GB 時間/月 |
| Image Transformations | 5,000/月（Cache Read 300k、Write 100k） |
| Deployments | 100/日 |
| Build | 45 分/デプロイ、vCPU 2、メモリ 8 GB、ディスク 32 GB |
| Static file uploads | 100 MB/デプロイ |
| Functions | 最大 300 秒、2 GB / 1 vCPU |
| Projects / Routes | 200 / 2,048 |
| Cron Jobs | 100/プロジェクト |
| Runtime Logs | 1 時間 |

- 超過時: 課金ではなく**最大 30 日間その機能が使えなくなる**（Hobby は無料枠のため）。
- 出典: <https://vercel.com/docs/plans/hobby>、<https://vercel.com/docs/limits>

### 4.2 商用不可条項（重要）

- Hobby は「**非商用の個人利用のみ**」。商用とは「制作に関わる誰かが金銭的利益を得る目的のデプロイ」で、**広告の掲載**、支払いの受付、製品販売、制作費の受領、アフィリエイト主目的のサイト等が該当。
- **寄付は商用に該当しない**（明記）。
- 掲示板に広告を出す、有料機能を付ける、企業として運営する場合は **Pro 以上が必須**。
- 追加制約: **Hobby では Git 組織（Organization）所有のリポジトリに接続できない**。個人リポジトリにするか、CLI/Deploy Hook でデプロイする。
- 出典: <https://vercel.com/docs/limits/fair-use-guidelines>、<https://vercel.com/docs/plans/hobby>

### 4.3 静的 vs SSR

| 観点 | 静的（SSG/CSR） | SSR / ISR |
|---|---|---|
| Function Invocations | 0 | ページ閲覧ごとに 1 |
| Active CPU | 0 | 4 CPU 時間/月を消費 |
| CDN Requests | 1M/月を消費 | 1M + Functions |
| レイテンシ | CDN から即時 | コールドスタートあり |
| キャッシュ | CDN 任せ | 追加設計が必要 |
| 無料枠への優しさ | **高い** | 低い |

**推奨**
- **Next.js の静的エクスポート（`output: 'export'`）または SPA** にして、Vercel は HTML/JS/CSS の配信だけに使う。データ取得はブラウザから Workers API へ。
- Vercel Functions / ISR / Image Optimization は**使わない**（画像は外部 URL をそのまま表示）。
- 同一オリジンにしたい場合は Vercel の `rewrites` で `/api/*` → Workers にプロキシ。Cookie は `SameSite=None; Secure` か、`api.example.com` の CORS 許可で対応。プロキシ帯域も Vercel の 100 GB に計上される `[推測]`。
- 1M CDN リクエスト/月は、ページあたりのアセット数を減らす（バンドル、HTTP/2、キャッシュヘッダ）ことで延ばす。画像は外部ホストに置くため Vercel 帯域はほぼ HTML/JS のみ。
- 商用化する場合は Pro（$20/ユーザー/月〜）へ。Hobby のまま広告を出すと規約違反。

---

## 5. MCP（Model Context Protocol）の最新仕様と Workers 実装

### 5.1 最新トランスポート仕様（2026-07-28）

- 現行の最新リビジョンは **2026-07-28**（前版 2025-11-25）。**プロトコルレベルのセッションと `initialize` ハンドシェイクを廃止**し、完全ステートレス化。
- Streamable HTTP の要点:
  - **単一の MCP エンドポイント（POST のみ）**。GET ストリームは廃止。
  - 各リクエストは独立した HTTP POST。応答は `application/json` または**リクエスト単位の SSE**。
  - 必須ヘッダ: `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name`（`tools/call` 等）。本文の `_meta` と不一致なら 400 `HeaderMismatch`。
  - 通知は 202。サーバー起点の要求（sampling/elicitation/roots）は **MRTR**（`InputRequiredResult` + 再試行）に置換。
  - 変更通知は `subscriptions/listen` の長時間 SSE。`Last-Event-ID` による再開は**廃止**。
  - `Origin` 検証必須（不正なら 403）。ローカルは 127.0.0.1 バインド推奨。
  - 未知メソッドは 404 + `-32601`。未知バージョンは 400 + `UnsupportedProtocolVersionError`。
  - 結果には `resultType`（`complete` / `input_required`）が必須。`tools/list` 等は `ttlMs`/`cacheScope` を持つ。
- 後方互換: 2025-06-18〜2025-11-25 のクライアントが多いため、サーバー側に**レガシー互換レーン**が必要。
- 出典: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>、<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>、<https://modelcontextprotocol.io/specification/2026-07-28/changelog>

### 5.2 Cloudflare Workers での実装

| 項目 | 内容 |
|---|---|
| 推奨 SDK | `agents`（Agents SDK v0.20.0 以降）+ `@modelcontextprotocol/server@2.3.1` + `zod` |
| エントリ | `createMcpHandler`（`agents/mcp/server`） |
| ステートレス | リクエストごとに `McpServer` を生成。**DO/セッション/WebSocket 不要** |
| ルート | 既定 `/mcp`。`route` で変更可 |
| 応答 | `responseMode` は `auto` / `json` / `sse` |
| 互換 | `legacy: "stateless"`（既定）が旧クライアントを許容。`"reject"` で完全ステートレス専用 |
| 認証 | `@cloudflare/workers-oauth-provider` の `OAuthResourceServer` でトークン検証。認可サーバーは `OAuthAuthorizationServer`（別 Worker + Service Binding 可） |
| 認証情報 | ツール内で `getMcpAuthContext()` から `props` を取得 |
| CORS/Origin | `allowedHostnames` / `allowedOriginHostnames` / `corsOptions`。**CORS は認証ではない** |
| 長時間ストリーム | `subscriptions/listen` 対応。`maxSubscriptions` 既定 1,024、`keepAliveMs` 既定 15,000 |
| 非推奨 | `McpAgent`（DO ベース）は非推奨・機能凍結。`createLegacyMcpHandler` は一時的な移行用 |

- パッケージの世代: **SDK v2** は `@modelcontextprotocol/server`（クライアントは `@modelcontextprotocol/client`）。**旧 `@modelcontextprotocol/sdk@1.32.1`** はセッション/GET ストリーム等が必要な一時レーン専用で、新規実装では使わない。`agents` は v0.20.0 以降が必要。

**コードの骨子**
```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
  const s = new McpServer({ name: "open-clone", version: "1.0.0" });
  s.registerTool("search_posts", {
    description: "掲示板の投稿を検索",
    inputSchema: z.object({ q: z.string(), board: z.string().optional() }),
  }, async ({ q, board }) => ({
    content: [{ type: "text", text: JSON.stringify(await search(q, board)) }],
  }));
  return s;
}

export default {
  fetch(req, env, ctx) {
    return createMcpHandler(createServer, {
      allowedHostnames: ["mcp.example.com"],
      allowedOriginHostnames: ["app.example.com"],
    })(req, env, ctx);
  },
};
```

**本プロジェクトへの適用方針**
- MCP エンドポイントは API と同じ Worker の `/mcp` に同居。認証は **OAuth（MCP 標準）** を基本にし、外部 AI（Claude Code / Codex / OMP）向けに **API キー → OAuth トークン交換**のブリッジを用意すると導入が早い。
- ツールは `search_posts` / `get_thread` / `create_post` / `report_post` / `list_boards` / `moderate`。**スコープで権限分離**（`mcp:read`, `mcp:post`, `mcp:moderate`）。
- 書き込み系は既存の REST API と同じ認可・監査ログ・レート制限を共有する（MCP 専用の抜け道を作らない）。
- CPU 10 ms 制約があるため、ツールは薄く保ち、検索は D1 のインデックス + ページネーション。大きな処理は外部 AI 側で行う。
- 旧クライアント互換のため `legacy: "stateless"` を維持。将来 `"reject"` に切替可能なようにテストを分ける。
- 出典: <https://developers.cloudflare.com/agents/model-context-protocol/>、<https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/>、<https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>、<https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/>、<https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/>

---

## 6. 結論（Phase 1 の推奨構成）

| 領域 | 決定 | 理由 / 制約 |
|---|---|---|
| 画像の既定保存先 | **Catbox**（Worker プロキシ、≤95 MB、非商用） | 無料・匿名・200 MB・API キー不要。CORS なしのためプロキシ必須。商用化時は要承認 |
| 画像の代替 | **Cloudinary**（signed upload、≤10 MB） | 規約・CORS・変換が堅牢。25 credits/月の範囲で使う。unsigned は使わない |
| 動画の既定保存先 | **Catbox**（≤95 MB） | Free の受信ボディ 100 MB 制限に合わせる。Cloudinary は動画帯域が高コスト |
| 一時ファイル | **Litterbox**（1h/12h/24h/72h） | CORS `*` でブラウザ直送も可。恒久保存には使わない |
| テキスト/コード | **GitHub Gist**（ユーザー連携時）→ **Catbox**（未連携時） | Gist は `gist` スコープが必要。プラグイン配布は jsDelivr（20 MB/ファイル） |
| 不採用 | Imgur、file.io、uguu、Gyazo、jsDelivr のメディア利用 | 規約違反・短命・無料枠不適 |
| GitHub ユーザー連携 | **OAuth App**（`public_repo` + `gist`、Device flow 任意）+ 運営用 **GitHub App** | Gist は OAuth App/PAT のみ。GitHub App は fine-grained な repo 書込用。初回登録は人手 |
| リアルタイム | **DO + WebSocket Hibernation** | 送信無料・アイドル duration 0・100k req/日。SSE/polling は非常用 |
| フロント | **Vercel 静的配信のみ**（`output: 'export'`） | Functions/ISR/Image Optimization を使わない。商用化時は Pro 必須 |
| MCP | **2026-07-28 ステートレス Streamable HTTP** を `createMcpHandler` で実装 | DO/セッション不要。旧クライアントは `legacy: "stateless"` |
| 課金防止 | Cloudflare は Free の範囲で**エラー停止**、Vercel は**30 日停止**。R2/Images/Stream/Workers Paid を有効化しない | 予期しない課金は発生しない構成 |

**未解決・要判断**
- Catbox の商用承認（広告・寄付・有料機能の扱い）。寄付のみなら非商用と整理できるが、Catbox 規約の「revenue from merchandise or services sales」との関係は**運営者判断**が必要。
- Catbox の匿名ファイルは 2 年無アクセスで削除される。恒久保存が必須の添付は Cloudinary 有料 or ユーザーの GitHub へ誘導する設計が必要。
- D1 500 MB/DB のシャーディング方針（板/year）は設計フェーズで確定。
- Vercel Hobby の「非商用」判定（広告なし・寄付のみなら可）は法務確認推奨。

---

## 出典一覧

### 保存先
- Imgur API: <https://apidocs.imgur.com/>
- Imgur ToS: <https://imgur.com/tos>
- Imgur ToS 更新 FAQ: <https://help.imgur.com/hc/en-us/articles/26479362527771-Imgur-Terms-of-Service-Update>
- Imgur アップロード上限: <https://help.imgur.com/hc/en-us/articles/26511665959579-What-files-can-I-upload-Is-there-a-size-limit>
- Cloudinary 料金: <https://cloudinary.com/pricing>
- Cloudinary 請求/クレジット: <https://cloudinary.com/documentation/billing_and_plans>
- Cloudinary Free FAQ: <https://cloudinary.com/documentation/developer_onboarding_faq_free_plan>
- Cloudinary upload preset: <https://cloudinary.com/documentation/upload_presets>
- Cloudinary ToU: <https://cloudinary.com/tou>
- Catbox 本体: <https://catbox.moe/>
- Catbox API: <https://catbox.moe/tools.php>
- Catbox FAQ: <https://catbox.moe/faq.php>
- Catbox 規約/AUP: <https://catbox.moe/legal.php>
- Litterbox: <https://litterbox.catbox.moe/>
- ImgBB API: <https://api.imgbb.com/>
- ImgBB ToS: <https://imgbb.com/tos>
- freeimage.host API: <https://freeimage.host/api>
- 0x0.st 仕様/規約: <https://0x0.st/>（取得不可のためミラー: <https://github.com/doctorfree/cheat-sheets-plus/blob/main/www/0x0.st.md>）
- file.io: <https://www.file.io/>
- uguu: <https://uguu.se/>
- Gyazo 料金: <https://gyazo.com/pricing>

### GitHub
- 大きいファイル: <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>
- Git LFS 上限: <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage>
- Git LFS 課金: <https://docs.github.com/en/billing/concepts/product-billing/git-lfs>
- Releases: <https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases>
- Contents API: <https://docs.github.com/en/rest/repos/contents>
- Gists API: <https://docs.github.com/en/rest/gists/gists>
- レート制限: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- OAuth App vs GitHub App: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps>
- OAuth 認可/Device flow: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>
- OAuth スコープ: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps>
- OAuth App 作成: <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app>
- PAT: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>
- jsDelivr 仕様: <https://cdn.jsdelivr.net/gh/jsdelivr/jsdelivr/README.md>
- jsDelivr 規約: <https://raw.githubusercontent.com/jsdelivr/jsdelivr/master/Terms%20of%20Use.md>

### Cloudflare
- Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Workers pricing: <https://developers.cloudflare.com/workers/platform/pricing/>
- D1 limits: <https://developers.cloudflare.com/d1/platform/limits/>
- D1 pricing: <https://developers.cloudflare.com/d1/platform/pricing/>
- DO pricing: <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- DO limits: <https://developers.cloudflare.com/durable-objects/platform/limits/>
- DO WebSocket/Hibernation: <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Cron Triggers: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- Turnstile plans: <https://developers.cloudflare.com/turnstile/plans/>
- Queues limits: <https://developers.cloudflare.com/queues/platform/limits/>
- Queues pricing: <https://developers.cloudflare.com/queues/platform/pricing/>

### Vercel
- Hobby plan: <https://vercel.com/docs/plans/hobby>
- Limits: <https://vercel.com/docs/limits>
- Fair use / 商用定義: <https://vercel.com/docs/limits/fair-use-guidelines>

### MCP
- Transports (2026-07-28): <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports>
- Streamable HTTP: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- Changelog: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- Cloudflare MCP: <https://developers.cloudflare.com/agents/model-context-protocol/>
- Cloudflare transport: <https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/>
- Cloudflare handler API: <https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>
- Cloudflare remote MCP: <https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/>
- MCP SDK v2 移行: <https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/>
