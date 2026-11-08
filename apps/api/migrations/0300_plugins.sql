-- 0300: WP3 プラグイン（レジストリ・版・導入・共有状態・審査・通報・net 監査）
-- 帯域 0300–0399 はこのドメイン専用（WORKPACKAGES §3.3）。他の帯域のテーブルは変更しない。

-- プラグインレジストリ本体。manifest の最新値を denormalize して検索を速くする。
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,                         -- ULID
  owner_account_id TEXT REFERENCES accounts(id),
  name TEXT NOT NULL UNIQUE,                   -- slug（manifest.name と一致）
  summary TEXT NOT NULL DEFAULT '',
  description TEXT,
  manifest_json TEXT NOT NULL,                 -- 最新 manifest（JSON）
  scopes TEXT NOT NULL DEFAULT '',             -- 例 "personal,site"（検索用）
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'published', 'rejected', 'disabled')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  latest_version TEXT,
  source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'gist', 'github')),
  source_ref TEXT,                             -- JSON: {type,id,url,repo,path,branch}
  install_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  license TEXT,
  -- 停止（キル）伝播用。増加したらホストは実行中インスタンスを破棄する。
  kill_seq INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX idx_plugins_listing ON plugins(status, visibility, updated_at DESC);
CREATE INDEX idx_plugins_owner ON plugins(owner_account_id, updated_at DESC);
CREATE INDEX idx_plugins_popular ON plugins(status, visibility, install_count DESC);
CREATE INDEX idx_plugins_source ON plugins(source, updated_at DESC);

-- 版。コードは不変（version 単位でキャッシュ）。承認後に配信可能。
CREATE TABLE plugin_versions (
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  code TEXT NOT NULL,
  code_hash TEXT NOT NULL,                     -- SHA-256 hex（ETag / 不変キャッシュ）
  manifest_json TEXT NOT NULL,
  changelog TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  created_by TEXT REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version)
);
CREATE INDEX idx_plugin_versions_status ON plugin_versions(plugin_id, status, created_at DESC);

-- 導入（適用範囲）。personal は account または端末（匿名）、board は板、site は全体。
CREATE TABLE plugin_installs (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'board', 'site')),
  scope_ref TEXT NOT NULL,                     -- account id / device hash / board id / 'site'
  version TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  installed_by TEXT,                           -- account id / device hash（監査用）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (plugin_id, scope, scope_ref)
);
CREATE INDEX idx_plugin_installs_scope ON plugin_installs(scope, scope_ref, enabled);
CREATE INDEX idx_plugin_installs_plugin ON plugin_installs(plugin_id);

-- プラグイン共有 KV（storage:shared）。scope ごとに 64KB 上限（アプリ側で強制）。
CREATE TABLE plugin_state (
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'board', 'site')),
  scope_ref TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, scope, scope_ref, key)
);
CREATE INDEX idx_plugin_state_scope ON plugin_state(scope, scope_ref, plugin_id);

-- 審査（site=承認キュー / board=板管理人の導入承認）。
CREATE TABLE plugin_reviews (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('board', 'site')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('human', 'ai', 'system')),
  reviewer_id TEXT,
  note TEXT,
  static_result_json TEXT,                     -- runStaticChecks の結果
  risk_level TEXT CHECK (risk_level IN ('low', 'medium', 'high')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_plugin_reviews_queue ON plugin_reviews(status, scope, created_at);
CREATE INDEX idx_plugin_reviews_plugin ON plugin_reviews(plugin_id, version, scope);
CREATE UNIQUE INDEX idx_plugin_reviews_unique ON plugin_reviews(plugin_id, version, scope);

-- 通報。同一通報者・同一プラグインの重複は 24h で 1 件に制限（アプリ側）。
CREATE TABLE plugin_reports (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES plugins(id),
  version TEXT,
  reporter_kind TEXT NOT NULL CHECK (reporter_kind IN ('account', 'device')),
  reporter_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('malicious', 'spam', 'broken', 'inappropriate', 'other')),
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  handled_by TEXT,
  handled_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_plugin_reports_plugin ON plugin_reports(plugin_id, created_at DESC);
CREATE INDEX idx_plugin_reports_status ON plugin_reports(status, created_at);

-- net:fetch プロキシの監査ログ（DESIGN §7.1: 全呼び出しを監査）。
CREATE TABLE plugin_net_log (
  id TEXT PRIMARY KEY,
  plugin_id TEXT,
  version TEXT,
  install_id TEXT,
  scope TEXT,
  account_id TEXT,
  device_hash TEXT,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER,
  bytes INTEGER,
  allowed INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_plugin_net_log_plugin ON plugin_net_log(plugin_id, created_at DESC);
CREATE INDEX idx_plugin_net_log_caller ON plugin_net_log(device_hash, created_at DESC);