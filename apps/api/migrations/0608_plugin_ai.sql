-- 0607: プラグイン AI 連携（ai:complete / POST /v1/ai/complete）。
-- 日次上限（端末×プラグイン）と監査ログ。入力本文は保存せず、文字数だけを記録する。
CREATE TABLE plugin_ai_usage (
  plugin_id TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  day_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, identity_hash, day_start)
);
CREATE INDEX idx_plugin_ai_usage_day ON plugin_ai_usage(day_start);

CREATE TABLE plugin_ai_log (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT,
  scope TEXT,
  board_id INTEGER,
  account_id TEXT,
  device_hash TEXT,
  prompt_chars INTEGER NOT NULL,
  system_chars INTEGER NOT NULL,
  output_chars INTEGER,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'denied')),
  error_code TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_plugin_ai_log_plugin ON plugin_ai_log(plugin_id, created_at);
CREATE INDEX idx_plugin_ai_log_created ON plugin_ai_log(created_at);