-- 0120: WP1 レス（posts / posts_fts / backlinks / post_reactions）

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  board_id INTEGER NOT NULL REFERENCES boards(id),
  num INTEGER NOT NULL,                     -- スレ内レス番号（kome は 0）
  title TEXT,                               -- >>1 のみ（FTS の対象）
  name TEXT NOT NULL,
  mail TEXT NOT NULL DEFAULT '',
  trip TEXT,
  cap TEXT,
  body TEXT NOT NULL,
  sage INTEGER NOT NULL DEFAULT 0,
  post_id_hash TEXT NOT NULL,               -- 表示ID（no_id 時 "???"）
  device_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  ninja_lv INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'kome')),
  parent_post_id INTEGER,
  attachments TEXT,                         -- AttachmentSummary[] JSON（本体は外部保存・WP4）
  hashtags TEXT,                            -- string[] JSON
  ai_agent_id TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_posts_thread_num ON posts(thread_id, num) WHERE kind = 'post';
CREATE INDEX idx_posts_thread ON posts(thread_id, id);
CREATE INDEX idx_posts_board_created ON posts(board_id, created_at DESC);
CREATE INDEX idx_posts_id_hash ON posts(board_id, post_id_hash, created_at);
CREATE INDEX idx_posts_device ON posts(device_hash, created_at);
CREATE INDEX idx_posts_parent ON posts(parent_post_id);

-- 全文検索（外部コンテンツ方式: 本文を二重保存しない。DELETE は posts 側のフラグで除外）
CREATE VIRTUAL TABLE posts_fts USING fts5(
  body,
  name,
  title,
  content='posts',
  content_rowid='id',
  tokenize='trigram'
);

-- 安価の逆参照（どのレスがどのレスを参照したか）
CREATE TABLE backlinks (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  target_post_id INTEGER NOT NULL REFERENCES posts(id),
  target_num INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, target_post_id)
);
CREATE INDEX idx_backlinks_target ON backlinks(target_post_id);

-- レス評価（いいね）
CREATE TABLE post_reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  identity_hash TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'like' CHECK (kind IN ('like', 'good', 'bad')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, identity_hash, kind)
);
CREATE INDEX idx_post_reactions_count ON post_reactions(post_id, kind);