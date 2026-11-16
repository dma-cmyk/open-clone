-- 0613: 端末所有プラグイン（匿名でのプラグイン作成・報告40 設計）。
-- plugins に owner_device_hash を追加する。owner_account_id と排他（アプリ側で強制）。
--
-- 重要: owner_account_id IS NULL はこれまで「公式（運営）」を意味していた（0612 seed など）。
-- この変更後は「公式 = owner_account_id も owner_device_hash も NULL」であり、
-- owner_device_hash が非 NULL の行は端末所有（匿名作成）を表す。
--
-- ALTER TABLE ADD COLUMN で CHECK 制約は付けられないため、排他はアプリ層で強制する。
ALTER TABLE plugins ADD COLUMN owner_device_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_plugins_owner_device ON plugins(owner_device_hash);
