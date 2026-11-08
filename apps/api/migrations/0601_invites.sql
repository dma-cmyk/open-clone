-- 0601: WP6 一回限りの就任キー（special_admin / board_staff）
-- 生キーは発行レスポンスでのみ返し、DB には SHA-256 ハッシュだけを保存する。

CREATE TABLE invites (
  id TEXT PRIMARY KEY,                  -- ULID
  kind TEXT NOT NULL CHECK (kind IN ('special_admin', 'board_staff')),
  key_hash TEXT NOT NULL UNIQUE,        -- SHA-256(生キー)
  issued_by TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,                         -- 就任した account_id
  revoked_at INTEGER,
  meta TEXT,                            -- JSON（note / boardId / level / accountId）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_invites_kind ON invites(kind, created_at);
CREATE INDEX idx_invites_expires ON invites(expires_at);
CREATE INDEX idx_invites_issued_by ON invites(issued_by);