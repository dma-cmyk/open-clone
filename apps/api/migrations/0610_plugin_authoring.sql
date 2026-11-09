-- 0610: プラグイン作成支援（個人用トークン + トークン利用の上限・監査）
-- 正本: 報告書28 §7.1。既存テーブルの ALTER は無し（plugins 等には触れない）。
CREATE TABLE plugin_author_tokens (
  id TEXT PRIMARY KEY,                          -- ULID
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,                           -- 利用者の識別名（1〜100）
  token_hash TEXT NOT NULL UNIQUE,              -- SHA-256(token)
  token_prefix TEXT NOT NULL,                   -- 表示用（ocp_xxxxxxxx）
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at INTEGER NOT NULL,                  -- 発行 + 90 日
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_plugin_author_tokens_account ON plugin_author_tokens(account_id, status);
CREATE INDEX idx_plugin_author_tokens_expiry ON plugin_author_tokens(expires_at);

-- 日次上限カウンタ（plugin_ai_usage パターン。kind: create/version/check/publish）
CREATE TABLE plugin_author_usage (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create','version','check','publish')),
  day_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind, day_start)
);
CREATE INDEX idx_plugin_author_usage_day ON plugin_author_usage(day_start);

-- トークン経路の監査（コード全文は保存しない）
CREATE TABLE plugin_author_audit (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  plugin_id TEXT,
  version TEXT,
  params_digest TEXT,
  params_summary TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok','denied','error','rate_limited')),
  error_code TEXT,
  ip_hash TEXT,
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_plugin_author_audit_account ON plugin_author_audit(account_id, created_at);
CREATE INDEX idx_plugin_author_audit_created ON plugin_author_audit(created_at);