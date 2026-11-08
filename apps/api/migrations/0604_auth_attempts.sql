-- 0604: WP6 ログイン試行の記録（IP+メール毎の失敗回数・登録回数のレート制限）
-- 監査ログとは別に、短期間の自動判定にのみ使う。生 IP・生メールは保存せず HMAC ハッシュのみ。

CREATE TABLE auth_attempts (
  id TEXT PRIMARY KEY,                  -- ULID
  kind TEXT NOT NULL CHECK (kind IN ('login_failed', 'login_ok', 'register', 'totp_failed')),
  key_hash TEXT NOT NULL,               -- HMAC(ID_SALT, "<ipHash>|<email 正規化>" 等)
  account_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_attempts_key ON auth_attempts(key_hash, created_at);
CREATE INDEX idx_auth_attempts_created ON auth_attempts(created_at);