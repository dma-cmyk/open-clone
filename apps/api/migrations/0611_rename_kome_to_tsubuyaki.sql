-- 機能名 kome → つぶやき 改名（報告書 31）。
-- 板設定 JSON のキー `kome` を `tsubuyaki` へ移す。テーブルは作り直さない。
-- 旧キーは残さない。値（true/false）はそのまま引き継ぐ。
-- 既に `tsubuyaki` がある行は上書きしない（再実行しても安全）。

UPDATE boards
SET settings = json_set(
  settings,
  '$.tsubuyaki',
  json(CASE WHEN json_extract(settings, '$.kome') THEN 'true' ELSE 'false' END)
)
WHERE json_extract(settings, '$.kome') IS NOT NULL
  AND json_extract(settings, '$.tsubuyaki') IS NULL;

UPDATE boards
SET settings = json_remove(settings, '$.kome')
WHERE json_extract(settings, '$.kome') IS NOT NULL;