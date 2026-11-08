// Cron ハンドラ（WORKPACKAGES §3.2 の割当）。
// `apps/api/src/cron.ts`から次の 2 つを呼ぶ:
//   "*/10 * * * *"   → handleAiMonitorCron
//   "5,20 * * * *" の :20 → handleWebhookMaintenanceCron
// 例外は握りつぶさずログに残し、Cron 全体を落とさない（次回実行で回復できる）。

import type { Env } from "../../lib/env";
import { runAiMonitor, runWebhookMaintenance } from "./monitor";

export async function handleAiMonitorCron(env: Env): Promise<void> {
  try {
    const result = await runAiMonitor(env);
    console.log("AI_MONITOR", JSON.stringify(result));
  } catch (error) {
    console.error("AI_MONITOR_FAILED", error);
  }
}

export async function handleWebhookMaintenanceCron(env: Env): Promise<void> {
  try {
    const result = await runWebhookMaintenance(env);
    console.log("AI_WEBHOOK_MAINTENANCE", JSON.stringify(result));
  } catch (error) {
    console.error("AI_WEBHOOK_MAINTENANCE_FAILED", error);
  }
}