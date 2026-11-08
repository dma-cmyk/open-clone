-- 0110: WP1 スレッド（threads / thread_state / thread_subs）

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id),
  title TEXT NOT NULL,
  title_flags TEXT NOT NULL DEFAULT '{}',   -- ThreadTitleFlags JSON
  owner_device_hash TEXT,
  owner_account_id TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  post_count INTEGER NOT NULL DEFAULT 0,    -- >>1 を含む（kind='post' のみ）
  max_posts INTEGER NOT NULL DEFAULT 1000,
  last_post_at INTEGER NOT NULL,
  bump_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'deleted')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_threads_board_bump ON threads(board_id, status, bump_at DESC);
CREATE INDEX idx_threads_board_created ON threads(board_id, status, created_at DESC);
CREATE INDEX idx_threads_board_posts ON threads(board_id, status, post_count DESC);
CREATE INDEX idx_threads_last_post ON threads(status, last_post_at);
CREATE INDEX idx_threads_owner ON threads(owner_device_hash);

-- スレ主自治の状態（JSON）。1 スレ 1 行。
CREATE TABLE thread_state (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id),
  state TEXT NOT NULL DEFAULT '{}',         -- ThreadState JSON
  updated_at INTEGER NOT NULL
);

-- 副主（`!sub` で任命）。identity_hash は端末ハッシュ。
CREATE TABLE thread_subs (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  identity_hash TEXT NOT NULL,
  account_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, identity_hash)
);