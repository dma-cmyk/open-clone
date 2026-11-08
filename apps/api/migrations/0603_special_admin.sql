-- 0603: WP6 特別管理人の権限停止・復旧の状態
-- role は accounts.role に保持したまま、停止フラグで管理 API を拒否する（所有者が復旧可能）。

CREATE TABLE special_admin_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  stopped_at INTEGER,                   -- NULL = 稼働中
  stopped_by TEXT,                      -- 実行者の account_id（owner）
  reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE account_profiles (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  bio TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- サイト所有者は常に 1 人（同時ブートストラップの競合を DB 制約で防ぐ）
CREATE UNIQUE INDEX idx_accounts_single_owner ON accounts(role) WHERE role = 'owner';