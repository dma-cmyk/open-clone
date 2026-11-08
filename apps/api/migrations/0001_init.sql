-- 0001: WP0 共通テーブル（accounts / sessions / site_config / audit_log）
-- 以降のマイグレーションは自分の帯域（WORKPACKAGES §3.3）でのみ追加する。他の帯域のテーブルを ALTER しない。

-- アカウント。role はグローバルロールのみ（board スタッフは WP1 の board_staff）。
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                -- ULID
  name TEXT NOT NULL,
  email TEXT UNIQUE,                  -- NULL 可（匿名起点の昇格等）
  password_hash TEXT,                 -- PBKDF2-SHA256（iterations は shared/constants）
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'special_admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL         -- Unix seconds
);
CREATE INDEX idx_accounts_email ON accounts(email);

-- セッション。token_hash = SHA-256(session token)。30日スライディング。
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,        -- Unix seconds
  ua TEXT,
  created_at INTEGER NOT NULL,
  touched_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- サイト設定（key-value。value は JSON 文字列）
CREATE TABLE site_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 監査ログ（管理操作。AI 操作は WP5 の ai_audit）
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,                -- ULID
  actor_type TEXT NOT NULL CHECK (actor_type IN ('owner', 'special_admin', 'account', 'board_staff', 'system')),
  actor_id TEXT,                      -- account id 等（system の場合 NULL）
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,                        -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_type, actor_id);
