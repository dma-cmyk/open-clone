// アップローダ設定の解決。
// 優先順位: 板設定（boards.settings JSON / site_config の板キー） → サイト既定 → ビルトイン既定。
// WP1 の boards テーブルが未適用の環境でも動くよう、board 上書きは site_config にフォールバックする。

import { DEFAULT_UPLOADER_ADAPTER_ID } from "shared/schemas/upload";

const SITE_DEFAULT_KEY = "uploader.default";
const SITE_ENABLED_KEY = "uploader.enabled";

export const boardDefaultKey = (boardId: number): string => `uploader.board.${boardId}.default`;

export interface UploaderSettings {
  defaultAdapter: string;
  /** null = 制限なし（登録済みの有効アダプタすべて） */
  enabledAdapters: string[] | null;
}

export interface AdapterRow {
  id: string;
  kind: string;
  enabled: number;
  config: Record<string, unknown>;
  created_at: number;
}

async function readSiteConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM site_config WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function writeSiteConfig(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      "INSERT INTO site_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, JSON.stringify(value))
    .run();
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** site_config は JSON 文字列で保存する。手書きの素の文字列にも耐える。 */
function parseConfigString(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

/** boards.settings.uploader.adapter（WP1 のテーブルが無い/未 JSON なら null）。 */
async function readBoardSettingsAdapter(db: D1Database, boardId: number): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT settings FROM boards WHERE id = ?").bind(boardId).first<{
      settings: string | null;
    }>();
    if (!row?.settings) return null;
    // 契約は `boardSettingsSchema.uploader: string | null`（null = サイト既定）。
    const settings = JSON.parse(row.settings) as { uploader?: unknown };
    const adapter = settings.uploader;
    return typeof adapter === "string" && adapter.length > 0 ? adapter : null;
  } catch {
    return null;
  }
}

/** 板またはサイトの既定アダプタ ID を解決する。 */
export async function resolveDefaultAdapterId(db: D1Database, boardId: number | null): Promise<string> {
  if (boardId !== null) {
    const fromBoardSettings = await readBoardSettingsAdapter(db, boardId);
    if (fromBoardSettings) return fromBoardSettings;
    const fromSiteBoardKey = parseConfigString(await readSiteConfig(db, boardDefaultKey(boardId)));
    if (fromSiteBoardKey) return fromSiteBoardKey;
  }
  const siteDefault = parseConfigString(await readSiteConfig(db, SITE_DEFAULT_KEY));
  if (siteDefault) return siteDefault;
  return DEFAULT_UPLOADER_ADAPTER_ID;
}

export async function readUploaderSettings(db: D1Database, boardId: number | null): Promise<UploaderSettings> {
  const defaultAdapter = await resolveDefaultAdapterId(db, boardId);
  const enabledRaw = await readSiteConfig(db, SITE_ENABLED_KEY);
  const parsed = parseJson<unknown>(enabledRaw, null);
  const enabledAdapters = Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string")
    : null;
  return { defaultAdapter, enabledAdapters };
}

/** 板ごとの既定アダプタを site_config に保存する（WP1 の板設定 UI からも利用可能）。 */
export async function setBoardDefaultAdapter(db: D1Database, boardId: number, adapterId: string): Promise<void> {
  await writeSiteConfig(db, boardDefaultKey(boardId), adapterId);
}

export async function setSiteDefaultAdapter(db: D1Database, adapterId: string): Promise<void> {
  await writeSiteConfig(db, SITE_DEFAULT_KEY, adapterId);
}

/** `uploader_adapters` の 1 行を取得する。config は JSON。 */
export async function readAdapterRow(db: D1Database, adapterId: string): Promise<AdapterRow | null> {
  const row = await db
    .prepare("SELECT id, kind, enabled, config, created_at FROM uploader_adapters WHERE id = ?")
    .bind(adapterId)
    .first<{ id: string; kind: string; enabled: number; config: string; created_at: number }>();
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled,
    config: parseJson<Record<string, unknown>>(row.config, {}),
    created_at: row.created_at,
  };
}

export async function listAdapterRows(db: D1Database): Promise<AdapterRow[]> {
  const result = await db
    .prepare("SELECT id, kind, enabled, config, created_at FROM uploader_adapters ORDER BY id")
    .all<{ id: string; kind: string; enabled: number; config: string; created_at: number }>();
  return result.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    enabled: row.enabled,
    config: parseJson<Record<string, unknown>>(row.config, {}),
    created_at: row.created_at,
  }));
}

/** アダプタ設定の保存（プラグイン/管理画面の拡張点）。 */
export async function saveAdapterRow(
  db: D1Database,
  input: { id: string; kind: string; enabled?: boolean; config: Record<string, unknown> },
): Promise<AdapterRow> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO uploader_adapters (id, kind, enabled, config, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, enabled = excluded.enabled, config = excluded.config`,
    )
    .bind(input.id, input.kind, input.enabled === false ? 0 : 1, JSON.stringify(input.config), now)
    .run();
  return {
    id: input.id,
    kind: input.kind,
    enabled: input.enabled === false ? 0 : 1,
    config: input.config,
    created_at: now,
  };
}