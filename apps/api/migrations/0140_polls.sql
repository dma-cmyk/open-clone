-- 0140: WP1 投票（polls / poll_votes）。`[ank:10m:A,B,C]` 記法。

CREATE TABLE polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL UNIQUE REFERENCES posts(id),
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  options TEXT NOT NULL,               -- string[] JSON
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_polls_thread ON polls(thread_id);

-- 1 IP 1 票（identity_hash = ip_hash）
CREATE TABLE poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id),
  identity_hash TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, identity_hash)
);