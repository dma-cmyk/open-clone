-- 0617: プラグインのスレごとの共有値（storage:thread）。
--
-- manifest.threadState で宣言した key（tally / choice / entries）だけを API が受け付ける。
-- 1 人 1 回は主キー (plugin_id, thread_id, key, actor_key) で DB でも保証する:
--   actor_key = acct:<accountId>（ログイン済み） / dev:<deviceHash>（未ログイン）。
-- ip_hash は未ログインの水増し対策（同一 IP の actor 数の上限）にだけ使い、API では返さない。
-- actor_key・ip_hash はどちらも API 応答に含めない（`mine` だけを本人に返す）。

-- 人数カウンタ（1 人 1 回のオン/オフ）。on_flag=1 の件数が人数。
CREATE TABLE IF NOT EXISTS plugin_thread_tallies (
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  on_flag INTEGER NOT NULL DEFAULT 1 CHECK (on_flag IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, thread_id, key, actor_key)
);
CREATE INDEX IF NOT EXISTS idx_plugin_thread_tallies_count
  ON plugin_thread_tallies(plugin_id, thread_id, key, on_flag);
CREATE INDEX IF NOT EXISTS idx_plugin_thread_tallies_ip
  ON plugin_thread_tallies(plugin_id, thread_id, key, ip_hash);

-- スレのアンケート（1 人 1 票・選び直し可）。option_index は manifest.options の index。
CREATE TABLE IF NOT EXISTS plugin_thread_choices (
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  option_index INTEGER NOT NULL CHECK (option_index >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, thread_id, key, actor_key)
);
CREATE INDEX IF NOT EXISTS idx_plugin_thread_choices_count
  ON plugin_thread_choices(plugin_id, thread_id, key, option_index);
CREATE INDEX IF NOT EXISTS idx_plugin_thread_choices_ip
  ON plugin_thread_choices(plugin_id, thread_id, key, ip_hash);

-- 参加表明・一言リスト（追記）。表示名 label は作った時点のレス ID と同じ形式で固定する。
CREATE TABLE IF NOT EXISTS plugin_thread_entries (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_thread_entries_list
  ON plugin_thread_entries(plugin_id, thread_id, key, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_plugin_thread_entries_actor
  ON plugin_thread_entries(plugin_id, thread_id, key, actor_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_thread_entries_ip
  ON plugin_thread_entries(plugin_id, thread_id, key, ip_hash);