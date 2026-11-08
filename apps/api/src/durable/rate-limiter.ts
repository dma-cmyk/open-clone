// RateLimiter DO（SQLite-backed）。
// 1 DO = 1 (scope, identity)。窓定義は shared/constants の RATE_LIMITS。
//
// 固定窓 1 本だと窓境界を跨いだ直後に上限回数が復活する（H-3）。
// ここでは同じ窓長のカウンタを 2 本、半窓ずらして併用する（two-window approximation）。
// どちらか一方でも上限に達していれば拒否するため、境界バーストは最大でも約半分になる。
// TTL 掃除は alarm ではなくアクセス時の遅延削除（Free の alarm 課金を避ける。DESIGN §11.3）。

import { DurableObject } from "cloudflare:workers";
import { RATE_LIMITS } from "shared";
import type { Env } from "../lib/env";

interface ConsumeBody {
  scope: string;
  identityHash: string;
  /** 呼び出し側が指定する上限（E2E の読み取り窓緩和など）。未指定なら RATE_LIMITS の値。 */
  max?: number;
}

interface WindowRow {
  window_start: number;
  count: number;
}

const DEFAULT_WINDOW = { windowSeconds: 60, max: 10 } as const;

/** 2 本のカウンタのキー（scope は DO 内で一意）。 */
function windowKeys(scope: string): [string, string] {
  return [`${scope}#a`, `${scope}#b`];
}

/** 窓の開始秒。`shifted` は半窓ずらした第 2 カウンタ用。 */
function windowStart(now: number, windowSeconds: number, shifted: boolean): number {
  if (!shifted) return Math.floor(now / windowSeconds) * windowSeconds;
  const offset = Math.floor(windowSeconds / 2);
  return Math.floor((now + offset) / windowSeconds) * windowSeconds - offset;
}

export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS windows (
         scope TEXT PRIMARY KEY,
         window_start INTEGER NOT NULL,
         count INTEGER NOT NULL
       )`,
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/consume") return this.handleConsume(request);
    if (url.pathname === "/peek") return this.handlePeek(url);
    return new Response("not found", { status: 404 });
  }

  private readWindow(key: string): WindowRow | null {
    const rows = this.ctx.storage.sql
      .exec("SELECT window_start, count FROM windows WHERE scope = ?", key)
      .toArray() as unknown as WindowRow[];
    return rows[0] ?? null;
  }

  private writeWindow(key: string, start: number, count: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO windows (scope, window_start, count) VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`,
      key,
      start,
      count,
    );
  }

  private async handleConsume(request: Request): Promise<Response> {
    const body = (await request.json()) as ConsumeBody;
    const scope = body.scope || "default";
    const config = (RATE_LIMITS as Record<string, { windowSeconds: number; max: number }>)[scope] ?? DEFAULT_WINDOW;
    const max =
      typeof body.max === "number" && Number.isInteger(body.max) && body.max > 0 ? body.max : config.max;
    const now = Math.floor(Date.now() / 1000);
    const [keyA, keyB] = windowKeys(scope);
    const startA = windowStart(now, config.windowSeconds, false);
    const startB = windowStart(now, config.windowSeconds, true);

    const rowA = this.readWindow(keyA);
    const rowB = this.readWindow(keyB);
    const countA = rowA && now - rowA.window_start < config.windowSeconds ? rowA.count : 0;
    const countB = rowB && now - rowB.window_start < config.windowSeconds ? rowB.count : 0;

    if (countA >= max || countB >= max) {
      const retryA = countA >= max ? Math.max(1, startA + config.windowSeconds - now) : 0;
      const retryB = countB >= max ? Math.max(1, startB + config.windowSeconds - now) : 0;
      return Response.json({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(retryA, retryB),
      });
    }

    this.writeWindow(keyA, startA, countA + 1);
    this.writeWindow(keyB, startB, countB + 1);
    return Response.json({
      allowed: true,
      remaining: Math.max(0, max - Math.max(countA, countB) - 1),
      retryAfterSeconds: 0,
    });
  }

  private handlePeek(url: URL): Response {
    const scope = url.searchParams.get("scope") ?? "default";
    const config = (RATE_LIMITS as Record<string, { windowSeconds: number; max: number }>)[scope] ?? DEFAULT_WINDOW;
    const now = Math.floor(Date.now() / 1000);
    const [keyA, keyB] = windowKeys(scope);
    const startA = windowStart(now, config.windowSeconds, false);
    const startB = windowStart(now, config.windowSeconds, true);
    const rowA = this.readWindow(keyA);
    const rowB = this.readWindow(keyB);
    const countA = rowA && now - rowA.window_start < config.windowSeconds ? rowA.count : 0;
    const countB = rowB && now - rowB.window_start < config.windowSeconds ? rowB.count : 0;
    const count = Math.max(countA, countB);
    const retryA = countA > 0 ? Math.max(0, startA + config.windowSeconds - now) : 0;
    const retryB = countB > 0 ? Math.max(0, startB + config.windowSeconds - now) : 0;
    return Response.json({
      scope,
      count,
      max: config.max,
      windowSeconds: config.windowSeconds,
      retryAfterSeconds: count >= config.max ? Math.max(retryA, retryB) : 0,
    });
  }
}