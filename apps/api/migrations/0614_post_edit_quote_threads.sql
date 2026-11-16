-- 0614: レス・スレの本人編集・本人削除・引用スレ。
-- posts は投稿時のアカウント ID（ログイン中のみ）と本人削除・編集回数の列を追加。
-- 編集履歴（旧本文・時刻つき）は誰でも閲覧可能。threads は引用元スレの参照を持つ。

ALTER TABLE posts ADD COLUMN account_id TEXT;
ALTER TABLE posts ADD COLUMN self_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN edited_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_posts_account ON posts(account_id) WHERE account_id IS NOT NULL;

ALTER TABLE threads ADD COLUMN quote_source_id INTEGER REFERENCES threads(id);
CREATE INDEX idx_threads_quote_source ON threads(quote_source_id);

-- 編集のたびに旧本文を残す（POST /v1/posts/:id と PATCH /v1/threads/:id の本人編集経路）。
CREATE TABLE post_edit_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  previous_body TEXT NOT NULL,
  edited_at INTEGER NOT NULL
);
CREATE INDEX idx_post_edit_history_post ON post_edit_history(post_id, edited_at DESC);
