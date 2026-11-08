// サイト設定（site_config の WP6 管理キー）。
// 値は JSON で保存し、既定値とマージして返す。サイト設定の変更は所有者のみ。

import { batch } from "../../lib/db";
import type { SiteSettings, SiteSettingsUpdate } from "shared";

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  "site.name": "おーぷんクローン",
  "site.description": "おーぷん2ch風・AI運営型匿名掲示板",
  "registration.open": true,
  "security.require_turnstile": "auto",
  "security.special_admin_totp_required": true,
  "security.login_max_failures": 5,
  // プラグイン AI 連携は既定で無効（接続先未設定）。運用者が明示的に設定したときだけ有効。
  "plugin.ai.baseUrl": "",
  "plugin.ai.model": "gpt-4o-mini",
};

export const SITE_SETTING_KEYS = Object.keys(DEFAULT_SITE_SETTINGS) as (keyof SiteSettings)[];

export async function getSiteSettings(db: D1Database): Promise<SiteSettings> {
  const placeholders = SITE_SETTING_KEYS.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT key, value FROM site_config WHERE key IN (${placeholders})`)
    .bind(...SITE_SETTING_KEYS)
    .all<{ key: string; value: string }>();
  const merged: SiteSettings = { ...DEFAULT_SITE_SETTINGS };
  for (const row of results) {
    if (!(row.key in merged)) continue;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      // 型検証は呼び出し側の zod 更新スキーマが担う。ここでは既定値と同型のみ採用する。
      if (typeof parsed === typeof DEFAULT_SITE_SETTINGS[row.key as keyof SiteSettings]) {
        (merged as Record<string, unknown>)[row.key] = parsed;
      }
    } catch {
      // 壊れた値は既定値にフォールバック
    }
  }
  return merged;
}

export async function updateSiteSettings(
  db: D1Database,
  patch: SiteSettingsUpdate,
): Promise<SiteSettings> {
  const statements: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    statements.push(
      db
        .prepare("INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(key, JSON.stringify(value)),
    );
  }
  if (statements.length > 0) await batch(db, statements);
  return getSiteSettings(db);
}