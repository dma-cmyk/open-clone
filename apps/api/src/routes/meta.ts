// health / usage（無料枠ガード用の簡易メトリクス）。

import { Hono } from "hono";
import { ok } from "shared";
import type { AppEnv } from "../lib/env";
import { requireAdminActive } from "../services/account/guards";

const app = new Hono<AppEnv>();

app.get("/health", (c) => {
  return c.json(
    ok({
      status: "ok",
      service: "open-clone-api",
      version: "0.0.0",
      time: new Date().toISOString(),
      environment: c.env.ENVIRONMENT,
    }),
  );
});

// アカウント数・セッション数・監査イベント数は匿名に公開しない（L-2）。
// 管理画面（/admin/usage）だけが使うため管理者セッションを要求する。
app.get("/usage", requireAdminActive, async (c) => {
  // D1 のテーブル存在を前提としない簡易集計。
  const counts: Record<string, number> = {};
  for (const table of ["accounts", "sessions", "audit_log"] as const) {
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    counts[table] = row?.n ?? 0;
  }
  return c.json(
    ok({
      d1: { counts },
      freeTierBudget: {
        workersRequestsPerDay: 100_000,
        d1RowsReadPerDay: 5_000_000,
        d1RowsWrittenPerDay: 100_000,
      },
    }),
  );
});

export default app;
