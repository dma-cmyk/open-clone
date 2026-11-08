-- 0150: WP1 通報（削除依頼）

CREATE TABLE reports (
  id TEXT PRIMARY KEY,                 -- ULID
  board_id INTEGER NOT NULL REFERENCES boards(id),
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  post_ids TEXT NOT NULL DEFAULT '[]', -- number[] JSON（解決済み post id）
  nums TEXT NOT NULL DEFAULT '',       -- 依頼時のレス指定（"1-3" 等）
  reason TEXT NOT NULL CHECK (reason IN ('abuse', 'spam', 'offtopic', 'adult', 'csam', 'illegal', 'other')),
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'resolved')),
  reporter_device_hash TEXT,
  reporter_ip_hash TEXT,
  reporter_account_id TEXT,
  handled_by TEXT,
  handled_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_status ON reports(status, created_at DESC);
CREATE INDEX idx_reports_board ON reports(board_id, status, created_at DESC);
CREATE INDEX idx_reports_thread ON reports(thread_id, created_at DESC);