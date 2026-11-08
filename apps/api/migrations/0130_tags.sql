-- 0130: WP1 ハッシュタグ（tags / thread_tags）

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE            -- 正規化済み（小文字・30 文字以内）
);

CREATE TABLE thread_tags (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, tag_id)
);
CREATE INDEX idx_thread_tags_tag ON thread_tags(tag_id, updated_at DESC);