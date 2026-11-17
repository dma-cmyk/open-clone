// プラグインレジストリの D1 操作（DESIGN §7.3 のライフサイクル）。
// ルートハンドラは HTTP の関心事のみを持ち、状態遷移・検索・導入・審査はここに集約する。

import {
  ApiError,
  PLUGIN_ANON_MAX_PER_DEVICE,
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
  type PluginReportGroup,
  type PluginReportInfo,
  type PluginReportReason,
  type PluginReportReasonCounts,
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
  /** 端末所有（匿名作成）。owner_account_id と排他。非 NULL なら端末所有、両方 NULL なら公式。 */
  owner_device_hash: string | null;
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
    ownership:
      row.owner_account_id !== null
        ? "account"
        : row.owner_device_hash !== null
          ? "device"
          : "official",
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

/** ID だけで引く（名前へのフォールバックをしない）。トークン経路の入力を ID に限定する。 */
export async function getPluginRowById(db: D1Database, id: string): Promise<PluginRow | null> {
  return db
    .prepare(`${PLUGIN_SELECT} WHERE p.id = ?`)
    .bind(id)
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

/**
 * 検索・一覧。cursor は offset の base64。
 *
 * 端末所有プラグイン（owner_device_hash 非 NULL）の扱い:
 * - ownerDeviceHash を指定した場合のみ、その端末の所有行を返す（自分のプラグイン用）。
 * - 指定がなければ公開一覧・検索・マイページのいずれにも出さない
 *   （所有端末以外からは存在しないものとして扱う。報告 40 の設計）。
 */
export async function listPlugins(
  db: D1Database,
  options: {
    q?: string;
    scope?: PluginScope;
    sort?: "updated" | "popular" | "new";
    limit: number;
    cursor?: string;
    ownerAccountId?: string;
    /** 端末所有のプラグインをこの端末のものに限定して返す（匿名の「自分のプラグイン」）。 */
    ownerDeviceHash?: string;
    includeAllStatuses?: boolean;
    /** レジストリ状態での絞り込み（`/mcp-plugin` の authoring.list 用）。 */
    status?: PluginStatus;
    /** サイト運営（isAdmin）の一覧。端末所有のプラグインも表示する管理用途。 */
    includeDeviceOwned?: boolean;
  },
): Promise<PluginListPage> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (options.ownerAccountId) {
    where.push("p.owner_account_id = ?");
    params.push(options.ownerAccountId);
  }
  if (options.ownerDeviceHash) {
    // 端末の「自分のプラグイン」: 端末所有行（＋後に引き継いだアカウント所有行は account 側で別途）
    where.push("p.owner_device_hash = ?");
    params.push(options.ownerDeviceHash);
  }
  if (!options.ownerDeviceHash && !options.includeDeviceOwned) {
    // 公開一覧・検索・アカウントのマイページから端末所有を除外
    where.push("p.owner_device_hash IS NULL");
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

/**
 * 詳細（バージョン・導入・閲覧者権限を含む）。
 * 端末所有プラグインは所有端末かサイト運営（isAdmin）以外に 404（存在しないものとして扱う）。
 */
export async function getPluginDetail(
  db: D1Database,
  row: PluginRow,
  viewer: {
    accountId: string | null;
    deviceHash: string;
    isAdmin: boolean;
  },
): Promise<PluginDetail> {
  const deviceOwned = row.owner_account_id === null && row.owner_device_hash !== null;
  // 所有者判定: アカウント所有（owner_account_id 一致）or 端末所有（匿名で device 一致）
  const isOwner =
    (row.owner_account_id !== null &&
      viewer.accountId !== null &&
      row.owner_account_id === viewer.accountId) ||
    (deviceOwned &&
      viewer.accountId === null &&
      row.owner_device_hash === viewer.deviceHash);
  const canSeeUnapproved = isOwner || viewer.isAdmin;

  // 端末所有は所有端末・サイト運営以外に見せない（板管理人も含む。報告 40 設計）
  if (deviceOwned && !isOwner && !viewer.isAdmin) {
    throw ApiError.notFound("プラグインが見つかりません");
  }
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
  /** アカウント所有者（ログイン時）。匿名作成では null。 */
  ownerAccountId: string | null;
  /** 端末所有者（匿名作成時）。ownerAccountId とは排他。両方 null は作成時に許さない。 */
  ownerDeviceHash?: string | null;
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
  // 排他の強制: 両方 null（公式を名乗る）は作成経路では許さない
  if (params.ownerAccountId === null && !params.ownerDeviceHash) {
    throw ApiError.validation("所有者（アカウントまたは端末）が必要です");
  }
  if (params.ownerAccountId !== null && params.ownerDeviceHash) {
    throw ApiError.validation("アカウント所有と端末所有を同時には設定できません");
  }

  const existing = await db
    .prepare("SELECT id FROM plugins WHERE name = ?")
    .bind(params.manifest.name)
    .first<{ id: string }>();
  if (existing) throw ApiError.conflict(`プラグイン名 '${params.manifest.name}' は既に使われています`);

  const id = ulid();
  const timestamp = now();
  const codeHash = await sha256Hex(params.code);

  // R42-01 + R44-03: 端末あたりの保有数上限を INSERT の条件に入れて原子的に保証し、
  // 本体と初期版を同じバッチ（= 1 トランザクション）で保存する。
  //
  // 構造:
  // 1. 端末所有: 条件付き INSERT（上限 < 10 のときだけ本体を挿入）
  //    + 条件付き INSERT の版（本体が挿入された場合だけ版を挿入）
  // 2. アカウント所有: 従来どおり無条件 INSERT × 2 をバッチで
  //
  // 上限に達した場合（本体が 0 行）は版の条件（EXISTS）も不成立になるため、
  // 版は挿入されず、バッチ全体が成功（0 changes）として完了する。
  // その後 changes を確認して 403 を返す。
  if (params.ownerDeviceHash) {
    const results = await db.batch([
      // 本体: 端末あたり 10 個未満のときだけ挿入（1 文 = アトミック）
      db
        .prepare(
          `INSERT INTO plugins (
             id, owner_account_id, owner_device_hash, name, summary, description, manifest_json, scopes,
             status, visibility, latest_version, source, source_ref,
             install_count, report_count, flagged, license, kill_seq,
             created_at, updated_at, published_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0, 0, 0, ?, 0, ?, ?, NULL
           WHERE (SELECT COUNT(*) FROM plugins WHERE owner_device_hash = ?) < ?`,
        )
        .bind(
          id,
          params.ownerAccountId,
          params.ownerDeviceHash,
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
          params.ownerDeviceHash,
          PLUGIN_ANON_MAX_PER_DEVICE,
        ),
      // 版: 本体が挿入された場合だけ挿入（EXISTS で確認。上限で本体が 0 行なら版も 0 行）
      db
        .prepare(
          `INSERT INTO plugin_versions
             (plugin_id, version, code, code_hash, manifest_json, changelog, status, created_by, created_at)
           SELECT ?, ?, ?, ?, ?, ?, 'approved', ?, ?
           WHERE EXISTS (SELECT 1 FROM plugins WHERE id = ?)`,
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
          id,
        ),
    ]);
    const parentResult = results[0];
    if ((parentResult?.meta.changes ?? 0) === 0) {
      // 上限超過（本体が挿入されず、版も挿入されていない = アトミック）
      throw ApiError.forbidden(
        `このブラウザで作れるプラグインは ${PLUGIN_ANON_MAX_PER_DEVICE} 個までです。不要なものを削除するか、ログインして引き継いでください`,
      );
    }
  } else {
    // アカウント所有: 従来どおり本体・版を 1 バッチで（元の原子性）
    await db.batch([
      db
        .prepare(
          `INSERT INTO plugins (
             id, owner_account_id, owner_device_hash, name, summary, description, manifest_json, scopes,
             status, visibility, latest_version, source, source_ref,
             install_count, report_count, flagged, license, kill_seq,
             created_at, updated_at, published_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 0, 0, 0, ?, 0, ?, ?, NULL)`,
        )
        .bind(
          id,
          params.ownerAccountId,
          params.ownerDeviceHash ?? null,
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
  }

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
    actorAccountId: string | null;
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

/**
 * 作者自身の導入の条件（R1-N: NULL 安全）。
 * 「scope=personal かつ 作者IDが非NULL かつ installed_byが非NULL かつ 両者が一致」
 * だけを作者本人とみなす。owner=NULL・installed_by=NULL・帰属不明は全て他者扱い。
 * SQLite で `installed_by <> ?`（NULL で UNKNOWN）にならないよう、NULL は先に分岐で落とす。
 */
export const OWN_INSTALL_CONDITION = `scope = 'personal' AND installed_by IS NOT NULL AND ? IS NOT NULL AND installed_by = ?`;

/**
 * 作者以外の導入の件数（レビュー B4-R1 の削除保護。R1-N: NULL 安全版＋端末所有対応）。
 * - board / site スコープは常に「他者への影響がある導入」として数える。
 * - personal は「作者自身の導入」だけを除外する:
 *   - アカウント所有: installed_by が非 NULL で作者アカウント ID と一致
 *   - 端末所有: installed_by が非 NULL で owner_device_hash の `device:` スコープ ref と一致
 *   - 公式（両方 NULL）: 誰の導入も作者本人にならない（全件保護）
 * - 匿名端末の device 不一致・installed_by=NULL・帰属不明は全て保護対象。
 */
export async function countForeignInstalls(
  db: D1Database,
  pluginId: string,
  ownership: { ownerAccountId: string | null; ownerDeviceHash: string | null },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM plugin_installs
       WHERE plugin_id = ?
         AND NOT (${ownInstallConditionFor(ownership)})`,
    )
    .bind(...ownInstallBindingsFor(ownership, [pluginId]))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 作者自身の導入の条件（ownership に応じOWN_INSTALL_CONDITION か端末版を選ぶ）。 */
function ownInstallConditionFor(ownership: {
  ownerAccountId: string | null;
  ownerDeviceHash: string | null;
}): string {
  if (ownership.ownerDeviceHash) {
    // 端末所有: その端末の個人用導入（scope_ref と installed_by の両方が device:<hash>）
    return `scope = 'personal' AND installed_by IS NOT NULL AND installed_by = ?`;
  }
  return OWN_INSTALL_CONDITION;
}

/** ownInstallConditionFor の `?` に束縛する値（prefix = 事前に束縛済みの値の並び）。 */
function ownInstallBindingsFor(
  ownership: { ownerAccountId: string | null; ownerDeviceHash: string | null },
  prefix: unknown[],
): unknown[] {
  if (ownership.ownerDeviceHash) {
    return [...prefix, `device:${ownership.ownerDeviceHash}`];
  }
  return [...prefix, ownership.ownerAccountId, ownership.ownerAccountId];
}

/**
 * プラグインの実削除（レビュー B4/R1-C: 判定と削除の原子化）。
 *
 * すべての削除文に「他者の導入が存在しない」こと（NULL 安全な R1-N 条件）を
 * 付けて 1 つの D1 バッチ（= 1 トランザクション）で実行する:
 * - トランザクション開始後に他者の導入が 1 件でも存在すれば（含む: 判定直前に
 *   確定した新規導入）、どの文も条件を満たさず何も削除されない。
 * - 本体（plugins）の削除結果の行数で成否を返す。0 行なら 409 にする。
 * - トランザクション外で本体削除の後に挟まった新規導入は、子テーブルの FK
 *   （plugin_installs.plugin_id REFERENCES plugins(id)）により INSERT 時点で失敗する。
 *
 * plugin_net_log / plugin_ai_log は監査証跡として残す。監査ログ（audit_log）は
 * writeAudit で残るため、削除操作自体は追跡可能。
 *
 * @returns deleted: 本体を削除できたか。false は他者の導入があって拒否された場合。
 */
export async function deletePlugin(
  db: D1Database,
  pluginId: string,
  ownership: { ownerAccountId: string | null; ownerDeviceHash: string | null },
): Promise<{ deleted: boolean }> {
  const own = ownInstallConditionFor(ownership);
  const noForeign = `NOT EXISTS (
    SELECT 1 FROM plugin_installs
    WHERE plugin_id = ? AND NOT (${own})
  )`;
  // 全文共通の束縛値（plugin_id ×2 + 本人条件の値）。binds() の重複を避けるため一度だけ作る。
  const bindValues = ownInstallBindingsFor(ownership, [pluginId, pluginId]);

  // 1 バッチ = 1 トランザクション。各文が同じ条件を再判定するため、
  // 途中の文で保護条件が変わっても（並行導入）、以降の文は何も消さない。
  const results = await db.batch([
    db.prepare(`DELETE FROM plugin_installs WHERE plugin_id = ? AND ${noForeign}`).bind(...bindValues),
    db.prepare(`DELETE FROM plugin_state WHERE plugin_id = ? AND ${noForeign}`).bind(...bindValues),
    db.prepare(`DELETE FROM plugin_reviews WHERE plugin_id = ? AND ${noForeign}`).bind(...bindValues),
    db.prepare(`DELETE FROM plugin_reports WHERE plugin_id = ? AND ${noForeign}`).bind(...bindValues),
    db.prepare(`DELETE FROM plugin_versions WHERE plugin_id = ? AND ${noForeign}`).bind(...bindValues),
    db.prepare(`DELETE FROM plugins WHERE id = ? AND ${noForeign}`).bind(...bindValues),
  ]);

  // 本体（最後の文）が削除できたかで成否を判定する。
  const parentResult = results[results.length - 1];
  return { deleted: (parentResult?.meta.changes ?? 0) === 1 };
}
/** ページに適用される導入（personal + その板 + site）。停止済みも stopped フラグ付きで返す。 */
export async function listActiveInstalls(
  db: D1Database,
  params: {
    scopeRefs: { scope: PluginScope; ref: string }[];
    viewerAccountId?: string | null;
    /** R42-06: 端末所有者の判定用（未公開新版の本人プレビューを許す） */
    viewerDeviceHash?: string | null;
  },
): Promise<PluginActiveInstall[]> {
  const clauses = params.scopeRefs.map(() => "(i.scope = ? AND i.scope_ref = ?)");
  if (params.scopeRefs.length === 0) return [];
  const bindings: unknown[] = [];
  for (const ref of params.scopeRefs) {
    bindings.push(ref.scope, ref.ref);
  }

  const result = await db
    .prepare(
      `SELECT i.*, p.name, p.status AS plugin_status, p.owner_account_id, p.owner_device_hash,
              p.manifest_json AS plugin_manifest, v.manifest_json AS version_manifest, v.status AS version_status
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
        owner_device_hash: string | null;
        plugin_manifest: string;
        version_manifest: string | null;
        version_status: string | null;
      }
    >();

  return (result.results ?? []).map((row) => {
    // R42-06: 所有者の本人プレビュー判定に端末所有を加える。
    // - アカウント所有: viewerAccountId が owner_account_id と一致
    // - 端末所有: viewerDeviceHash が owner_device_hash と一致（かつ viewerAccountId は null、
    //   つまり匿名のリクエスト。NULL 同士（公式）を本人と扱わない条件）
    const ownerPreview =
      row.scope === "personal" &&
      ((params.viewerAccountId != null && row.owner_account_id === params.viewerAccountId) ||
        (params.viewerAccountId == null &&
          row.owner_device_hash !== null &&
          row.owner_device_hash === params.viewerDeviceHash));
    // 停止理由を分けて返す（レビュー B5: 表示と実際の効果を一致させる）。
    let stoppedReason: string | null = null;
    if (row.plugin_status === "disabled") {
      stoppedReason = "プラグイン全体が停止（キルスイッチ）中です。停止が解除されるまで効果はありません";
    } else if (!row.version_manifest) {
      stoppedReason = "導入済みバージョンがレジストリに存在しません（版が差し替えられた可能性）";
    } else if (row.version_status !== "approved" && !ownerPreview) {
      stoppedReason = "導入済みバージョンは承認されていません（公開申請中か差し戻し中）";
    }
    return {
      installId: row.id,
      pluginId: row.plugin_id,
      name: row.name,
      version: row.version,
      scope: row.scope,
      scopeRef: row.scope_ref,
      stopped: stoppedReason !== null,
      stoppedReason,
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
    handledAt: null,
  };
}

/**
 * 通報一覧（新しい順）。
 * 通報者の種別・ID は呼び出し側が権限に応じて落とす（作者には出さない）。
 */
export async function listReports(
  db: D1Database,
  pluginId: string,
  limit = 50,
): Promise<PluginReportInfo[]> {
  const result = await db
    .prepare("SELECT * FROM plugin_reports WHERE plugin_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(pluginId, limit)
    .all<{
      id: string;
      plugin_id: string;
      version: string | null;
      reporter_kind: "account" | "device";
      reporter_id: string;
      reason: PluginReportReason;
      detail: string | null;
      status: "open" | "resolved" | "dismissed";
      handled_at: number | null;
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
    handledAt: row.handled_at,
    reporterKind: row.reporter_kind,
    reporterId: row.reporter_id,
  }));
}

/** 未対応（status=open）の通報件数。 */
export async function countOpenReports(db: D1Database, pluginId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM plugin_reports WHERE plugin_id = ? AND status = 'open'")
    .bind(pluginId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * 通報への対応（対応済み / 却下）。サイト管理者だけが呼ぶ（ルート側で強制）。
 * - report_count は累計の意味なので変えない。
 * - 条件付き UPDATE で二重対応を防ぐ（同時押しは片方だけ通る）。
 * - 未対応が 0 件になったら `flagged`（要確認）を外す。
 */
export async function handleReport(
  db: D1Database,
  reportId: string,
  params: { status: "resolved" | "dismissed"; handledBy: string },
): Promise<{ pluginId: string; openCount: number }> {
  const row = await db
    .prepare("SELECT id, plugin_id, status FROM plugin_reports WHERE id = ?")
    .bind(reportId)
    .first<{ id: string; plugin_id: string; status: "open" | "resolved" | "dismissed" }>();
  if (!row) throw ApiError.notFound("通報が見つかりません");

  const timestamp = now();
  const updated = await db
    .prepare(
      "UPDATE plugin_reports SET status = ?, handled_by = ?, handled_at = ? WHERE id = ? AND status = 'open'",
    )
    .bind(params.status, params.handledBy, timestamp, row.id)
    .run();
  if ((updated.meta.changes ?? 0) === 0) {
    throw ApiError.conflict("この通報は既に対応済みです");
  }

  const openCount = await countOpenReports(db, row.plugin_id);
  if (openCount === 0) {
    await db.prepare("UPDATE plugins SET flagged = 0 WHERE id = ? AND flagged = 1").bind(row.plugin_id).run();
  }
  return { pluginId: row.plugin_id, openCount };
}

/**
 * 通報があるプラグインの集計（管理画面のプラグインタブ）。
 * 既定は未対応の通報が残っているプラグインだけを、未対応の最新通報が新しい順に返す。
 * `includeResolved` で対応済みしか残っていないプラグインも含める（全通報の新しい順）。
 */
export async function listReportedPlugins(
  db: D1Database,
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<PluginReportGroup[]> {
  const includeResolved = options.includeResolved === true;
  const limit = Math.min(options.limit ?? 200, 200);
  const having = includeResolved
    ? ""
    : "HAVING SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) > 0";
  const order = includeResolved ? "g.latest_report_at DESC" : "g.latest_open_at DESC";

  const result = await db
    .prepare(
      `SELECT g.plugin_id, g.total_count, g.open_count, g.latest_report_at, g.latest_open_at,
              g.open_malicious, g.open_spam, g.open_broken, g.open_inappropriate, g.open_other,
              p.name, p.latest_version, p.status, p.flagged,
              p.owner_account_id, p.owner_device_hash, a.name AS owner_name
         FROM (
           SELECT plugin_id,
                  COUNT(*) AS total_count,
                  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
                  MAX(created_at) AS latest_report_at,
                  MAX(CASE WHEN status = 'open' THEN created_at END) AS latest_open_at,
                  SUM(CASE WHEN status = 'open' AND reason = 'malicious' THEN 1 ELSE 0 END) AS open_malicious,
                  SUM(CASE WHEN status = 'open' AND reason = 'spam' THEN 1 ELSE 0 END) AS open_spam,
                  SUM(CASE WHEN status = 'open' AND reason = 'broken' THEN 1 ELSE 0 END) AS open_broken,
                  SUM(CASE WHEN status = 'open' AND reason = 'inappropriate' THEN 1 ELSE 0 END) AS open_inappropriate,
                  SUM(CASE WHEN status = 'open' AND reason = 'other' THEN 1 ELSE 0 END) AS open_other
             FROM plugin_reports
            GROUP BY plugin_id
            ${having}
         ) g
         JOIN plugins p ON p.id = g.plugin_id
         LEFT JOIN accounts a ON a.id = p.owner_account_id
        ORDER BY ${order}, g.plugin_id DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{
      plugin_id: string;
      total_count: number;
      open_count: number;
      latest_report_at: number;
      latest_open_at: number | null;
      open_malicious: number;
      open_spam: number;
      open_broken: number;
      open_inappropriate: number;
      open_other: number;
      name: string;
      latest_version: string | null;
      status: PluginStatus;
      flagged: number;
      owner_account_id: string | null;
      owner_device_hash: string | null;
      owner_name: string | null;
    }>();

  return (result.results ?? []).map((row) => {
    const byReason: PluginReportReasonCounts = {
      malicious: row.open_malicious ?? 0,
      spam: row.open_spam ?? 0,
      broken: row.open_broken ?? 0,
      inappropriate: row.open_inappropriate ?? 0,
      other: row.open_other ?? 0,
    };
    return {
      pluginId: row.plugin_id,
      name: row.name,
      latestVersion: row.latest_version,
      status: row.status,
      ownership:
        row.owner_account_id !== null
          ? "account"
          : row.owner_device_hash !== null
            ? "device"
            : "official",
      ownerName: row.owner_name,
      openCount: row.open_count ?? 0,
      totalCount: row.total_count ?? 0,
      byReason,
      latestReportAt: row.latest_report_at,
      latestOpenAt: row.latest_open_at,
      flagged: row.flagged === 1,
    };
  });
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