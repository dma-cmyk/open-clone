-- パスワードを忘れたときの復旧（報告書 50 設計）。
--
-- 1) 運営（所有者）が発行する 1 回限りの再設定 URL（password_reset_tokens）。
--    生トークンは発行時にのみ返し、DB には SHA-256 ハッシュだけを保存する（invites と同じ作り）。
--    同一アカウントの未使用トークンは発行時に失効させる（used_at / revoked_at）。
--
-- 2) パスワード再設定の短期試行記録（auth_password_reset_attempts）。
--    対象アカウント（存在しないメールはダミーの識別子）単位の失敗を数える。
--    ログインの「IP + メール」窓（auth_attempts）とは別の鍵で、1 人のアカウントへの
--    総当たりを IP を変えても抑える。auth_attempts.kind の CHECK 制約を拡張せずに済むよう別表にする。
--    鍵は auth_attempts と同じく HMAC(ID_SALT, ...) で、生のメールは保存しない。

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,                  -- ULID
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256(生トークン)
  issued_by TEXT NOT NULL,              -- 発行した所有者のアカウント ID
  expires_at INTEGER NOT NULL,          -- Unix 秒（発行から 24 時間）
  used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_account
  ON password_reset_tokens(account_id, used_at, revoked_at);

CREATE TABLE IF NOT EXISTS auth_password_reset_attempts (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,               -- HMAC(ID_SALT, "<ipHash>|pwreset|<対象>")
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_password_reset_attempts_key
  ON auth_password_reset_attempts(key_hash, created_at);

-- ログイン・登録・再設定の照合は lower(email) で行う（レビュー 53 の minor 1 → 55）。式索引で全件走査を避ける。
CREATE INDEX IF NOT EXISTS idx_accounts_email_lower ON accounts(lower(email));
