-- ロボット確認（Turnstile）の省略（報告書 81）。
-- 一度確認に成功した端末（device_hash）と板の組に「確認済みの期限」を持たせる。
-- Cookie だけに持たせると改ざんできるため、サーバー（D1）に保存する。
-- device_hash は HMAC(ID_SALT, oc_did Cookie) で、クライアントが任意の値を作れない。
-- IP は参考記録のみ（モバイル回線で IP が変わっても確認をやり直させない）。

CREATE TABLE IF NOT EXISTS turnstile_passes (
  device_hash TEXT NOT NULL,
  board_id INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_hash TEXT,
  PRIMARY KEY (device_hash, board_id)
);

CREATE INDEX IF NOT EXISTS idx_turnstile_passes_expires ON turnstile_passes(expires_at);
