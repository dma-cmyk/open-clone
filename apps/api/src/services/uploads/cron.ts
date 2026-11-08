// 添付リンク死活監視（Cron `*/30 * * * *`。WORKPACKAGES §3.2 の ④）。
// WP7 の `src/cron.ts` から `runAttachmentLinkCheck(env, ctx)` を呼ぶ。
// 1 回の実行で最大 20 件（サブリクエスト上限 50 を超えない）。5xx/ネットワーク失敗では dead にしない。

import type { Env } from "../../lib/env";
import { makeAdapterContext, resolveAdapterById } from "./registry";
import { listAttachmentsForVerification, recordVerification } from "./store";
import { expireStaleTickets } from "./tickets";
import type { UploadRuntime } from "./types";

const MAX_CHECKS_PER_RUN = 20;

export interface LinkCheckResult {
  checked: number;
  alive: number;
  dead: number;
  skipped: number;
  expiredTickets: number;
  expiredAttachments: number;
}

export async function runAttachmentLinkCheck(
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<LinkCheckResult> {
  const result: LinkCheckResult = {
    checked: 0,
    alive: 0,
    dead: 0,
    skipped: 0,
    expiredTickets: 0,
    expiredAttachments: 0,
  };

  result.expiredTickets = await expireStaleTickets(env.DB, now);
  const expired = await env.DB.prepare(
    "UPDATE attachments SET status = 'dead' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
  )
    .bind(now)
    .run();
  result.expiredAttachments = expired.meta.changes ?? 0;

  // 期限付き（Litterbox 等）はアップロード直後は確認不要なので、既定の対象リストから自然に外れる
  const rows = await listAttachmentsForVerification(env.DB, MAX_CHECKS_PER_RUN);
  for (const row of rows) {
    result.checked += 1;
    const resolved = await resolveAdapterById(env.DB, row.adapter);
    if (!resolved || !resolved.adapter.verify) {
      result.skipped += 1;
      // 確認手段がないアダプタは「確認済み」にして毎回の再試行を避ける
      await recordVerification(env.DB, row.id, true);
      continue;
    }
    const runtime: UploadRuntime = {
      env,
      db: env.DB,
      accountId: row.uploader_account_id,
      deviceHash: row.device_hash,
    };
    const adapterContext = makeAdapterContext(env, resolved.config, runtime);
    try {
      const alive = await resolved.adapter.verify(row.external_url, adapterContext);
      await recordVerification(env.DB, row.id, alive);
      if (alive) result.alive += 1;
      else result.dead += 1;
    } catch (error) {
      // ネットワーク・5xx は「不明」として生存維持（一時障害で添付を失わせない）
      console.warn("ATTACHMENT_VERIFY_FAILED", { id: row.id, adapter: row.adapter, error: String(error) });
      result.skipped += 1;
    }
  }

  return result;
}