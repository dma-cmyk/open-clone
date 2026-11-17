-- E2E/統合テスト用のシードデータ（本番には適用しない）。
-- e2e/scripts/start-api.sh が migrations apply 後に自動実行する（冪等）。
-- schema は各 WP のマイグレーションを参照。ここには WP0 の共通テーブルのみを投入する。
-- 板・スレ等のドメインデータは各 spec が API 経由で作る（WP 間のスキーマ変更に追従するため）。

-- デモ用アカウント（パスワードハッシュは NULL。パスワードログインは不可）
INSERT OR IGNORE INTO accounts (id, name, email, password_hash, role, status, created_at)
VALUES
  ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'owner', NULL, NULL, 'owner', 'active', 1760000000),
  ('01ARZ3NDEKTSV4RRFFQ69G5FAW', 'test-user', 'test@example.com', NULL, 'user', 'active', 1760000000),
  -- サイトツアーの権限別検証用（新規登録の 5 回/日/IP 上限を他 spec と取り合わないよう固定で用意）
  ('01ARZ3NDEKTSV4RRFFQ69G5FB0', 'trev-deputy', NULL, NULL, 'user', 'active', 1760000000),
  ('01ARZ3NDEKTSV4RRFFQ69G5FB1', 'trev-moderator', NULL, NULL, 'user', 'active', 1760000000),
  ('01ARZ3NDEKTSV4RRFFQ69G5FB2', '長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長長', NULL, NULL, 'user', 'active', 1760000000),
  -- パスワード再設定 URL の E2E 用（pc/mobile でアカウントを分ける。登録上限 5 回/日/IP を消費しない）。
  -- パスワードは NULL から再設定で付く（この DB は使い捨て）。
  ('01ARZ3NDEKTSV4RRFFQ69G5FC0', 'pwreset-operator-pc', 'pwreset-op-pc@example.com', NULL, 'user', 'active', 1760000000),
  ('01ARZ3NDEKTSV4RRFFQ69G5FC1', 'pwreset-operator-mobile', 'pwreset-op-mobile@example.com', NULL, 'user', 'active', 1760000000);

-- サイト設定の初期値
INSERT OR IGNORE INTO site_config (key, value) VALUES
  ('site_name', '"おーぷんクローン"'),
  -- E2E は 1 回の実行で複数 spec が同じ owner アカウントで板を作る（後始末しない spec もある）。
  -- 既定の 5 件だと 2 回目以降の実行が 409 CONFLICT で落ちるため、E2E 専用 DB では上限を緩める。
  ('max_boards_per_account', '1000'),
  ('board_auto_delete_days', '7'),
  ('default_turnstile_required', 'false'),
  ('upload_adapter_default', '"catbox"');

-- 前回実行から残っている DB（INSERT OR IGNORE では更新されない）でも上限を確実に緩める。
INSERT OR REPLACE INTO site_config (key, value) VALUES ('max_boards_per_account', '1000');

-- E2E 専用の固定セッション（token は既知のため、この DB を本番に使ってはならない）。
-- Cookie: oc_sess=e2e-owner-session-token / oc_sess=e2e-user-session-token
-- token_hash = SHA-256(token)（CONTRACTS §3.2 / DESIGN §5.1）。
-- expires_at は 2100-01-01（テスト中の期限切れを避ける）。
INSERT OR IGNORE INTO sessions (token_hash, account_id, expires_at, ua, created_at, touched_at)
VALUES
  ('a4768801965d434ca3e6c8a107a4936948c4fee8914374d98ecab97e91286e54',
   '01ARZ3NDEKTSV4RRFFQ69G5FAV', 4102444800, 'e2e-owner', 1760000000, 1760000000),
  ('f8b4041e0522cee5c7bd2f6bd1667acd457ad5467b1398d70042600b085b41d4',
   '01ARZ3NDEKTSV4RRFFQ69G5FAW', 4102444800, 'e2e-user', 1760000000, 1760000000),
  -- oc_sess=e2e-tour-deputy-session-token / e2e-tour-moderator-session-token / e2e-tour-longname-session-token
  ('7665350ef18b742554950bffe2ce46dd11c52f729d7b254915fccf5009f892fe',
   '01ARZ3NDEKTSV4RRFFQ69G5FB0', 4102444800, 'e2e-tour-deputy', 1760000000, 1760000000),
  ('9034d948944f5dac83aece697555f2e14f5bb70ce594db620575bcd6aa39e40f',
   '01ARZ3NDEKTSV4RRFFQ69G5FB1', 4102444800, 'e2e-tour-moderator', 1760000000, 1760000000),
  ('48e5424a9ad2d3feb74dc554daa13ea0aa08e628b847d422675cb0785d526e51',
   '01ARZ3NDEKTSV4RRFFQ69G5FB2', 4102444800, 'e2e-tour-longname', 1760000000, 1760000000);

-- seed owner セッションの step-up（TOTP 再認証）を恒久付与する（migration 0600 の session_stepup）。
-- seed の owner は password/TOTP を持たないため、招待キー発行などの step-up 必須操作を E2E から
-- 実行する唯一の手段がこの行。E2E 専用 DB にのみ適用される。
INSERT OR REPLACE INTO session_stepup (token_hash, account_id, verified_at, expires_at)
VALUES
  ('a4768801965d434ca3e6c8a107a4936948c4fee8914374d98ecab97e91286e54',
   '01ARZ3NDEKTSV4RRFFQ69G5FAV', 1760000000, 4102444800);

-- レート制限の履歴を毎回リセットする（E2E の安定化のため）。
-- ローカルの Next dev はブラウザの実 IP を転送せず、登録制限（IP 単位 5 回/24h）が
-- 127.0.0.1 に集約されて E2E の再実行が 429 になるため。短期記録のみで seed 対象ではない。
DELETE FROM auth_attempts;
