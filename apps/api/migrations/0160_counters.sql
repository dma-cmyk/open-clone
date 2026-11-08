-- 0160: WP1 カウンタ・端末・ランキングスナップショット

-- 汎用カウンタ（人気検索語・総投稿数など）。Cron は SELECT + 少量書込のみ（DESIGN §3.3）。
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 端末（忍法帖レベル）。device_hash 単位。
CREATE TABLE devices (
  device_hash TEXT PRIMARY KEY,
  post_count INTEGER NOT NULL DEFAULT 0,
  ninja_lv INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- ランキング snapshot（Cron が 1 時間ごとに書く。同時接続最大値は RealtimeHub DO から取得）
CREATE TABLE ranking_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL CHECK (period IN ('hour', 'day', 'all')),
  board_id INTEGER,
  captured_at INTEGER NOT NULL,
  payload TEXT NOT NULL                -- {items:[{threadId,connections,posts,...}]}
);
CREATE INDEX idx_ranking_period ON ranking_snapshots(period, captured_at DESC);
CREATE INDEX idx_ranking_board ON ranking_snapshots(board_id, period, captured_at DESC);