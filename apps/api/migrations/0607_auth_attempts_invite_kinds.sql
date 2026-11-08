-- 就任キー総当たり対策の試行種別を追加（H-1）。
-- auth_attempts.kind の CHECK 制約を拡張するため、テーブルを再作成する。
DROP INDEX IF EXISTS idx_auth_attempts_key;
DROP INDEX IF EXISTS idx_auth_attempts_created;
ALTER TABLE auth_attempts RENAME TO auth_attempts_old;

CREATE TABLE auth_attempts (
  id TEXT PRIMARY KEY,                  -- ULID
  kind TEXT NOT NULL CHECK (kind IN (
    'login_failed', 'login_ok', 'register', 'totp_failed',
    'invite_failed', 'invite_prepare'
  )),
  key_hash TEXT NOT NULL,               -- HMAC(ID_SALT, "<ipHash>|<email 正規化>" 等)
  account_id TEXT,
  created_at INTEGER NOT NULL
);
INSERT INTO auth_attempts (id, kind, key_hash, account_id, created_at)
  SELECT id, kind, key_hash, account_id, created_at FROM auth_attempts_old;
DROP TABLE auth_attempts_old;

CREATE INDEX idx_auth_attempts_key ON auth_attempts(key_hash, created_at);
CREATE INDEX idx_auth_attempts_created ON auth_attempts(created_at);