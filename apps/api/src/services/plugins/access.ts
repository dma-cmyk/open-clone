// プラグイン操作の権限判定（DESIGN §5.4 の plugin* 行の実装）。
// 板スタッフ判定は WP0 の requireBoardStaff と同等だが、板テーブル未作成時（WP1 未適用）でも
// 500 にせず 403 に丸める（依存 WP の未完成でプラグイン API 全体を落とさないため）。

import { ApiError, type AppRequestContext, type PluginScope } from "shared";

export interface PluginActor {
  accountId: string | null;
  role: "owner" | "special_admin" | "user" | null;
  deviceHash: string;
  /** site 全体の管理者（owner / special_admin） */
  isAdmin: boolean;
}

export function pluginActorFrom(ctx: AppRequestContext): PluginActor {
  const account = ctx.session?.account ?? null;
  return {
    accountId: account?.id ?? null,
    role: account?.role ?? null,
    deviceHash: ctx.device.deviceHash,
    isAdmin: account?.role === "owner" || account?.role === "special_admin",
  };
}

/** scope=board の scope_ref は boardId の文字列、site は "site"、personal は account/device。 */
export function scopeRefFor(
  scope: PluginScope,
  actor: Pick<PluginActor, "accountId" | "deviceHash">,
  boardId?: number | null,
): string {
  switch (scope) {
    case "personal":
      return actor.accountId ?? `device:${actor.deviceHash}`;
    case "board":
      if (!boardId) throw ApiError.validation("scope=board には boardId が必要です");
      return String(boardId);
    case "site":
      return "site";
  }
}

// ─── 端末所有プラグイン（匿名作成・報告40 設計） ──────────────────

/** プラグイン行の所有者カラム（最低限の形。registry.PluginRow と同じ並び）。 */
export interface PluginOwnership {
  owner_account_id: string | null;
  owner_device_hash: string | null;
}

/** 公式（運営）プラグイン = 両方 NULL。端末所有（owner_device_hash 非 NULL）とは区別する。 */
export function isOfficialPlugin(plugin: PluginOwnership): boolean {
  return plugin.owner_account_id === null && plugin.owner_device_hash === null;
}

/** 端末所有プラグインか。 */
export function isDeviceOwnedPlugin(plugin: PluginOwnership): boolean {
  return plugin.owner_account_id === null && plugin.owner_device_hash !== null;
}

/** アクターがこのプラグインの所有者か（アカウント所有 or 端末所有）。 */
export function isPluginOwner(actor: PluginActor, plugin: PluginOwnership): boolean {
  if (plugin.owner_account_id !== null) {
    return actor.accountId !== null && actor.accountId === plugin.owner_account_id;
  }
  if (plugin.owner_device_hash !== null) {
    return actor.accountId === null && actor.deviceHash === plugin.owner_device_hash;
  }
  return false; // 公式は誰のものでもない（運営のみ管理）
}

/**
 * 端末所有プラグインの閲覧可否。
 * - 所有端末 → 見える
 * - サイト運営（actor.isAdmin）→ 見える（停止・削除など管理のため）
 * - それ以外（別端末・板管理人を含む全員）→ 存在しないものとして扱う（404）
 */
export function canViewDeviceOwnedPlugin(actor: PluginActor, plugin: PluginOwnership): boolean {
  if (!isDeviceOwnedPlugin(plugin)) return true;
  return (
    (actor.accountId === null && actor.deviceHash === plugin.owner_device_hash) || actor.isAdmin
  );
}

/**
 * 板の管理人（admin 以上）か。board_staff テーブルが無い環境では false（403 相当）。
 * owner / special_admin は全板で管理人相当。
 */
export async function isBoardAdmin(
  db: D1Database,
  accountId: string | null,
  boardId: number,
): Promise<boolean> {
  if (!accountId) return false;
  try {
    const row = await db
      .prepare("SELECT level FROM board_staff WHERE board_id = ? AND account_id = ?")
      .bind(boardId, accountId)
      .first<{ level: string }>();
    return row?.level === "admin";
  } catch {
    // board_staff 未作成（WP1 マイグレーション未適用）→ 権限なしとして扱う
    return false;
  }
}

/** その板のスタッフか（モデレーター以上）。停止（板内無効化）判定に使う。 */
export async function isBoardStaff(
  db: D1Database,
  accountId: string | null,
  boardId: number,
): Promise<boolean> {
  if (!accountId) return false;
  try {
    const row = await db
      .prepare("SELECT level FROM board_staff WHERE board_id = ? AND account_id = ?")
      .bind(boardId, accountId)
      .first<{ level: string }>();
    return row !== null;
  } catch {
    return false;
  }
}

/** scope に対する導入/更新/削除の権限を強制する。 */
export async function assertInstallPermission(
  db: D1Database,
  actor: PluginActor,
  scope: PluginScope,
  boardId?: number | null,
): Promise<void> {
  switch (scope) {
    case "personal":
      // 匿名端末でも個人用は導入可能（審査不要・自分のブラウザにだけ適用）
      return;
    case "board": {
      if (!boardId) throw ApiError.validation("scope=board には boardId が必要です");
      if (actor.isAdmin) return;
      if (!actor.accountId) throw ApiError.unauthorized("板へのプラグイン導入にはログインが必要です");
      if (!(await isBoardAdmin(db, actor.accountId, boardId))) {
        throw ApiError.forbidden("板管理人（admin）のみ板用プラグインを導入できます");
      }
      return;
    }
    case "site":
      if (!actor.isAdmin) {
        throw ApiError.forbidden("サイト全体への導入は owner / 特別管理人のみ可能です");
      }
      return;
  }
}

/** 板の停止（kill）操作の権限。板管理人以上。 */
export async function assertBoardStopPermission(
  db: D1Database,
  actor: PluginActor,
  boardId: number,
): Promise<void> {
  if (actor.isAdmin) return;
  if (!actor.accountId) throw ApiError.unauthorized();
  if (!(await isBoardStaff(db, actor.accountId, boardId))) {
    throw ApiError.forbidden("板スタッフのみ板内のプラグインを停止できます");
  }
}