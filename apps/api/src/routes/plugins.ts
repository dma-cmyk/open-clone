// プラグイン REST API（/v1/plugins/*）。
// レジストリ（作成・版管理・公開・検索・導入・更新・通報・停止）と GitHub/Gist 連携の入口。
// 権限・状態遷移の実体は services/plugins/* に置き、ここでは HTTP とアクター解決のみ行う。

import { Hono } from "hono";
import {
  ApiError,
  ErrorCode,
  hmacSha256Hex,
  ok,
  pluginCreateSchema,
  pluginDisableSchema,
  pluginExportRepoSchema,
  pluginForkSchema,
  pluginGistExportSchema,
  pluginGistImportSchema,
  pluginInstallSchema,
  pluginListQuerySchema,
  pluginActiveQuerySchema,
  pluginPreviewCheckSchema,
  pluginPublishSchema,
  pluginReportSchema,
  pluginRepoImportSchema,
  pluginStateQuerySchema,
  pluginStateSetSchema,
  pluginReviewDecisionSchema,
  pluginUninstallSchema,
  pluginUpdateSchema,
  pluginVersionCreateSchema,
  timingSafeEqual,
  type PluginManifest,
  type PluginPermission,
  type PluginScope,
} from "shared";
import type { AppEnv } from "../lib/env";
import { toErrorResponse } from "../lib/middleware/error";
import { getReqCtx } from "../lib/context";
import { assertReadRateLimit } from "../lib/do";
import { requireAuth, requireRole } from "../lib/middleware/auth";
import { writeAudit } from "../lib/audit";
import { runStaticChecks } from "../services/plugins/static-checks";
import { emitPluginReviewRequested } from "../services/ai/events";
import {
  assertBoardStopPermission,
  assertInstallPermission,
  isBoardStaff,
  pluginActorFrom,
  scopeRefFor,
  type PluginActor,
} from "../services/plugins/access";
import {
  addVersion,
  createPlugin,
  decideReview,
  disablePlugin,
  enablePlugin,
  findInstall,
  forkPlugin,
  getPluginDetail,
  getPluginRow,
  getReviewRow,
  getVersionRow,
  installPlugin,
  listActiveInstalls,
  listPlugins,
  listReports,
  listReviewQueue,
  listVersions,
  parseManifest,
  publishPlugin,
  recordReport,
  resolveInstallVersion,
  setPluginSource,
  stateDelete,
  stateGet,
  stateList,
  stateSet,
  uninstallPlugin,
  updateInstallVersion,
  type ReviewRow,
} from "../services/plugins/registry";
import {
  exportPluginToGist,
  exportPluginToRepo,
  fetchGistSource,
  fetchRepoSource,
  fetchSourceByRef,
  parseGistId,
} from "../services/plugins/github-sync";

const app = new Hono<AppEnv>();

// サブアプリの onError を設定する。Hono の route() はサブアプリの errorHandler が既定値だと
// 例外を親の既定ハンドラ（500 text）で握りつぶすため、envelope 変換をここで明示する。
app.onError((error) => {
  const { status, body } = toErrorResponse(error);
  return Response.json(body, { status });
});

// ─── 共通ヘルパ ───────────────────────────────────────────────────

async function loadPlugin(db: D1Database, idOrName: string) {
  const plugin = await getPluginRow(db, idOrName);
  if (!plugin) throw ApiError.notFound("プラグインが見つかりません");
  return plugin;
}

function isOwner(actor: PluginActor, ownerAccountId: string | null): boolean {
  return actor.accountId !== null && ownerAccountId === actor.accountId;
}

/** オーナー or サイト管理者でなければ 403。 */
function assertPluginEditor(actor: PluginActor, ownerAccountId: string | null): void {
  if (isOwner(actor, ownerAccountId) || actor.isAdmin) return;
  throw ApiError.forbidden("プラグインの所有者またはサイト管理者のみ操作できます");
}

/** コードが実際に使いそうな RPC と permission 宣言の突き合わせ（審査の補助）。 */
function manifestPermissionWarnings(manifest: PluginManifest, code: string): string[] {
  const warnings: string[] = [];
  const checks: { needle: string; permission: PluginPermission; label: string }[] = [
    { needle: "net.fetch", permission: "net:fetch", label: "net.fetch" },
    { needle: "storage.set", permission: "storage:shared", label: "storage.set" },
    { needle: "storage.get", permission: "storage:shared", label: "storage.get" },
    { needle: "data.post.create", permission: "data:write:post", label: "data.post.create" },
    { needle: "github.gist", permission: "github:gist", label: "github.gist" },
    { needle: "github.repo", permission: "github:repo", label: "github.repo" },
    { needle: "upload.start", permission: "upload:start", label: "upload.start" },
    { needle: "ai.complete", permission: "ai:complete", label: "ai.complete" },
    { needle: "events.subscribe", permission: "events:subscribe", label: "events.subscribe" },
  ];
  for (const check of checks) {
    if (code.includes(check.needle) && !manifest.permissions.includes(check.permission)) {
      warnings.push(`${check.label} を呼んでいますが ${check.permission} 権限が宣言されていません`);
    }
  }
  return warnings;
}

function queryObject(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

// ─── 一覧・検索・自分のプラグイン ───────────────────────────────────

app.get("", async (c) => {
  await assertReadRateLimit(c.env, "readList", getReqCtx(c).device.ipHash);
  const query = pluginListQuerySchema.parse(queryObject(c.req.url));
  const actor = pluginActorFrom(getReqCtx(c));
  const mine = query.mine === true;

  if (mine && !actor.accountId) throw ApiError.unauthorized();

  const page = await listPlugins(c.env.DB, {
    q: query.q,
    scope: query.scope,
    sort: query.sort,
    limit: query.limit,
    cursor: query.cursor,
    ownerAccountId: mine ? (actor.accountId ?? undefined) : undefined,
    includeAllStatuses: mine,
  });
  return c.json(ok(page));
});

app.get("/mine", requireAuth, async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 100);
  const page = await listPlugins(c.env.DB, {
    limit,
    ownerAccountId: actor.accountId ?? "",
    includeAllStatuses: true,
    sort: "updated",
  });
  return c.json(ok(page));
});

/** ページに適用されるプラグイン（ホストが実行対象を取得する）。 */
app.get("/active", async (c) => {
  const query = pluginActiveQuerySchema.parse(queryObject(c.req.url));
  const actor = pluginActorFrom(getReqCtx(c));

  // WP2 のスロット文脈は boardSlug のみのため、boards テーブルから ID を解決する。
  let boardId = query.boardId ?? null;
  if (!boardId && query.boardSlug) {
    try {
      const row = await c.env.DB.prepare("SELECT id FROM boards WHERE slug = ?")
        .bind(query.boardSlug)
        .first<{ id: number }>();
      if (row) boardId = row.id;
    } catch {
      // boards テーブル未作成（WP1 未適用）時は板スコープを解決しない
      boardId = null;
    }
  }

  const refs: { scope: PluginScope; ref: string }[] = [
    { scope: "site", ref: "site" },
    { scope: "personal", ref: actor.accountId ?? `device:${actor.deviceHash}` },
  ];
  if (boardId) refs.push({ scope: "board", ref: String(boardId) });

  const items = await listActiveInstalls(c.env.DB, {
    scopeRefs: refs,
    viewerAccountId: actor.accountId,
  });
  return c.json(ok({ items, boardId, threadId: query.threadId ?? null }));
});

/** 指定スコープの導入一覧（UI 用）。 */
app.get("/installed", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const scope = c.req.query("scope");
  const boardId = Number(c.req.query("boardId") ?? "0");

  const where: string[] = [];
  const params: unknown[] = [];
  if (scope === "personal") {
    where.push("scope = 'personal' AND scope_ref = ?");
    params.push(actor.accountId ?? `device:${actor.deviceHash}`);
  } else if (scope === "board") {
    if (!Number.isInteger(boardId) || boardId <= 0) throw ApiError.validation("boardId が必要です");
    where.push("scope = 'board' AND scope_ref = ?");
    params.push(String(boardId));
  } else if (scope === "site") {
    where.push("scope = 'site'");
  } else {
    throw ApiError.validation("scope は personal / board / site のいずれかです");
  }

  const result = await c.env.DB.prepare(
    `SELECT i.*, p.name, p.manifest_json, p.status AS plugin_status
     FROM plugin_installs i JOIN plugins p ON p.id = i.plugin_id
     WHERE ${where.join(" AND ")}
     ORDER BY i.updated_at DESC LIMIT 100`,
  )
    .bind(...params)
    .all<{
      id: string;
      plugin_id: string;
      scope: PluginScope;
      scope_ref: string;
      version: string;
      pinned: number;
      enabled: number;
      installed_by: string | null;
      created_at: number;
      updated_at: number;
      name: string;
      manifest_json: string;
      plugin_status: string;
    }>();

  return c.json(
    ok({
      items: (result.results ?? []).map((row) => ({
        id: row.id,
        pluginId: row.plugin_id,
        name: row.name,
        scope: row.scope,
        scopeRef: row.scope_ref,
        version: row.version,
        pinned: row.pinned === 1,
        enabled: row.enabled === 1,
        pluginStatus: row.plugin_status,
        manifest: parseManifest(row.manifest_json),
        installedBy: row.installed_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    }),
  );
});

// ─── 審査キュー ────────────────────────────────────────────────────

app.get("/reviews", requireRole("owner", "special_admin"), async (c) => {
  const status = c.req.query("status");
  const scope = c.req.query("scope");
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 100);
  const items = await listReviewQueue(c.env.DB, {
    status: status === "pending" || status === "approved" || status === "rejected" ? status : undefined,
    scope: scope === "board" || scope === "site" ? scope : undefined,
    limit,
  });
  return c.json(ok({ items }));
});

// ─── エディタ支援・GitHub 取込・webhook ───────────────────────────

app.post("/preview-check", requireAuth, async (c) => {
  const body = pluginPreviewCheckSchema.parse(await c.req.json());
  const checks = await runStaticChecks(body.code);
  const warnings = body.manifest ? manifestPermissionWarnings(body.manifest, body.code) : [];
  return c.json(ok({ checks, warnings }));
});

app.post("/import/gist", requireAuth, async (c) => {
  const body = pluginGistImportSchema.parse(await c.req.json());
  const actor = pluginActorFrom(getReqCtx(c));
  const source = await fetchGistSource(parseGistId(body.gist));

  const created = await createPlugin(c.env.DB, {
    ownerAccountId: actor.accountId!,
    manifest: source.manifest,
    code: source.code,
    changelog: `imported from gist`,
    visibility: "private",
    source: "gist",
    sourceRef: source.sourceRef,
  });
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.import.gist",
    target: created.id,
    detail: { gist: body.gist },
  });
  return c.json(ok({ id: created.id, name: source.manifest.name, version: created.version, source: "gist" }), 201);
});

app.post("/import/repo", requireAuth, async (c) => {
  const body = pluginRepoImportSchema.parse(await c.req.json());
  const actor = pluginActorFrom(getReqCtx(c));
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(body.repo.trim());
  const source = short?.[1] && short[2]
    ? await fetchRepoSource({ owner: short[1], repo: short[2], ref: "HEAD", path: "" })
    : await fetchRepoSource(parseRepoUrl(body.repo));

  const created = await createPlugin(c.env.DB, {
    ownerAccountId: actor.accountId!,
    manifest: source.manifest,
    code: source.code,
    changelog: "imported from GitHub repository",
    visibility: "private",
    source: "github",
    sourceRef: source.sourceRef,
  });
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.import.repo",
    target: created.id,
    detail: { repo: body.repo },
  });
  return c.json(ok({ id: created.id, name: source.manifest.name, version: created.version, source: "github" }), 201);
});

/**
 * GitHub webhook（push）。署名は専用 secret を鍵とした HMAC-SHA256。
 * 表示 ID 用の ID_SALT は流用しない（役割分離 / M-5）。未設定時のみ後方互換で
 * GITHUB_WEBHOOK_SECRET → ID_SALT の順にフォールバックする。
 */
app.post("/hooks/github", async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const hookSecret = c.env.GITHUB_PLUGIN_HOOK_SECRET ?? c.env.GITHUB_WEBHOOK_SECRET ?? c.env.ID_SALT;
  const expected = `sha256=${await hmacSha256Hex(hookSecret, raw)}`;
  if (!timingSafeEqual(signature.toLowerCase(), expected.toLowerCase())) {
    throw new ApiError(401, ErrorCode.UNAUTHORIZED, "webhook 署名が不正です");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw ApiError.validation("payload が JSON として不正です");
  }
  const repository = readNestedString(payload, ["repository", "full_name"]);
  if (!repository) throw ApiError.validation("repository.full_name がありません");

  // source_ref の repo と一致するプラグインを探して更新を検知する（初回実装は全 github ソース走査）
  const rows = await c.env.DB.prepare(
    "SELECT * FROM plugins WHERE source = 'github' ORDER BY updated_at DESC LIMIT 200",
  ).all<{ id: string; source_ref: string | null; latest_version: string | null }>();

  const updated: { pluginId: string; version: string }[] = [];
  for (const row of rows.results ?? []) {
    if (!row.source_ref || !row.source_ref.includes(repository)) continue;
    try {
      const plugin = await loadPlugin(c.env.DB, row.id);
      const source = await fetchSourceByRef("github", plugin.source_ref);
      const fetchedVersion = source.manifest.version;
      if (!plugin.latest_version || compareVersionStrings(fetchedVersion, plugin.latest_version) > 0) {
        const result = await addVersion(c.env.DB, plugin, {
          version: fetchedVersion,
          manifest: source.manifest,
          code: source.code,
          changelog: "GitHub push による自動取込",
          actorAccountId: plugin.owner_account_id ?? "",
        });
        updated.push({ pluginId: plugin.id, version: result.version });
      }
    } catch (error) {
      console.warn("plugin github sync failed", row.id, error);
    }
  }

  return c.json(ok({ repository, updated }));
});

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return null;
    // typeof で object を確認済み。外部 JSON のキー読み出しなので Reflect で安全に取り出す。
    current = Reflect.get(current, key);
  }
  return typeof current === "string" ? current : null;
}

function parseRepoUrl(input: string): { owner: string; repo: string; ref: string; path: string } {
  const match = /github\.com\/([^/]+)\/([^/?#]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?$/.exec(input.trim());
  if (!match?.[1] || !match[2]) {
    throw ApiError.validation("リポジトリは 'owner/repo' か GitHub URL で指定してください");
  }
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ""),
    ref: match[3] ?? "HEAD",
    path: match[4] ? `${match[4].replace(/\/?$/, "/")}` : "",
  };
}

function compareVersionStrings(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// ─── 作成 ──────────────────────────────────────────────────────────

app.post("", requireAuth, async (c) => {
  const body = pluginCreateSchema.parse(await c.req.json());
  const actor = pluginActorFrom(getReqCtx(c));
  const checks = await runStaticChecks(body.code);
  const warnings = manifestPermissionWarnings(body.manifest, body.code);

  const created = await createPlugin(c.env.DB, {
    ownerAccountId: actor.accountId!,
    manifest: body.manifest,
    code: body.code,
    changelog: body.changelog,
    visibility: body.visibility,
  });

  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.create",
    target: created.id,
    detail: { name: body.manifest.name, version: created.version },
  });

  return c.json(ok({ id: created.id, name: body.manifest.name, version: created.version, checks, warnings }), 201);
});

// ─── 個別プラグイン ────────────────────────────────────────────────

app.get("/:id", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const detail = await getPluginDetail(c.env.DB, plugin, {
    accountId: actor.accountId,
    deviceHash: actor.deviceHash,
    isAdmin: actor.isAdmin,
  });
  return c.json(ok(detail));
});

app.get("/:id/versions", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const canSeeUnapproved = plugin.status === "published" || isOwner(actor, plugin.owner_account_id) || actor.isAdmin;
  if (!canSeeUnapproved) throw ApiError.notFound("プラグインが見つかりません");
  const versions = await listVersions(c.env.DB, plugin.id, {
    includeUnapproved: isOwner(actor, plugin.owner_account_id) || actor.isAdmin,
  });
  return c.json(
    ok({
      items: versions.map((row) => ({
        version: row.version,
        changelog: row.changelog,
        codeHash: row.code_hash,
        status: row.status,
        createdAt: row.created_at,
      })),
    }),
  );
});

/** コード配信。バージョン固定 URL は不変キャッシュ（DESIGN §7.2）。 */
app.get("/:id/code", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const requestedVersion = c.req.query("version") ?? plugin.latest_version;
  if (!requestedVersion) throw ApiError.notFound("バージョンが指定されていません");

  const row = await getVersionRow(c.env.DB, plugin.id, requestedVersion);
  if (!row) throw ApiError.notFound("バージョンが見つかりません");

  const privileged = isOwner(actor, plugin.owner_account_id) || actor.isAdmin;
  if (plugin.status === "disabled" && !privileged) {
    return c.body("/* plugin disabled */\n", 410, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-plugin-stopped": "1",
    });
  }
  if (!privileged && (plugin.status !== "published" || row.status !== "approved")) {
    throw ApiError.notFound("このバージョンは配信されていません");
  }

  const etag = `"${row.code_hash}"`;
  if (c.req.header("if-none-match") === etag) {
    return c.body(null, 304, { etag });
  }

  const pinned = Boolean(c.req.query("version"));
  return c.body(row.code, 200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": pinned
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300, must-revalidate",
    etag,
    "x-plugin-code-hash": row.code_hash,
    "x-content-type-options": "nosniff",
  });
});

app.post("/:id/versions", requireAuth, async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  assertPluginEditor(actor, plugin.owner_account_id);

  const body = pluginVersionCreateSchema.parse(await c.req.json());
  if (body.manifest && body.manifest.name !== plugin.name) {
    throw ApiError.validation("manifest.name は変更できません");
  }

  const checks = await runStaticChecks(body.code);
  const warnings = manifestPermissionWarnings(body.manifest ?? parseManifest(plugin.manifest_json), body.code);

  const result = await addVersion(c.env.DB, plugin, {
    version: body.version,
    manifest: body.manifest,
    code: body.code,
    changelog: body.changelog,
    actorAccountId: actor.accountId!,
  });

  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.version.create",
    target: plugin.id,
    detail: { version: result.version },
  });

  return c.json(ok({ version: result.version, checks, warnings }), 201);
});

app.post("/:id/publish", requireAuth, async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  assertPluginEditor(actor, plugin.owner_account_id);

  const body = pluginPublishSchema.parse(await c.req.json());
  if (!plugin.latest_version) throw ApiError.validation("公開するバージョンがありません");
  const versionRow = await getVersionRow(c.env.DB, plugin.id, plugin.latest_version);
  if (!versionRow) throw ApiError.notFound("最新バージョンが見つかりません");

  const checks = await runStaticChecks(versionRow.code);
  const result = await publishPlugin(c.env.DB, plugin, {
    scopes: body.scopes,
    visibility: body.visibility,
    actorAccountId: actor.accountId!,
    staticResult: checks,
  });

  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.publish",
    target: plugin.id,
    detail: { scopes: body.scopes, status: result.status, needsReview: result.needsReview },
  });

  // site スコープの公開申請は審査キューに積まれる。AI 運営（WP5）が購読する
  // `plugin.review.requested` を署名付き webhook で配信する（waitUntil で応答を待たせない）。
  if (result.needsReview) {
    await emitPluginReviewRequested(
      c.env,
      {
        pluginId: plugin.id,
        pluginName: plugin.name,
        version: plugin.latest_version,
        reviewId: result.reviewId,
      },
      c.executionCtx.waitUntil.bind(c.executionCtx),
    );
  }

  return c.json(ok({ ...result, checks }));
});

app.post("/:id/install", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const body = pluginInstallSchema.parse(await c.req.json());

  await assertInstallPermission(c.env.DB, actor, body.scope, body.boardId);
  const scopeRef = scopeRefFor(body.scope, actor, body.boardId);

  if (body.scope === "site") {
    const approved = await c.env.DB.prepare(
      "SELECT id FROM plugin_reviews WHERE plugin_id = ? AND scope = 'site' AND status = 'approved' LIMIT 1",
    )
      .bind(plugin.id)
      .first<{ id: string }>();
    if (!approved) {
      throw ApiError.forbidden("サイト全体への導入には審査（承認キュー）の承認が必要です");
    }
  }

  const ownerPreview = body.scope === "personal" && isOwner(actor, plugin.owner_account_id);
  const version = await resolveInstallVersion(c.env.DB, plugin, body.version, {
    requireApproved: !ownerPreview,
    allowUnpublished: ownerPreview,
  });

  const result = await installPlugin(c.env.DB, plugin, {
    scope: body.scope,
    scopeRef,
    version,
    pinned: body.pinned,
    config: body.config,
    installedBy: actor.accountId ?? `device:${actor.deviceHash}`,
  });

  if (body.scope === "board" && body.boardId) {
    await c.env.DB.prepare(
      `INSERT INTO plugin_reviews
         (id, plugin_id, version, scope, scope_ref, status, reviewer_type, reviewer_id, note, static_result_json, risk_level, created_at, decided_at)
       VALUES (?, ?, ?, 'board', ?, 'approved', 'human', ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(plugin_id, version, scope, scope_ref) DO UPDATE SET
         status = 'approved', reviewer_type = 'human', reviewer_id = excluded.reviewer_id,
         note = excluded.note, decided_at = excluded.decided_at`,
    )
      .bind(
        `board-${plugin.id}-${version}-${body.boardId}`,
        plugin.id,
        version,
        `board:${body.boardId}`,
        actor.accountId,
        `board:${body.boardId}`,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
      )
      .run();
  }

  await writeAudit(c.env.DB, {
    actorType: body.scope === "board" ? "board_staff" : "account",
    actorId: actor.accountId,
    action: "plugin.install",
    target: plugin.id,
    detail: { scope: body.scope, scopeRef, version, created: result.created },
  });

  return c.json(ok(result), result.created ? 201 : 200);
});

app.post("/:id/update", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const body = pluginUpdateSchema.parse(await c.req.json());

  await assertInstallPermission(c.env.DB, actor, body.scope, body.boardId);
  const scopeRef = scopeRefFor(body.scope, actor, body.boardId);
  const install = await findInstall(c.env.DB, plugin.id, body.scope, scopeRef);
  if (!install) throw ApiError.notFound("このスコープには導入されていません");
  if (install.pinned === 1 && !body.version) {
    throw ApiError.conflict("バージョン固定されています。解除するか、バージョンを明示してください");
  }

  const version = await resolveInstallVersion(c.env.DB, plugin, body.version, {
    requireApproved: true,
  });
  if (version === install.version) {
    return c.json(ok({ install: { ...install }, updated: false }));
  }

  const updated = await updateInstallVersion(c.env.DB, install, version);
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.update",
    target: plugin.id,
    detail: { scope: body.scope, scopeRef, from: install.version, to: version },
  });
  return c.json(ok({ install: updated, updated: true }));
});

app.post("/:id/uninstall", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const body = pluginUninstallSchema.parse(await c.req.json());

  await assertInstallPermission(c.env.DB, actor, body.scope, body.boardId);
  const scopeRef = scopeRefFor(body.scope, actor, body.boardId);
  const install = await findInstall(c.env.DB, plugin.id, body.scope, scopeRef);
  if (!install) throw ApiError.notFound("このスコープには導入されていません");

  await uninstallPlugin(c.env.DB, install);
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.uninstall",
    target: plugin.id,
    detail: { scope: body.scope, scopeRef },
  });
  return c.json(ok({ uninstalled: true }));
});

app.post("/:id/report", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const body = pluginReportSchema.parse(await c.req.json());

  const report = await recordReport(c.env.DB, plugin, {
    reporterKind: actor.accountId ? "account" : "device",
    reporterId: actor.accountId ?? actor.deviceHash,
    reason: body.reason,
    detail: body.detail,
    version: body.version,
  });

  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.report",
    target: plugin.id,
    detail: { reason: body.reason },
  });
  return c.json(ok(report), 201);
});

app.get("/:id/reports", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  if (!isOwner(actor, plugin.owner_account_id) && !actor.isAdmin) {
    throw ApiError.forbidden();
  }
  const items = await listReports(c.env.DB, plugin.id);
  return c.json(ok({ items }));
});

/** キルスイッチ。boardId 指定時はその板の導入だけ停止（板管理人以上）。 */
app.post("/:id/disable", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const body = pluginDisableSchema.parse(await c.req.json());

  if (body.boardId) {
    await assertBoardStopPermission(c.env.DB, actor, body.boardId);
    const install = await findInstall(c.env.DB, plugin.id, "board", String(body.boardId));
    if (!install) throw ApiError.notFound("この板には導入されていません");
    await c.env.DB.prepare("UPDATE plugin_installs SET enabled = 0, updated_at = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), install.id)
      .run();
    await writeAudit(c.env.DB, {
      actorType: "board_staff",
      actorId: actor.accountId,
      action: "plugin.disable.board",
      target: plugin.id,
      detail: { boardId: body.boardId, reason: body.reason },
    });
    return c.json(ok({ stopped: "board-install", boardId: body.boardId }));
  }

  if (!isOwner(actor, plugin.owner_account_id) && !actor.isAdmin) {
    throw ApiError.forbidden("プラグインの停止は所有者またはサイト管理者のみ可能です");
  }
  await disablePlugin(c.env.DB, plugin.id, body.reason);
  await writeAudit(c.env.DB, {
    actorType: actor.isAdmin ? "special_admin" : "account",
    actorId: actor.accountId,
    action: "plugin.disable",
    target: plugin.id,
    detail: { reason: body.reason },
  });
  return c.json(ok({ stopped: "plugin", status: "disabled" }));
});

app.post("/:id/enable", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  if (!isOwner(actor, plugin.owner_account_id) && !actor.isAdmin) throw ApiError.forbidden();
  await enablePlugin(c.env.DB, plugin.id);
  await writeAudit(c.env.DB, {
    actorType: actor.isAdmin ? "special_admin" : "account",
    actorId: actor.accountId,
    action: "plugin.enable",
    target: plugin.id,
  });
  return c.json(ok({ status: "published" }));
});

app.delete("/:id", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  assertPluginEditor(actor, plugin.owner_account_id);
  await c.env.DB.prepare(
    "UPDATE plugins SET visibility = 'private', status = 'disabled', kill_seq = kill_seq + 1, updated_at = ? WHERE id = ?",
  )
    .bind(Math.floor(Date.now() / 1000), plugin.id)
    .run();
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.delete",
    target: plugin.id,
  });
  return c.json(ok({ deleted: true }));
});

app.post("/:id/fork", requireAuth, async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  if (plugin.visibility === "private" && !isOwner(actor, plugin.owner_account_id) && !actor.isAdmin) {
    throw ApiError.notFound("プラグインが見つかりません");
  }
  const body = pluginForkSchema.parse(await c.req.json().catch(() => ({})));

  let name = body.name ?? `${plugin.name}-fork`.slice(0, 41);
  for (let suffix = 2; suffix < 20; suffix++) {
    const taken = await c.env.DB.prepare("SELECT id FROM plugins WHERE name = ?").bind(name).first();
    if (!taken) break;
    name = `${(body.name ?? plugin.name).slice(0, 34)}-fork${suffix}`;
  }

  const forked = await forkPlugin(c.env.DB, plugin, { ownerAccountId: actor.accountId!, name });
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.fork",
    target: plugin.id,
    detail: { forkId: forked.id, name },
  });
  return c.json(ok({ id: forked.id, name, version: forked.version }), 201);
});

// ─── プラグイン共有 KV（storage:shared） ─────────────────────────

/** そのスコープでプラグインが有効か（所有者の個人プレビューは導入なしでも可）。 */
async function isPluginActiveFor(
  db: D1Database,
  pluginId: string,
  actor: PluginActor,
  scope: PluginScope,
  boardId: number | undefined,
  ownerAccountId: string | null,
): Promise<boolean> {
  const scopeRef = scopeRefFor(scope, actor, boardId);
  const install = await findInstall(db, pluginId, scope, scopeRef);
  if (install) return true;
  return scope === "personal" && isOwner(actor, ownerAccountId);
}

app.get("/:id/state", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const query = pluginStateQuerySchema.parse(queryObject(c.req.url));

  if (!(await isPluginActiveFor(c.env.DB, plugin.id, actor, query.scope, query.boardId, plugin.owner_account_id))) {
    throw ApiError.forbidden("このスコープにプラグインが導入されていません");
  }
  const scopeRef = scopeRefFor(query.scope, actor, query.boardId);

  if (query.key) {
    const value = await stateGet(c.env.DB, {
      pluginId: plugin.id,
      scope: query.scope,
      scopeRef,
      key: query.key,
    });
    return c.json(ok({ value }));
  }
  const items = await stateList(c.env.DB, { pluginId: plugin.id, scope: query.scope, scopeRef });
  return c.json(ok({ items }));
});

app.post("/:id/state", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const body = pluginStateSetSchema.parse(await c.req.json());

  const ownerPreview = body.scope === "personal" && isOwner(actor, plugin.owner_account_id);
  if (!(await isPluginActiveFor(c.env.DB, plugin.id, actor, body.scope, body.boardId, plugin.owner_account_id))) {
    throw ApiError.forbidden("このスコープにプラグインが導入されていません");
  }

  // 共有状態の書き込み権限: 個人=自分 / 板=板スタッフ / サイト=管理者
  if (!ownerPreview) {
    if (body.scope === "board") {
      if (!actor.isAdmin) {
        if (!actor.accountId) throw ApiError.unauthorized();
        if (!(await isBoardStaff(c.env.DB, actor.accountId, body.boardId ?? 0))) {
          throw ApiError.forbidden("板の共有データを書き込めるのは板スタッフのみです");
        }
      }
    } else if (body.scope === "site" && !actor.isAdmin) {
      throw ApiError.forbidden("サイト共有データを書き込めるのは管理者のみです");
    }
  }

  const scopeRef = scopeRefFor(body.scope, actor, body.boardId);
  await stateSet(c.env.DB, {
    pluginId: plugin.id,
    scope: body.scope,
    scopeRef,
    key: body.key,
    value: body.value,
  });
  return c.json(ok({ saved: true }));
});

app.delete("/:id/state", async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const query = pluginStateQuerySchema.parse(queryObject(c.req.url));
  if (!query.key) throw ApiError.validation("key が必要です");

  if (!(await isPluginActiveFor(c.env.DB, plugin.id, actor, query.scope, query.boardId, plugin.owner_account_id))) {
    throw ApiError.forbidden("このスコープにプラグインが導入されていません");
  }
  const ownerPreview = query.scope === "personal" && isOwner(actor, plugin.owner_account_id);
  if (!ownerPreview) {
    if (query.scope === "board" && !actor.isAdmin) {
      if (!actor.accountId || !(await isBoardStaff(c.env.DB, actor.accountId, query.boardId ?? 0))) {
        throw ApiError.forbidden("板の共有データを削除できるのは板スタッフのみです");
      }
    } else if (query.scope === "site" && !actor.isAdmin) {
      throw ApiError.forbidden();
    }
  }

  const scopeRef = scopeRefFor(query.scope, actor, query.boardId);
  await stateDelete(c.env.DB, { pluginId: plugin.id, scope: query.scope, scopeRef, key: query.key });
  return c.json(ok({ deleted: true }));
});

// ─── 審査判定 ─────────────────────────────────────────────────────

app.post("/:id/review", requireRole("owner", "special_admin"), async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const body = pluginReviewDecisionSchema.parse(await c.req.json());

  const review = await c.env.DB.prepare(
    `SELECT * FROM plugin_reviews WHERE plugin_id = ? AND scope = ? AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(plugin.id, body.scope)
    .first<ReviewRow>();
  if (!review) throw ApiError.notFound("未判定の審査がありません");

  const decided = await decideReview(c.env.DB, review, {
    decision: body.decision,
    note: body.note,
    reviewerId: actor.accountId!,
    reviewerType: "human",
  });

  await writeAudit(c.env.DB, {
    actorType: actor.role === "owner" ? "owner" : "special_admin",
    actorId: actor.accountId,
    action: `plugin.review.${body.decision}`,
    target: plugin.id,
    detail: { reviewId: review.id, scope: body.scope, note: body.note },
  });

  return c.json(ok({ decision: body.decision, pluginStatus: decided.pluginStatus }));
});

/** 審査 1 件の詳細（キュー UI 用）。 */
app.get("/:id/review", requireRole("owner", "special_admin"), async (c) => {
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  const scope = c.req.query("scope") ?? "site";
  if (scope !== "board" && scope !== "site") throw ApiError.validation("scope が不正です");
  const review = await c.env.DB.prepare(
    "SELECT * FROM plugin_reviews WHERE plugin_id = ? AND scope = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(plugin.id, scope)
    .first<ReviewRow>();
  if (!review) throw ApiError.notFound("審査がありません");
  const fetched = await getReviewRow(c.env.DB, review.id);
  return c.json(ok(fetched ?? review));
});

// ─── GitHub / Gist 発行・同期 ─────────────────────────────────────

app.post("/:id/export/gist", requireAuth, async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  assertPluginEditor(actor, plugin.owner_account_id);
  const body = pluginGistExportSchema.parse(await c.req.json().catch(() => ({})));

  const version = plugin.latest_version;
  if (!version) throw ApiError.validation("発行するバージョンがありません");
  const row = await getVersionRow(c.env.DB, plugin.id, version);
  if (!row) throw ApiError.notFound("バージョンが見つかりません");

  const exported = await exportPluginToGist(c.env, actor.accountId!, plugin, row.code, parseManifest(row.manifest_json), {
    public: body.public,
    description: body.description,
  });
  await setPluginSource(c.env.DB, plugin.id, "gist", exported.sourceRef);
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.export.gist",
    target: plugin.id,
    detail: { url: exported.htmlUrl },
  });
  return c.json(ok(exported), 201);
});

app.post("/:id/export/repo", requireAuth, async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  assertPluginEditor(actor, plugin.owner_account_id);
  const body = pluginExportRepoSchema.parse(await c.req.json());

  const version = plugin.latest_version;
  if (!version) throw ApiError.validation("発行するバージョンがありません");
  const row = await getVersionRow(c.env.DB, plugin.id, version);
  if (!row) throw ApiError.notFound("バージョンが見つかりません");

  const written = await exportPluginToRepo(
    c.env,
    actor.accountId!,
    plugin,
    row.code,
    parseManifest(row.manifest_json),
    body,
  );
  const sourceRef = JSON.stringify({
    type: "repo",
    owner: body.owner,
    repo: body.repo,
    path: body.path,
    ref: "HEAD",
    url: `https://github.com/${body.owner}/${body.repo}`,
  });
  await setPluginSource(c.env.DB, plugin.id, "github", sourceRef);
  await writeAudit(c.env.DB, {
    actorType: "account",
    actorId: actor.accountId,
    action: "plugin.export.repo",
    target: plugin.id,
    detail: { owner: body.owner, repo: body.repo, files: written },
  });
  return c.json(ok({ written, sourceRef }), 201);
});

/** GitHub の取得元から最新を取り込み、新しければ下書きバージョンを追加する。 */
app.post("/:id/sync", requireAuth, async (c) => {
  const actor = pluginActorFrom(getReqCtx(c));
  const plugin = await loadPlugin(c.env.DB, c.req.param("id"));
  assertPluginEditor(actor, plugin.owner_account_id);
  if (plugin.source === "local") throw ApiError.validation("GitHub の取得元が設定されていません");

  const source = await fetchSourceByRef(plugin.source, plugin.source_ref);
  const latest = plugin.latest_version;
  if (latest && compareVersionStrings(source.manifest.version, latest) <= 0) {
    return c.json(ok({ updated: false, version: latest }));
  }

  const result = await addVersion(c.env.DB, plugin, {
    version: source.manifest.version,
    manifest: source.manifest,
    code: source.code,
    changelog: "GitHub から同期",
    actorAccountId: actor.accountId!,
  });
  return c.json(ok({ updated: true, version: result.version }));
});

export default app;