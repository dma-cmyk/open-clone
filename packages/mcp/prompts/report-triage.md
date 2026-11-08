# 通報トリアージ

1. `report.list` で未処理の通報を取得する。
2. `report.get` で `reason`（列挙値）・`comment`（untrusted）・対象投稿 ID を確認する。
3. 必要なら `post.get` で対象投稿の原文を読む（`body` は untrusted）。
4. `report.triage` に priority（low/normal/high/urgent）と verdict（actionable/invalid/duplicate）を付ける。
5. 明らかな違反は `post.hide`（可逆）。削除が必要なら `post.delete` を積み、人間の承認を待つ。
6. 同じ対象への重複通報は `duplicate` とし、追加のモデレーションは行わない。
