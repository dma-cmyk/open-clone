// プラグインレジストリの D1 操作（DESIGN §7.3 のライフサイクル）。
// ルートハンドラは HTTP の関心事のみを持ち、状態遷移・検索・導入・審査はここに集約する。

import {
  ApiError,
  PLUGIN_CODE_MAX_BYTES,
  PLUGIN_STATE_MAX_BYTES,
  manifestRiskLevel,
  normalizeManifest,
  sha256Hex,
  ulid,
  type PluginActiveInstall,
  type PluginDetail,
  type PluginInstallInfo,
  type PluginListPage,
  type PluginManifest,
  type PluginReportInfo,
  type PluginReportReason,
  type PluginReviewInfo,
  type PluginScope,
  type PluginStatus,
  type PluginSummary,
  type PluginVersionInfo,
  type PluginVisibility,
} from "shared";

// ─── 行型 ──────────────────────────────────────────────────────────

export interface PluginRow {
  id: string;
  owner_account_id: string | null;
  name: string;
  summary: string;
  description: string | null;
  manifest_json: string;
  scopes: string;
  status: PluginStatus;
  visibility: PluginVisibility;
  latest_version: string | null;
  source: "local" | "gist" | "github";
  source_ref: string | null;
  install_count: number;
  report_count: number;
  flagged: number;
  license: string | null;
  kill_seq: number;
  disabled_reason: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  owner_name?: string | null;
}

export interface VersionRow {
  plugin_id: string;
  version: string;
  code: string;
  code_hash: string;
  manifest_json: string;
  changelog: string | null;
  status: "draft" | "pending" | "approved" | "rejected";
  created_by: string | null;
  created_at: number;
}

export interface InstallRow {
  id: string;
  plugin_id: string;
  scope: PluginScope;
  scope_ref: string;
  version: string;
  pinned: number;
  enabled: number;
  config_json: string | null;
  installed_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ReviewRow {
  id: string;
  plugin_id: string;
  version: string;
  scope: "board" | "site";
  status: "pending" | "approved" | "rejected";
  reviewer_type: "human" | "ai" | "system";
  reviewer_id: string | null;
  note: string | null;
  static_result_json: string | null;
  risk_level: "low" | "medium" | "high" | null;
  created_at: number;
  decided_at: number | null;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** scope の検索用 csv（`,personal,board,`）。 */
export function scopesCsv(scopes: readonly PluginScope[]): string {
  return `,${[...new Set(scopes)].sort().join(",")},`;
}

/** JSON 文字列から manifest を復元する（破損時は最小限の既定で返す）。 */
export function parseManifest(json: string): PluginManifest {
  try {
    return normalizeManifest(JSON.parse(json));
  } catch {
    return normalizeManifest({
      name: "broken-plugin",
      version: "0.0.0",
      summary: "manifest を読み込めませんでした",
      scope: ["personal"],
      permissions: [],
      connectAllowlist: [],
      slots: [],
      hooks: [],
    });
  }
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** semver の数値比較（prerelease は数値部のみ比較。プラグイン用途では十分）。 */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 次の patch バージョン。 */
export function nextPatchVersion(current: string | null): string {
  if (!current) return "1.0.0";
  const parts = current.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return `${parts[0] ?? 1}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
}

function rowToSummary(row: PluginRow): PluginSummary {
  const manifest = parseManifest(row.manifest_json);
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    latestVersion: row.latest_version,
    status: row.status,
    visibility: row.visibility,
    scopes: manifest.scope,
    permissions: manifest.permissions,
    slots: manifest.slots,
    hasRenderRules: (manifest.render?.post?.length ?? 0) > 0,
    installCount: row.install_count,
    reportCount: row.report_count,
    flagged: row.flagged === 1,
    source: row.source,
    sourceRef: row.source_ref,
    owner: row.owner_account_id
      ? { id: row.owner_account_id, name: row.owner_name ?? "(不明)" }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

export function versionRowToInfo(row: VersionRow): PluginVersionInfo {
  return {
    version: row.version,
    changelog: row.changelog,
    codeHash: row.code_hash,
    status: row.status,
    createdAt: row.created_at,
  };
}

function installRowToInfo(row: InstallRow): PluginInstallInfo {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    scope: row.scope,
    scopeRef: row.scope_ref,
    version: row.version,
    pinned: row.pinned === 1,
    enabled: row.enabled === 1,
    installedBy: row.installed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── 参照 ──────────────────────────────────────────────────────────

const PLUGIN_SELECT = `
  SELECT p.*, a.name AS owner_name
  FROM plugins p LEFT JOIN accounts a ON a.id = p.owner_account_id
`;

export async function getPluginRow(db: D1Database, idOrName: string): Promise<PluginRow | null> {
  return db
    .prepare(`${PLUGIN_SELECT} WHERE p.id = ? OR p.name = ?`)
    .bind(idOrName, idOrName)
    .first<PluginRow>();
}

export async function listVersions(
  db: D1Database,
  pluginId: string,
  options: { includeUnapproved?: boolean } = {},
): Promise<VersionRow[]> {
  const filter = options.includeUnapproved ? "" : "AND status = 'approved'";
  const result = await db
    .prepare(`SELECT * FROM plugin_versions WHERE plugin_id = ? ${filter} ORDER BY created_at DESC`)
    .bind(pluginId)
    .all<VersionRow>();
  return result.results ?? [];
}

export async function getVersionRow(
  db: D1Database,
  pluginId: string,
  version: string,
): Promise<VersionRow | null> {
  return db
    .prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?")
    .bind(pluginId, version)
    .first<VersionRow>();
}

/** 検索・一覧。cursor は offset の base64。 */
export async function listPlugins(
  db: D1Database,
  options: {
    q?: string;
    scope?: PluginScope;
    sort?: "updated" | "popular" | "new";
    limit: number;
    cursor?: string;
    ownerAccountId?: string;
    includeAllStatuses?: boolean;
    /** レジストリ状態での絞り込み（`/mcp-plugin` の authoring.list 用）。 */
    status?: PluginStatus;
  },
): Promise<PluginListPage> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.ownerAccountId) {
    where.push("p.owner_account_id = ?");
    params.push(options.ownerAccountId);
  }
  if (options.status) {
    where.push("p.status = ?");
    params.push(options.status);
  }
  if (!options.includeAllStatuses) {
    where.push("p.status = 'published'", "p.visibility = 'public'");
  }

  if (options.q) {
    const like = `%${options.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (options.scope) {
    where.push("p.scopes LIKE ?");
    params.push(`%,${options.scope},%`);
  }

  const order =
    options.sort === "popular"
      ? "p.install_count DESC, p.updated_at DESC, p.id ASC"
      : options.sort === "new"
        ? "COALESCE(p.published_at, p.created_at) DESC, p.id ASC"
        : "p.updated_at DESC, p.id ASC";

  const offset = decodeCursor(options.cursor);
  const limit = options.limit;
  const result = await db
    .prepare(
      `${PLUGIN_SELECT}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit + 1, offset)
    .all<PluginRow>();

  const rows = result.results ?? [];
  const items = rows.slice(0, limit).map(rowToSummary);
  return {
    items,
    nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
  };
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = Number.parseInt(atob(cursor), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}

/** 詳細（バージョン・導入・閲覧者権限を含む）。 */
export async function getPluginDetail(
  db: D1Database,
  row: PluginRow,
  viewer: {
    accountId: string | null;
    deviceHash: string;
    isAdmin: boolean;
  },
): Promise<PluginDetail> {
  const isOwner = viewer.accountId !== null && row.owner_account_id === viewer.accountId;
  const canSeeUnapproved = isOwner || viewer.isAdmin;

  if (!canSeeUnapproved && (row.status !== "published" || row.visibility === "private")) {
    throw ApiError.notFound("プラグインが見つかりません");
  }

  const [versions, installs] = await Promise.all([
    listVersions(db, row.id, { includeUnapproved: canSeeUnapproved }),
    canSeeUnapproved
      ? db.prepare("SELECT * FROM plugin_installs WHERE plugin_id = ? ORDER BY updated_at DESC").bind(row.id).all<InstallRow>()
      : db
          .prepare("SELECT * FROM plugin_installs WHERE plugin_id = ? AND scope = 'personal' AND scope_ref = ?")
          .bind(row.id, viewer.accountId ?? `device:${viewer.deviceHash}`)
          .all<InstallRow>(),
  ]);

  return {
    ...rowToSummary(row),
    description: row.description,
    manifest: parseManifest(row.manifest_json),
    versions: versions.map(versionRowToInfo),
    viewer: {
      isOwner,
      isAdmin: viewer.isAdmin,
      canEdit: isOwner || viewer.isAdmin,
      canReview: viewer.isAdmin,
    },
    installs: (installs.results ?? []).map(installRowToInfo),
  };
}

// ─── 作成・版・公開 ────────────────────────────────────────────────

export interface CreatePluginParams {
  ownerAccountId: string;
  manifest: PluginManifest;
  code: string;
  changelog?: string;
  visibility: PluginVisibility;
  source?: "local" | "gist" | "github";
  sourceRef?: string | null;
}

/** プラグイン本体 + 最初のバージョンを原子的に作る。name 衝突は 409。 */
export async function createPlugin(
  db: D1Database,
  params: CreatePluginParams,
): Promise<{ id: string; version: string; visibility: PluginVisibility }> {
  const existing = await db
    .prepare("SELECT id FROM plugins WHERE name = ?")
    .bind(params.manifest.name)
    .first<{ id: string }>();
  if (existing) throw ApiError.conflict(`プラグイン名 '${params.manifest.name}' は既に使われています`);

  const id = ulid();
  const timestamp = now();
  const codeHash = await sha256Hex(params.code);

  await db.batch([
    db
      .prepare(
        `INSERT INTO plugins (
           id, owner_account_id, name, summary, description, manifest_json, scopes,
           status, visibility, latest_version, source, source_ref,
           install_count, report_count, flagged, license, kill_seq,
           created_at, updated_at, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0, 0, 0, ?, 0, ?, ?, NULL)`,
      )
      .bind(
        id,
        params.ownerAccountId,
        params.manifest.name,
        params.manifest.summary,
        params.manifest.description ?? null,
        JSON.stringify(params.manifest),
        scopesCsv(params.manifest.scope),
        params.visibility,
        params.manifest.version,
        params.source ?? "local",
        params.sourceRef ?? null,
        params.manifest.license ?? null,
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO plugin_versions
           (plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)`,
      )
      .bind(
        id,
        params.manifest.version,
        params.code,
        codeHash,
        JSON.stringify(params.manifest),
        params.changelog ?? null,
        params.ownerAccountId,
        timestamp,
      ),
  ]);

  return { id, version: params.manifest.version, visibility: params.visibility };
}

/**
 * 新しい版を追加する。version 省略時は patch を +1。
 * 既存より低い/同じバージョンは 409。追加後の版は draft（公開申請で approved になる）。
 */
export async function addVersion(
  db: D1Database,
  plugin: PluginRow,
  params: {
    version?: string;
    manifest?: PluginManifest;
    code: string;
    changelog?: string;
    actorAccountId: string;
  },
): Promise<{ version: string; manifest: PluginManifest }> {
  const manifest = params.manifest ?? parseManifest(plugin.manifest_json);
  const version = params.version ?? nextPatchVersion(plugin.latest_version);

  manifest.version = version;

  if (plugin.latest_version && compareSemver(version, plugin.latest_version) <= 0) {
    throw ApiError.conflict(
      `新しいバージョンは ${plugin.latest_version} より大きい必要があります（指定: ${version}）`,
    );
  }

  const codeBytes = new TextEncoder().encode(params.code).byteLength;
  if (codeBytes > PLUGIN_CODE_MAX_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", `コードが上限（${PLUGIN_CODE_MAX_BYTES} bytes）を超えています`);
  }

  const codeHash = await sha256Hex(params.code);
  const timestamp = now();

  await db.batch([
    db
      .prepare(
        `INSERT INTO plugin_versions
           (plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .bind(
        plugin.id,
        version,
        params.code,
        codeHash,
        JSON.stringify(manifest),
        params.changelog ?? null,
        params.actorAccountId,
        timestamp,
      ),
    db
      .prepare("UPDATE plugins SET manifest_json = ?, scopes = ?, latest_version = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(manifest), scopesCsv(manifest.scope), version, timestamp, plugin.id),
  ]);

  return { version, manifest };
}

export interface PublishResult {
  status: PluginStatus;
  visibility: PluginVisibility;
  reviewId: string | null;
  needsReview: boolean;
}

/**
 * 公開申請。site スコープを含む場合は承認キュー（pending）へ。
 * personal/board のみなら審査不要で即時公開（board の導入は板管理人の操作自体が承認）。
 */
export async function publishPlugin(
  db: D1Database,
  plugin: PluginRow,
  params: {
    scopes: PluginScope[];
    visibility: PluginVisibility;
    actorAccountId: string;
    staticResult: { allowed: boolean; reasons: string[]; riskScore?: number };
  },
): Promise<PublishResult> {
  if (!plugin.latest_version) throw ApiError.validation("公開するバージョンがありません");
  const versionRow = await getVersionRow(db, plugin.id, plugin.latest_version);
  if (!versionRow) throw ApiError.notFound("最新バージョンが見つかりません");

  const manifest = parseManifest(versionRow.manifest_json);
  for (const scope of params.scopes) {
    if (!manifest.scope.includes(scope)) {
      throw ApiError.validation(`manifest の scope に '${scope}' が含まれていません`);
    }
  }
  if (!params.staticResult.allowed) {
    throw new ApiError(400, "VALIDATION", "静的検査を通過していません", { reasons: params.staticResult.reasons });
  }

  const timestamp = now();
  const needsReview = params.scopes.includes("site");
  const risk = manifestRiskLevel(manifest);

  if (!needsReview) {
    await db.batch([
      db.prepare("UPDATE plugin_versions SET status = 'approved' WHERE plugin_id = ? AND version = ?").bind(
        plugin.id,
        plugin.latest_version,
      ),
      db
        .prepare(
          `UPDATE plugins SET status = 'published', visibility = ?, scopes = ?, updated_at = ?,
             published_at = COALESCE(published_at, ?) WHERE id = ?`,
        )
        .bind(params.visibility, scopesCsv(params.scopes), timestamp, timestamp, plugin.id),
    ]);
    return { status: "published", visibility: params.visibility, reviewId: null, needsReview: false };
  }

  const reviewId = ulid();
  await db.batch([
    db.prepare("UPDATE plugin_versions SET status = 'pending' WHERE plugin_id = ? AND version = ?").bind(
      plugin.id,
      plugin.latest_version,
    ),
    db
      .prepare(
        `INSERT INTO plugin_reviews
           (id, plugin_id, version, scope, status, reviewer_type, reviewer_id, note, static_result_json, risk_level, created_at, decided_at)
         VALUES (?, ?, ?, 'site', 'pending', 'system', NULL, NULL, ?, ?, ?, NULL)
         ON CONFLICT(plugin_id, version, scope, scope_ref) DO UPDATE SET
           status = 'pending', static_result_json = excluded.static_result_json,
           risk_level = excluded.risk_level, created_at = excluded.created_at, decided_at = NULL`,
      )
      .bind(reviewId, plugin.id, plugin.latest_version, JSON.stringify(params.staticResult), risk, timestamp),
    db
      .prepare("UPDATE plugins SET status = 'pending', visibility = ?, scopes = ?, updated_at = ? WHERE id = ?")
      .bind(params.visibility, scopesCsv(params.scopes), timestamp, plugin.id),
  ]);

  return { status: "pending", visibility: params.visibility, reviewId, needsReview: true };
}

/**
 * 審査判定。approve → published（承認済み版を配信）。reject → 過去に公開歴があれば published に戻す。
 */
export async function decideReview(
  db: D1Database,
  review: ReviewRow,
  params: {
    decision: "approve" | "reject";
    note?: string;
    reviewerId: string;
    reviewerType: "human" | "ai";
  },
): Promise<{ pluginStatus: PluginStatus }> {
  if (review.status !== "pending") throw ApiError.conflict("この審査は既に判定済みです");
  const timestamp = now();

  if (params.decision === "approve") {
    await db.batch([
      db
        .prepare(
          `UPDATE plugin_reviews SET status = 'approved', reviewer_type = ?, reviewer_id = ?, note = ?,
             decided_at = ? WHERE id = ?`,
        )
        .bind(params.reviewerType, params.reviewerId, params.note ?? null, timestamp, review.id),
      db.prepare("UPDATE plugin_versions SET status = 'approved' WHERE plugin_id = ? AND version = ?").bind(
        review.plugin_id,
        review.version,
      ),
      db
        .prepare(
          `UPDATE plugins SET status = 'published', published_at = COALESCE(published_at, ?),
             updated_at = ? WHERE id = ?`,
        )
        .bind(timestamp, timestamp, review.plugin_id),
    ]);
    return { pluginStatus: "published" };
  }

  await db.batch([
    db
      .prepare(
        `UPDATE plugin_reviews SET status = 'rejected', reviewer_type = ?, reviewer_id = ?, note = ?,
           decided_at = ? WHERE id = ?`,
      )
      .bind(params.reviewerType, params.reviewerId, params.note ?? null, timestamp, review.id),
    db.prepare("UPDATE plugin_versions SET status = 'rejected' WHERE plugin_id = ? AND version = ?").bind(
      review.plugin_id,
      review.version,
    ),
  ]);

  const plugin = await getPluginRow(db, review.plugin_id);
  const restored: PluginStatus = plugin?.published_at ? "published" : "rejected";
  await db
    .prepare("UPDATE plugins SET status = ?, updated_at = ? WHERE id = ?")
    .bind(restored, timestamp, review.plugin_id);
  return { pluginStatus: restored };
}

export async function getReviewRow(db: D1Database, reviewId: string): Promise<ReviewRow | null> {
  return db.prepare("SELECT * FROM plugin_reviews WHERE id = ?").bind(reviewId).first<ReviewRow>();
}

const REVIEW_SELECT = `
  SELECT r.*, p.name AS plugin_name
  FROM plugin_reviews r JOIN plugins p ON p.id = r.plugin_id
`;

export async function listReviewQueue(
  db: D1Database,
  options: { status?: "pending" | "approved" | "rejected"; scope?: "board" | "site"; limit: number },
): Promise<PluginReviewInfo[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    where.push("r.status = ?");
    params.push(options.status);
  }
  if (options.scope) {
    where.push("r.scope = ?");
    params.push(options.scope);
  }
  const result = await db
    .prepare(
      `${REVIEW_SELECT}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.created_at DESC LIMIT ?`,
    )
    .bind(...params, options.limit)
    .all<ReviewRow & { plugin_name: string }>();

  return (result.results ?? []).map((row) => ({
    id: row.id,
    pluginId: row.plugin_id,
    pluginName: row.plugin_name,
    version: row.version,
    scope: row.scope,
    status: row.status,
    reviewerType: row.reviewer_type,
    reviewerId: row.reviewer_id,
    note: row.note,
    staticResult: parseJson(row.static_result_json),
    riskLevel: row.risk_level,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  }));
}

// ─── 導入・更新・アンインストール ─────────────────────────────────

/** インストール可能な版（承認済み）を解決する。 */
export async function resolveInstallVersion(
  db: D1Database,
  plugin: PluginRow,
  requested?: string,
  options: { requireApproved?: boolean; allowUnpublished?: boolean } = {},
): Promise<string> {
  const version = requested ?? plugin.latest_version;
  if (!version) throw ApiError.validation("インストールできるバージョンがありません");
  const row = await getVersionRow(db, plugin.id, version);
  if (!row) throw ApiError.notFound(`バージョン ${version} が見つかりません`);
  if (!options.allowUnpublished) {
    if (row.status !== "approved" && (options.requireApproved || row.status !== "pending")) {
      throw ApiError.conflict(`バージョン ${version} は公開されていません`);
    }
    if (plugin.status !== "published" && plugin.status !== "pending") {
      throw ApiError.conflict("公開されていないプラグインはインストールできません");
    }
  }
  return version;
}

export interface InstallResult {
  install: PluginInstallInfo;
  created: boolean;
  updated: boolean;
}

/** 導入の upsert。既存なら版を更新する。 */
export async function installPlugin(
  db: D1Database,
  plugin: PluginRow,
  params: {
    scope: PluginScope;
    scopeRef: string;
    version: string;
    pinned: boolean;
    config?: Record<string, unknown>;
    installedBy: string | null;
  },
): Promise<InstallResult> {
  const timestamp = now();
  const existing = await db
    .prepare("SELECT * FROM plugin_installs WHERE plugin_id = ? AND scope = ? AND scope_ref = ?")
    .bind(plugin.id, params.scope, params.scopeRef)
    .first<InstallRow>();

  let installId: string;
  if (existing) {
    installId = existing.id;
    await db
      .prepare(
        `UPDATE plugin_installs SET version = ?, pinned = ?, enabled = 1, config_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        params.version,
        params.pinned ? 1 : 0,
        params.config ? JSON.stringify(params.config) : existing.config_json,
        timestamp,
        installId,
      )
      .run();
  } else {
    installId = ulid();
    await db.batch([
      db
        .prepare(
          `INSERT INTO plugin_installs
             (id, plugin_id, scope, scope_ref, version, pinned, enabled, config_json, installed_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .bind(
          installId,
          plugin.id,
          params.scope,
          params.scopeRef,
          params.version,
          params.pinned ? 1 : 0,
          params.config ? JSON.stringify(params.config) : null,
          params.installedBy,
          timestamp,
          timestamp,
        ),
      db
        .prepare("UPDATE plugins SET install_count = install_count + 1, updated_at = ? WHERE id = ?")
        .bind(timestamp, plugin.id),
    ]);
  }

  const row = await db.prepare("SELECT * FROM plugin_installs WHERE id = ?").bind(installId).first<InstallRow>();
  return {
    install: installRowToInfo(row!),
    created: !existing,
    updated: Boolean(existing),
  };
}

export async function findInstall(
  db: D1Database,
  pluginId: string,
  scope: PluginScope,
  scopeRef: string,
): Promise<InstallRow | null> {
  return db
    .prepare("SELECT * FROM plugin_installs WHERE plugin_id = ? AND scope = ? AND scope_ref = ?")
    .bind(pluginId, scope, scopeRef)
    .first<InstallRow>();
}

export async function updateInstallVersion(
  db: D1Database,
  install: InstallRow,
  version: string,
): Promise<PluginInstallInfo> {
  await db
    .prepare("UPDATE plugin_installs SET version = ?, updated_at = ? WHERE id = ?")
    .bind(version, now(), install.id)
    .run();
  return installRowToInfo({ ...install, version, updated_at: now() });
}

export async function uninstallPlugin(db: D1Database, install: InstallRow): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM plugin_installs WHERE id = ?").bind(install.id),
    db
      .prepare("UPDATE plugins SET install_count = MAX(0, install_count - 1), updated_at = ? WHERE id = ?")
      .bind(now(), install.plugin_id),
  ]);
}

export async function setInstallEnabled(db: D1Database, installId: string, enabled: boolean): Promise<void> {
  await db
    .prepare("UPDATE plugin_installs SET enabled = ?, updated_at = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, now(), installId)
    .run();
}

/** ページに適用される導入（personal + その板 + site）。停止済みも stopped フラグ付きで返す。 */
export async function listActiveInstalls(
  db: D1Database,
  params: { scopeRefs: { scope: PluginScope; ref: string }[]; viewerAccountId?: string | null },
): Promise<PluginActiveInstall[]> {
  const clauses = params.scopeRefs.map(() => "(i.scope = ? AND i.scope_ref = ?)");
  if (params.scopeRefs.length === 0) return [];
  const bindings: unknown[] = [];
  for (const ref of params.scopeRefs) {
    bindings.push(ref.scope, ref.ref);
  }

  const result = await db
    .prepare(
      `SELECT i.*, p.name, p.status AS plugin_status, p.owner_account_id, p.manifest_json AS plugin_manifest,
              v.manifest_json AS version_manifest, v.status AS version_status
       FROM plugin_installs i
       JOIN plugins p ON p.id = i.plugin_id
       LEFT JOIN plugin_versions v ON v.plugin_id = i.plugin_id AND v.version = i.version
       WHERE i.enabled = 1 AND (${clauses.join(" OR ")})
       ORDER BY p.name ASC`,
    )
    .bind(...bindings)
    .all<
      InstallRow & {
        name: string;
        plugin_status: PluginStatus;
        owner_account_id: string | null;
        plugin_manifest: string;
        version_manifest: string | null;
        version_status: string | null;
      }
    >();

  return (result.results ?? []).map((row) => {
    const ownerPreview =
      row.scope === "personal" &&
      params.viewerAccountId != null &&
      row.owner_account_id === params.viewerAccountId;
    const stopped =
      row.plugin_status === "disabled" ||
      !row.version_manifest ||
      (row.version_status !== "approved" && !ownerPreview);
    return {
      installId: row.id,
      pluginId: row.plugin_id,
      name: row.name,
      version: row.version,
      scope: row.scope,
      scopeRef: row.scope_ref,
      stopped,
      status: row.plugin_status,
      codeUrl: `/v1/plugins/${row.plugin_id}/code?version=${encodeURIComponent(row.version)}`,
      manifest: parseManifest(row.version_manifest ?? row.plugin_manifest),
      config: parseJson<Record<string, unknown>>(row.config_json),
      pinned: row.pinned === 1,
    } satisfies PluginActiveInstall;
  });
}

export async function listInstallsForPlugin(db: D1Database, pluginId: string): Promise<PluginInstallInfo[]> {
  const result = await db
    .prepare("SELECT * FROM plugin_installs WHERE plugin_id = ? ORDER BY updated_at DESC")
    .bind(pluginId)
    .all<InstallRow>();
  return (result.results ?? []).map(installRowToInfo);
}

// ─── プラグイン状態（storage:shared） ─────────────────────────────

export async function stateGet(
  db: D1Database,
  params: { pluginId: string; scope: PluginScope; scopeRef: string; key: string },
): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM plugin_state WHERE plugin_id = ? AND scope = ? AND scope_ref = ? AND key = ?")
    .bind(params.pluginId, params.scope, params.scopeRef, params.key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** scope 合計 64KB 上限を強制して保存する。 */
export async function stateSet(
  db: D1Database,
  params: { pluginId: string; scope: PluginScope; scopeRef: string; key: string; value: string },
): Promise<void> {
  const existing = await db
    .prepare("SELECT value FROM plugin_state WHERE plugin_id = ? AND scope = ? AND scope_ref = ? AND key = ?")
    .bind(params.pluginId, params.scope, params.scopeRef, params.key)
    .first<{ value: string }>();
  const encoder = new TextEncoder();
  const rows = await db
    .prepare("SELECT key, value FROM plugin_state WHERE plugin_id = ? AND scope = ? AND scope_ref = ?")
    .bind(params.pluginId, params.scope, params.scopeRef)
    .all<{ key: string; value: string }>();
  let usedBytes = 0;
  for (const row of rows.results ?? []) usedBytes += encoder.encode(row.value).byteLength;
  if (existing) usedBytes -= encoder.encode(existing.value).byteLength;
  const nextSize = usedBytes + encoder.encode(params.value).byteLength;
  if (nextSize > PLUGIN_STATE_MAX_BYTES) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "プラグインの保存領域（64KB）を超えました");
  }
  await db
    .prepare(
      `INSERT INTO plugin_state (plugin_id, scope, scope_ref, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id, scope, scope_ref, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(params.pluginId, params.scope, params.scopeRef, params.key, params.value, now())
    .run();
}

export async function stateDelete(
  db: D1Database,
  params: { pluginId: string; scope: PluginScope; scopeRef: string; key: string },
): Promise<void> {
  await db
    .prepare("DELETE FROM plugin_state WHERE plugin_id = ? AND scope = ? AND scope_ref = ? AND key = ?")
    .bind(params.pluginId, params.scope, params.scopeRef, params.key)
    .run();
}

export async function stateList(
  db: D1Database,
  params: { pluginId: string; scope: PluginScope; scopeRef: string },
): Promise<Record<string, string>> {
  const result = await db
    .prepare("SELECT key, value FROM plugin_state WHERE plugin_id = ? AND scope = ? AND scope_ref = ?")
    .bind(params.pluginId, params.scope, params.scopeRef)
    .all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const row of result.results ?? []) out[row.key] = row.value;
  return out;
}

// ─── 通報・停止 ───────────────────────────────────────────────────

export async function recordReport(
  db: D1Database,
  plugin: PluginRow,
  params: {
    reporterKind: "account" | "device";
    reporterId: string;
    reason: PluginReportReason;
    detail?: string;
    version?: string;
  },
): Promise<PluginReportInfo> {
  const timestamp = now();
  const recent = await db
    .prepare(
      "SELECT id FROM plugin_reports WHERE plugin_id = ? AND reporter_id = ? AND created_at > ? LIMIT 1",
    )
    .bind(plugin.id, params.reporterId, timestamp - 86_400)
    .first<{ id: string }>();
  if (recent) throw ApiError.conflict("同じプラグインへの通報は 24 時間に 1 回までです");

  const reportId = ulid();
  await db.batch([
    db
      .prepare(
        `INSERT INTO plugin_reports
           (id, plugin_id, version, reporter_kind, reporter_id, reason, detail, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .bind(
        reportId,
        plugin.id,
        params.version ?? plugin.latest_version,
        params.reporterKind,
        params.reporterId,
        params.reason,
        params.detail ?? null,
        timestamp,
      ),
    db
      .prepare(
        `UPDATE plugins SET report_count = report_count + 1,
           flagged = CASE WHEN report_count + 1 >= 3 THEN 1 ELSE flagged END,
           updated_at = ? WHERE id = ?`,
      )
      .bind(timestamp, plugin.id),
  ]);

  return {
    id: reportId,
    pluginId: plugin.id,
    version: params.version ?? plugin.latest_version,
    reason: params.reason,
    detail: params.detail ?? null,
    status: "open",
    createdAt: timestamp,
  };
}

export async function listReports(db: D1Database, pluginId: string, limit = 50): Promise<PluginReportInfo[]> {
  const result = await db
    .prepare("SELECT * FROM plugin_reports WHERE plugin_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(pluginId, limit)
    .all<{
      id: string;
      plugin_id: string;
      version: string | null;
      reason: PluginReportReason;
      detail: string | null;
      status: "open" | "resolved" | "dismissed";
      created_at: number;
    }>();
  return (result.results ?? []).map((row) => ({
    id: row.id,
    pluginId: row.plugin_id,
    version: row.version,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/** キルスイッチ: disabled + kill_seq 加算（実行中ホストはポーリングで kill を受ける）。 */
export async function disablePlugin(db: D1Database, pluginId: string, reason: string): Promise<void> {
  await db
    .prepare(
      `UPDATE plugins SET status = 'disabled', kill_seq = kill_seq + 1,
         disabled_reason = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(reason, now(), pluginId)
    .run();
}

/** 停止解除（owner/special_admin のみ）。 */
export async function enablePlugin(db: D1Database, pluginId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE plugins SET status = 'published', disabled_reason = NULL, updated_at = ? WHERE id = ?`,
    )
    .bind(now(), pluginId)
    .run();
}

/** 公開プラグインを自分の下書きへ複製（共有・改造の起点）。 */
export async function forkPlugin(
  db: D1Database,
  source: PluginRow,
  params: { ownerAccountId: string; name: string },
): Promise<{ id: string; version: string }> {
  const latest = source.latest_version
    ? await getVersionRow(db, source.id, source.latest_version)
    : null;
  if (!latest) throw ApiError.notFound("複製できるバージョンがありません");

  const manifest = parseManifest(latest.manifest_json);
  const conflict = await db.prepare("SELECT id FROM plugins WHERE name = ?").bind(params.name).first();
  if (conflict) throw ApiError.conflict(`プラグイン名 '${params.name}' は既に使われています`);

  const forked: PluginManifest = {
    ...manifest,
    name: params.name,
    summary: `${manifest.summary}（fork）`,
    version: manifest.version,
  };

  const created = await createPlugin(db, {
    ownerAccountId: params.ownerAccountId,
    manifest: forked,
    code: latest.code,
    changelog: `fork of ${source.name}@${latest.version}`,
    visibility: "private",
    source: source.source,
    sourceRef: source.source_ref,
  });
  return { id: created.id, version: created.version };
}

export async function setPluginSource(
  db: D1Database,
  pluginId: string,
  source: "local" | "gist" | "github",
  sourceRef: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE plugins SET source = ?, source_ref = ?, updated_at = ? WHERE id = ?")
    .bind(source, sourceRef, now(), pluginId)
    .run();
}

export { installRowToInfo, rowToSummary };