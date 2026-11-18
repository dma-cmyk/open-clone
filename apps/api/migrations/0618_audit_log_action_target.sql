-- 0618: 管理画面「非表示のレス」のした人・日時を引くための索引。
--
-- 一覧 API は表示するページ（最大 100 件）の post id 群について
-- `audit_log` から post.hide / post.restore を引く。既存の索引は created_at と actor だけで、
-- action + target の組み合わせは全走査になる。監査ログは消さない方針のため、
-- 管理画面を開くたびの全走査を避ける索引を足す（スキーマ・データは変えない）。

CREATE INDEX IF NOT EXISTS idx_audit_log_action_target ON audit_log(action, target);