-- 0100: WP1 板（boards / board_staff / board_bans）
-- 帯域 0100–0299 はこのドメイン専有（WORKPACKAGES §3.3）。他の帯域のテーブルは ALTER しない。

CREATE TABLE boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '雑談',
  description TEXT NOT NULL DEFAULT '',
  rules_md TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL DEFAULT '{}',      -- BoardDesign JSON
  settings TEXT NOT NULL DEFAULT '{}',    -- BoardSettings JSON
  owner_account_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  last_post_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_boards_category ON boards(status, category);
CREATE INDEX idx_boards_last_post ON boards(status, last_post_at DESC);
CREATE INDEX idx_boards_owner ON boards(owner_account_id);

-- 板スタッフ（admin = 板管理人 / deputy = 副管理人 / moderator = モデレーター）
CREATE TABLE board_staff (
  board_id INTEGER NOT NULL REFERENCES boards(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  level TEXT NOT NULL CHECK (level IN ('admin', 'deputy', 'moderator')),
  by_account_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, account_id)
);
CREATE INDEX idx_board_staff_account ON board_staff(account_id);
CREATE INDEX idx_board_staff_board ON board_staff(board_id, level);

-- アク禁（board_id NULL = サイト全体）。identity_hash は device_hash / ip_hash / account id。
CREATE TABLE board_bans (
  id TEXT PRIMARY KEY,
  board_id INTEGER,
  identity_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('device', 'ip', 'account')),
  reason TEXT NOT NULL DEFAULT '',
  by_account_id TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_board_bans_lookup ON board_bans(board_id, identity_hash, kind);
CREATE INDEX idx_board_bans_expires ON board_bans(expires_at);