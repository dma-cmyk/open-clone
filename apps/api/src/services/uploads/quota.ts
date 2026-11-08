// アップロードのレート制限。
// 既定は WP1 の RateLimiter DO（RATE_LIMITS.upload = 50/日/identity）。
// DO が未実装/障害の場合は D1 の直近チケット数で同じ上限を強制する（フェイルクローズ）。

import { ApiError, RATE_LIMITS } from "shared";
import type { Env } from "../../lib/env";
import { checkRateLimit, checkRateLimitMulti } from "../../lib/do";
import { countRecentUploads } from "./store";

export interface UploadViewer {
  accountId: string | null;
  deviceHash: string;
  /** IP 単位の併用窓に使う（Cookie 無しの端末ローテーション対策 / H-3） */
  ipHash: string;
}

/** アップロード 1 回分のクォータを消費する。上限超過は 429。 */
export async function consumeUploadQuota(env: Env, viewer: UploadViewer): Promise<void> {
  const identity = viewer.accountId ? `account:${viewer.accountId}` : `device:${viewer.deviceHash}`;

  try {
    const result = await checkRateLimit(env, "upload", identity);
    // 匿名アップロードは端末 Cookie を捨てるとクォータを回避できるため IP 窓を併用する。
    // ログイン済みは account 単位のクォータで追跡できる。
    const ipResult =
      viewer.accountId === null
        ? await checkRateLimitMulti(env, "uploadIp", [viewer.ipHash])
        : { allowed: true, retryAfterSeconds: 0 };
    if (!result.allowed || !ipResult.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "アップロードの上限に達しました。時間をおいて再試行してください", {
        retryAfterSeconds: Math.max(result.retryAfterSeconds, ipResult.retryAfterSeconds),
      });
    }
    return;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // RateLimiter DO が未提供/障害時のフォールバック（D1 で同じ窓を数える）
    console.warn("UPLOAD_QUOTA_DO_FALLBACK", String(error));
  }

  const limit = RATE_LIMITS.upload;
  const now = Math.floor(Date.now() / 1000);
  const count = await countRecentUploads(env.DB, viewer, now - limit.windowSeconds);
  if (count >= limit.max) {
    throw new ApiError(429, "RATE_LIMITED", "アップロードの上限に達しました。時間をおいて再試行してください", {
      limit: limit.max,
      windowSeconds: limit.windowSeconds,
    });
  }
}