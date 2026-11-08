-- 0400: WP4（GitHub 連携 + アップローダ）テーブル。
-- 添付ファイルの本体は一切保存しない（URL とメタデータのみ。R2/KV/DO 不使用）。DESIGN §9.1。

-- アップローダ設定（サイト既定・板ごとの上書き。秘密は「変数名」だけを config に持つ）
CREATE TABLE uploader_adapters (
  id TEXT PRIMARY KEY,                 -- 'catbox' | 'cloudinary' | 'gist' | ... | プラグイン登録 ID
  kind TEXT NOT NULL,                  -- 実装の種類（組み込みは id と同一、プラグインは 'declarative' 等）
  enabled INTEGER NOT NULL DEFAULT 1,
  -- config JSON: { cloudName?: string, folder?: string, baseUrl?: string, ... }
  -- API キー等の実体は環境変数/secret に置き、config には参照名のみを書く。
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

-- 添付メタデータ。本体は外部サービスの URL を指すだけ。
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,                 -- ULID
  post_id INTEGER,                     -- 未紐付けは NULL（WP1 の attachToPost が更新）
  uploader_account_id TEXT,            -- 匿名は NULL
  device_hash TEXT NOT NULL,           -- HMAC(ID_SALT, device)。履歴・削除権限の判定に使う
  board_id INTEGER,
  adapter TEXT NOT NULL,
  external_url TEXT NOT NULL,
  delete_url TEXT,                     -- 外部サービスが削除トークンを返した場合のみ
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'text', 'file')),
  meta TEXT,                           -- JSON（サービス固有。raw_url 等）
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dead', 'deleted')),
  last_verified_at INTEGER,
  expires_at INTEGER,                  -- Litterbox 等の期限付きアップロード
  ticket_id TEXT,                      -- commit の冪等性キー（prepare の ticket）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_post ON attachments(post_id);
CREATE UNIQUE INDEX idx_attachments_ticket ON attachments(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_attachments_device ON attachments(device_hash, created_at DESC);
CREATE INDEX idx_attachments_account ON attachments(uploader_account_id, created_at DESC);
CREATE INDEX idx_attachments_verify ON attachments(status, last_verified_at);

-- アップロード許可証（prepare → proxy/commit の一回限りの対応付け）。
-- ファイル本体は保存せず、許可した内容のメタデータだけを保持する。
CREATE TABLE upload_tickets (
  id TEXT PRIMARY KEY,                 -- ULID（公開する ticketId）
  token_hash TEXT NOT NULL UNIQUE,     -- SHA-256(proxy token)
  adapter_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'proxy-stream')),
  device_hash TEXT NOT NULL,
  account_id TEXT,
  board_id INTEGER,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'used', 'committed', 'expired')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  -- proxy-stream 完了時の外部サービス応答（URL とメタのみ。本体は保存しない）
  result_url TEXT,
  result_delete_url TEXT,
  result_meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_upload_tickets_device ON upload_tickets(device_hash, created_at DESC);
CREATE INDEX idx_upload_tickets_expiry ON upload_tickets(status, expires_at);

-- GitHub 連携。トークンは AES-256-GCM（ENC_KEY）で暗号化した文字列のみ。
CREATE TABLE github_links (
  account_id TEXT PRIMARY KEY,
  github_user TEXT NOT NULL,
  github_user_id INTEGER,
  avatar_url TEXT,
  token_enc TEXT NOT NULL,             -- v1:<iv b64>:<ciphertext+tag b64>
  scopes TEXT NOT NULL DEFAULT '',     -- 空白区切り（x-oauth-scopes）
  method TEXT NOT NULL DEFAULT 'oauth' CHECK (method IN ('oauth', 'pat')),
  rate_limit INTEGER,
  rate_remaining INTEGER,
  rate_reset INTEGER,
  rate_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- GitHub 操作の監査ログ（本人のリソースのみ・レート確認付きの根拠を残す）
CREATE TABLE github_ops_log (
  id TEXT PRIMARY KEY,                 -- ULID
  account_id TEXT,
  op TEXT NOT NULL,                    -- 'gist.create' | 'repo.put' | 'oauth.callback' 等
  ref TEXT,                            -- gist id / owner/repo/path 等
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'blocked')),
  detail TEXT,                         -- JSON（エラー種別・レート残等）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_github_ops_log_account ON github_ops_log(account_id, created_at DESC);
CREATE INDEX idx_github_ops_log_created ON github_ops_log(created_at);

-- GitHub webhook 受信の重複排除（X-GitHub-Delivery）。運営側 GitHub App 用（任意）。
CREATE TABLE github_webhook_events (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  action TEXT,
  payload_digest TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_github_webhook_events_created ON github_webhook_events(created_at);
