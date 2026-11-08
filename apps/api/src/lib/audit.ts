// 監査ログ書込。管理操作は全てこの関数で audit_log に残す（DESIGN §13）。
// AI 操作は WP5 の ai_audit（別テーブル・全呼出し必須）。

import { ulid } from "shared";

export interface AuditEntry {
  actorType: "owner" | "special_admin" | "account" | "board_staff" | "system";
  actorId?: string | null;
  action: string;
  target?: string | null;
  detail?: unknown;
}

/** fire-and-forget 可。レスポンスに含めたくない場合は ctx.waitUntil(writeAudit(...)) とする。 */
export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO audit_log (id, actor_type, actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      ulid(),
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.target ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      now,
    )
    .run();
}
