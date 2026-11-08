-- 0602: WP6 アカウント/端末の規制（停止・アクセス禁止）
-- site スコープの停止は accounts.status='suspended' と連動し、セッションを失効させる。
-- board スコープは板単位のアクセス禁止（WP1 の board_bans とは別管理・管理者用）。

CREATE TABLE suspensions (
  id TEXT PRIMARY KEY,                  -- ULID
  account_id TEXT,
  email TEXT,                           -- 未登録ユーザーのメール指定停止
  device_hash TEXT,                     -- 端末単位の停止（DEVICE_COOKIE の HMAC）
  scope TEXT NOT NULL CHECK (scope IN ('site', 'board')),
  board_id INTEGER,
  reason TEXT NOT NULL,
  by TEXT NOT NULL,                     -- 実行者 account_id
  expires_at INTEGER,                   -- NULL = 無期限
  lifted_at INTEGER,                    -- 解除時刻（NULL = 有効）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_suspensions_account ON suspensions(account_id, lifted_at);
CREATE INDEX idx_suspensions_device ON suspensions(device_hash, lifted_at);
CREATE INDEX idx_suspensions_email ON suspensions(email, lifted_at);
CREATE INDEX idx_suspensions_scope ON suspensions(scope, board_id, lifted_at);
CREATE INDEX idx_suspensions_created ON suspensions(created_at);