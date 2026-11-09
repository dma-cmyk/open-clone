// トークン経路の回数上限（報告書28 §5.2）。
// - 分窓: RateLimiter DO（`RATE_LIMITS.pluginAuthor` = 30 回/分、識別子はトークン ID）
// - 日次: D1 `plugin_author_usage`（account + kind + UTC 日、ON CONFLICT カウンタ）
// - 下書き保有数: `plugins` の status='draft' を COUNT
// 新規 cron は作らない（掃除は既存の毎時 :20 ジョブ = `prunePluginAuthorData`）。

import {
  ApiError,
  ErrorCode,
  PLUGIN_AUTHOR_DAILY_LIMITS,
  PLUGIN_AUTHOR_DRAFT_LIMIT,
  type PluginAuthorUsageKind,
} from "shared";
import { checkRateLimit } from "../../lib/do";
import type { Env } from "../../lib/env";

const DAY_SECONDS = 86_400;

const KIND_LABEL: Record<PluginAuthorUsageKind, string> = {
  create: "下書き作成",
  version: "版追加",
  check: "静的検査",
  publish: "公開申請",
};

/** 分窓（30 回/分）。全ツールの呼び出し前に消費する。 */
export async function assertAuthorRate(env: Env, tokenId: string): Promise<void> {
  const rate = await checkRateLimit(env, "pluginAuthor", tokenId);
  if (rate.allowed) return;
  throw new ApiError(429, ErrorCode.RATE_LIMITED, "操作が多すぎます。少し待ってから再試行してください", {
    retryAfterSeconds: rate.retryAfterSeconds,
    limit: "minute",
  });
}

/** 日次カウンタを加算し、上限超過なら 429。拒否された試行もカウントする（既存 AI レートと同じ）。 */
export async function consumeAuthorUsage(
  env: Env,
  accountId: string,
  kind: PluginAuthorUsageKind,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = now - (now % DAY_SECONDS);
  const row = await env.DB.prepare(
    `INSERT INTO plugin_author_usage (account_id, kind, day_start, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(account_id, kind, day_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(accountId, kind, dayStart)
    .first<{ count: number }>();

  const limit = PLUGIN_AUTHOR_DAILY_LIMITS[kind];
  const count = row?.count ?? 1;
  if (count > limit) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, `本日の${KIND_LABEL[kind]}の上限（${limit} 回）に達しました`, {
      limit: "day",
      kind,
      max: limit,
      retryAfterSeconds: dayStart + DAY_SECONDS - now,
    });
  }
}

/** 下書き保有数（50 件）。作成前に確認する。 */
export async function assertDraftLimit(env: Env, accountId: string): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM plugins WHERE owner_account_id = ? AND status = 'draft'",
  )
    .bind(accountId)
    .first<{ count: number }>();
  const count = row?.count ?? 0;
  if (count >= PLUGIN_AUTHOR_DRAFT_LIMIT) {
    throw new ApiError(
      409,
      ErrorCode.CONFLICT,
      `下書きは ${PLUGIN_AUTHOR_DRAFT_LIMIT} 件までです。不要な下書きを削除してから作成してください`,
      { limit: PLUGIN_AUTHOR_DRAFT_LIMIT, count },
    );
  }
}