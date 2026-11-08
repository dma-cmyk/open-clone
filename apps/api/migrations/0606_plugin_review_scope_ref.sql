-- 板インストール承認のレビュー行を板ごとに分離する（M-3）。
-- 旧 UNIQUE(plugin_id, version, scope) では scope='board' の行が板をまたいで 1 件しか
-- 存在できず、別の板のインストールが前の板の承認行を上書きしていた。
-- scope_ref は site では ''、board では 'board:<id>'。site の一意性は維持される。
ALTER TABLE plugin_reviews ADD COLUMN scope_ref TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_plugin_reviews_unique;
CREATE UNIQUE INDEX idx_plugin_reviews_unique
  ON plugin_reviews(plugin_id, version, scope, scope_ref);