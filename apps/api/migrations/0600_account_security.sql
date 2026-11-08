-- 0600: WP6 アカウントセキュリティ（TOTP・リカバリーコード・step-up 付与）
-- TOTP secret は AES-GCM で暗号化して保存する（平文・鍵は保存しない）。
-- リカバリーコードは SHA-256 ハッシュのみ保存し、使用は単回。

CREATE TABLE account_totp (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  secret_enc TEXT NOT NULL,             -- AES-GCM 暗号文（v1.iv.cipher 形式）
  verified INTEGER NOT NULL DEFAULT 0,  -- 1 = 本人がコードで検証済み（ログインで要求）
  required INTEGER NOT NULL DEFAULT 0,  -- 1 = TOTP 必須（special_admin は常に 1）
  enabled_at INTEGER,                   -- 検証成功した Unix 秒
  last_used_at INTEGER,                 -- 最後に TOTP を消費した Unix 秒（リプレイ防止用の記録）
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,                 -- TOTP ロック解除時刻（Unix 秒）
  pending_expires_at INTEGER,           -- 未検証 secret の有効期限（Unix 秒）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_account_totp_locked ON account_totp(locked_until);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,                  -- ULID
  account_id TEXT NOT NULL REFERENCES accounts(id),
  code_hash TEXT NOT NULL,              -- SHA-256(normalized code)
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_recovery_codes_account ON recovery_codes(account_id, used_at);
CREATE UNIQUE INDEX idx_recovery_codes_hash ON recovery_codes(account_id, code_hash);

-- 高リスク操作の再認証（TOTP/リカバリーコードで付与。セッション単位・短命）
CREATE TABLE session_stepup (
  token_hash TEXT PRIMARY KEY,          -- sessions.token_hash
  account_id TEXT NOT NULL REFERENCES accounts(id),
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_session_stepup_account ON session_stepup(account_id);