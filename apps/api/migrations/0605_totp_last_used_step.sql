-- TOTP の同一タイムステップ再利用拒否（M-4 / RFC 6238 §5.2）。
-- last_used_at は秒単位の監査用、last_used_step は「最後に消費したカウンタ」。
-- 同じカウンタ以下（過去窓を含む）のコードは再認証に使えない。
ALTER TABLE account_totp ADD COLUMN last_used_step INTEGER;