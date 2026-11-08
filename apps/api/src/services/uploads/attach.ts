// 投稿への添付紐付け（契約: CONTRACTS §12 / WORKPACKAGES §4 WP4）。
//
// WP1 の投稿パイプラインは `attachToPost(postId, attachmentIds)` を呼ぶだけ。
// D1 バインディングは `cloudflare:workers` の `env` から取得する（WP1 の呼び出しシグネチャを変えないため）。

import { env as workerEnv } from "cloudflare:workers";

/** 1 投稿あたりの添付上限（D1 rows_written と表示の安全側）。 */
export const MAX_ATTACHMENTS_PER_POST = 20;

interface WorkerBindings {
  DB?: D1Database;
}

function resolveDb(override?: D1Database): D1Database {
  if (override) return override;
  const db = (workerEnv as unknown as WorkerBindings).DB;
  if (!db) throw new Error("attachToPost: D1 バインディング DB が見つかりません");
  return db;
}

/**
 * 未紐付けの添付を投稿に紐付ける。
 * - 既に別投稿へ紐付いている添付は変更しない（二重紐付け防止）
 * - 存在しない/削除済みの ID は黙って無視する（投稿自体は失敗させない）
 */
export async function attachToPost(
  postId: number,
  attachmentIds: string[],
  db?: D1Database,
): Promise<void> {
  if (!Number.isInteger(postId) || postId <= 0) return;
  const unique = [...new Set(attachmentIds)].filter((id) => typeof id === "string" && id.length > 0);
  const ids = unique.slice(0, MAX_ATTACHMENTS_PER_POST);
  if (ids.length === 0) return;

  const placeholders = ids.map(() => "?").join(",");
  await resolveDb(db)
    .prepare(
      `UPDATE attachments SET post_id = ?
       WHERE id IN (${placeholders}) AND post_id IS NULL AND status = 'active'`,
    )
    .bind(postId, ...ids)
    .run();
}