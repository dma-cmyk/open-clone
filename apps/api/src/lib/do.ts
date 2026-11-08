// Durable Object 呼び出しヘルパ。全て SQLite-backed クラス（wrangler.toml `new_sqlite_classes`）。

import { ApiError, ErrorCode, RATE_LIMITS } from "shared";
import type { Env } from "./env";

/** チャンネル名（`board:<id>` / `thread:<id>`）から RealtimeHub DO stub を得る。 */
export function realtimeStub(env: Env, channel: string): DurableObjectStub {
  const id = env.REALTIME.idFromName(channel);
  return env.REALTIME.get(id);
}

/** RateLimiter DO にカウンタ判定を問い合わせる（scope は shared/constants RATE_LIMITS のキー）。 */
export async function checkRateLimit(
  env: Env,
  scope: string,
  identityHash: string,
  maxOverride?: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const id = env.RATE_LIMITER.idFromName(`${scope}:${identityHash}`);
  const stub = env.RATE_LIMITER.get(id);
  const response = await stub.fetch("https://do/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, identityHash, ...(maxOverride ? { max: maxOverride } : {}) }),
  });
  if (!response.ok) throw new Error(`RateLimiter DO failed: ${response.status}`);
  return (await response.json()) as { allowed: boolean; retryAfterSeconds: number };
}

/**
 * 複数の識別子（device + IP 等）で同じ scope を消費し、どれか 1 つでも上限なら拒否する。
 * 全識別子を並列に消費するため、拒否された試行もそれぞれの窓にカウントされる（H-3）。
 */
export async function checkRateLimitMulti(
  env: Env,
  scope: string,
  identityHashes: readonly string[],
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const results = await Promise.all(
    identityHashes.map((identityHash) => checkRateLimit(env, scope, identityHash)),
  );
  const denied = results.filter((result) => !result.allowed);
  if (denied.length === 0) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(...denied.map((result) => result.retryAfterSeconds)),
  };
}

/**
 * 読み取り系エンドポイントの IP 単位レート制限。超過時は 429 RATE_LIMITED を投げる。
 * scope は RATE_LIMITS の `read*` / `rtTicket`。
 *
 * ログイン状態では分岐しない（既存の読み取り系 IP 窓 readSearch / readCompat / readRanking と同じ扱い）。
 * 書き込み系の IP 窓（postIp 等）が「匿名のみ」なのは、アカウント/端末単位で追跡・停止できるため。
 * 読み取りは匿名・ログインを問わず無料枠を消費するので、IP 単位で頭打ちにする。
 *
 * `RATE_LIMIT_READ_MULTIPLIER` は E2E 専用の緩和（既定 1 = 本番の上限そのまま）。
 * E2E は全ブラウザ操作が 127.0.0.1 に集約され、本番と同じ上限だと正常操作でも 429 になる。
 */
export async function assertReadRateLimit(env: Env, scope: string, ipHash: string): Promise<void> {
  const base = (RATE_LIMITS as Record<string, { windowSeconds: number; max: number } | undefined>)[scope];
  const multiplier = Number(env.RATE_LIMIT_READ_MULTIPLIER ?? "1");
  const scaled = base && Number.isFinite(multiplier) && multiplier > 1 ? Math.round(base.max * multiplier) : undefined;
  const rate = await checkRateLimit(env, scope, ipHash, scaled);
  if (!rate.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "アクセスが多すぎます。しばらく待ってから再試行してください", {
      retryAfterSeconds: rate.retryAfterSeconds,
    });
  }
}
