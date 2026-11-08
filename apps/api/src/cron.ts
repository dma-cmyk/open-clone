// 各ドメインの handler は `services/<domain>/cron.ts` に置き、
// このファイルは import して dispatch するだけにする。
// Free 上限 5 cron（wrangler.toml の [triggers].crons）。
//
// 各 handler は自分の例外を内部で握る契約だが、1 つの cron の失敗で他の処理を止めないよう
// ここでも try/catch してログに残す（cron はリトライされないため、失敗は監視で拾う）。

import type { Env } from "./lib/env";
import { handleAiMonitorCron, handleWebhookMaintenanceCron } from "./services/ai/cron";
import { runPrune, runRankingSnapshot } from "./services/board/cron";
import { runAttachmentLinkCheck } from "./services/uploads/cron";

async function runStep(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    console.log("CRON_OK", name, JSON.stringify(result ?? null));
  } catch (error) {
    console.error("CRON_FAILED", name, error);
  }
}

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  switch (event.cron) {
    case "*/10 * * * *":
      // WP5: AI 監視/警報（POST 急増・通報急増・エラー率・action 反復・キュー却下連続 → 自動 suspend）
      await runStep("ai.monitor", () => handleAiMonitorCron(env));
      break;
    case "5 * * * *":
      // WP1: ランキング snapshot
      await runStep("board.ranking_snapshot", () => runRankingSnapshot(env));
      break;
    case "15 3 * * *":
      // WP1: 板自動削除/prune
      await runStep("board.prune", () => runPrune(env));
      break;
    case "*/30 * * * *":
      // WP4: 添付リンク死活監視（404/410 のみ dead 化、期限切れチケット/添付の掃除）
      await runStep("uploads.link_check", () => runAttachmentLinkCheck(env));
      break;
    case "20 * * * *":
      // WP5: webhook 再送/ログ掃除
      await runStep("ai.webhook_maintenance", () => handleWebhookMaintenanceCron(env));
      break;
    default:
      console.log("UNMAPPED_CRON", event.cron);
  }
}
