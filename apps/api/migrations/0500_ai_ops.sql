-- 0500: WP5 AI 運営（ai_agents / ai_policies / ai_queue / ai_audit / webhooks / webhook_deliveries
--      + WP5 内部用: ai_rate_counters / ai_report_triage / ai_metrics / ai_state）
-- 帯域: WORKPACKAGES §3.3（0500–0599）。他の帯域のテーブルは ALTER しない。
-- 時刻はすべて Unix seconds（INTEGER）。

-- AI 管理者。API キーは SHA-256 ハッシュのみ保存し、平文は発行時に一度だけ返す。
CREATE TABLE ai_agents (
  id TEXT PRIMARY KEY,                                     -- ULID
  name TEXT NOT NULL,
  description TEXT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('site', 'board', 'account')),
  owner_id TEXT NOT NULL,                                  -- account id / board id / 'site'
  board_id INTEGER,                                        -- owner_type='board' の板
  allowed_boards TEXT NOT NULL DEFAULT '[]',               -- JSON: [1,2] または "*"
  risk_cap TEXT NOT NULL DEFAULT 'low' CHECK (risk_cap IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  suspended_reason TEXT,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
  daily_limit INTEGER NOT NULL DEFAULT 2000,
  display_name TEXT NOT NULL DEFAULT 'AI運営',
  key_hash TEXT NOT NULL UNIQUE,                           -- SHA-256(api key)
  key_prefix TEXT NOT NULL,                                -- 表示用（ocai_xxxxxxxx）
  key_rotated_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_ai_agents_owner ON ai_agents(owner_type, owner_id);
CREATE INDEX idx_ai_agents_board ON ai_agents(board_id);
CREATE INDEX idx_ai_agents_prefix ON ai_agents(key_prefix);
CREATE INDEX idx_ai_agents_status ON ai_agents(status);

-- 政策（mode 解決順: agent 固有 > board 固有 > site 既定 > risk 既定表）。
-- action は完全一致。'*' は全 action の既定として使用する。
CREATE TABLE ai_policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('site', 'board', 'agent')),
  scope_id TEXT NOT NULL,                                  -- 'site' / board id / agent id
  action TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('auto', 'queue', 'deny')),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (scope, scope_id, action)
);
CREATE INDEX idx_ai_policies_scope ON ai_policies(scope, scope_id);

-- 承認キュー。high リスクは常にここを経由する（72h で失効）。
CREATE TABLE ai_queue (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  params TEXT NOT NULL,                                    -- JSON
  risk TEXT NOT NULL,
  board_id INTEGER,
  summary TEXT NOT NULL,
  evidence TEXT,                                           -- JSON（投稿原文・通報理由など）
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
  idempotency_key TEXT,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decided_by_role TEXT,
  note TEXT,
  executed_at INTEGER,
  result TEXT,                                             -- JSON
  error TEXT,
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX idx_ai_queue_status ON ai_queue(status, expires_at);
CREATE INDEX idx_ai_queue_agent ON ai_queue(agent_id, requested_at);
CREATE INDEX idx_ai_queue_board ON ai_queue(board_id, status);
CREATE INDEX idx_ai_queue_requested ON ai_queue(requested_at);

-- 監査ログ（全 AI 呼び出し・人間の承認/却下/停止を記録）。
CREATE TABLE ai_audit (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('agent', 'human', 'system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  risk TEXT NOT NULL,
  mode TEXT NOT NULL,
  board_id INTEGER,
  params_digest TEXT,
  params_summary TEXT,
  queue_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('ok', 'queued', 'denied', 'error', 'rate_limited', 'stopped')),
  error_code TEXT,
  ip_hash TEXT,
  request_id TEXT,
  source TEXT,                                             -- 'rest' | 'mcp' | 'cron' | 'admin'
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_audit_agent ON ai_audit(agent_id, created_at);
CREATE INDEX idx_ai_audit_created ON ai_audit(created_at);
CREATE INDEX idx_ai_audit_action ON ai_audit(action, created_at);
CREATE INDEX idx_ai_audit_result ON ai_audit(result, created_at);
CREATE INDEX idx_ai_audit_queue ON ai_audit(queue_id);

-- Webhook（out）。secret は AES-GCM(ENC_KEY) で暗号化して保存する。
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('site', 'board', 'account')),
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,                                    -- JSON array
  secret_enc TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_status INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_webhooks_owner ON webhooks(owner_type, owner_id);
CREATE INDEX idx_webhooks_active ON webhooks(active);

-- 配信履歴。next_attempt_at が未来の pending 行を cron（20 * * * *）が再送する。
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  response_status INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);

-- WP5 内部: レート/日次上限カウンタ（1 action = upsert 2 行）。
CREATE TABLE ai_rate_counters (
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('minute', 'day')),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (agent_id, kind, window_start)
);

-- WP5 内部: 通報トリアージ（WP1 の reports を AI が解釈した結果。原文は reports 側が正）。
CREATE TABLE ai_report_triage (
  report_id TEXT PRIMARY KEY,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  verdict TEXT CHECK (verdict IN ('actionable', 'invalid', 'duplicate')),
  note TEXT,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_report_triage_priority ON ai_report_triage(priority, updated_at);

-- WP5 内部: 異常検知メトリクス（Cron 10 分毎に集計・判定）。
CREATE TABLE ai_metrics (
  id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL,                                      -- 'post_rate' | 'report_rate' | 'error_rate' | 'action_repeat' | 'queue_reject'
  value INTEGER NOT NULL,
  threshold INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_metrics_window ON ai_metrics(window_start, kind);
CREATE INDEX idx_ai_metrics_agent ON ai_metrics(agent_id, kind, window_start);

-- WP5 内部: サイト設定の AI 閾値・最終実行時刻など（key-value JSON）。
CREATE TABLE ai_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);