// プラグインの契約スキーマ（DESIGN §7 / WORKPACKAGES §3.4）。
// manifest・権限・スコープ・ブリッジ RPC envelope・REST 入力をここで一元定義する。
// API（Workers）と Web（plugin-host / エディタ）は必ずこのファイルのスキーマを使う。

import { z } from "zod";
import { PLUGIN_CODE_MAX_BYTES, PLUGIN_STATE_MAX_BYTES } from "../constants";
import { analyzeRegexPattern } from "../lib/regex-safety";

// ─── 列挙 ───────────────────────────────────────────────────────────

/** 適用範囲。personal=個人用（審査不要）/ board=板用（板管理人が承認）/ site=サイト全体（承認キュー必須）。 */
export const PLUGIN_SCOPES = ["personal", "board", "site"] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

/**
 * manifest で宣言できる権限（DESIGN §7.2）。未宣言の権限を使う RPC はホストが拒否する。
 * `ai:complete` は要件「AI連携」用（審査レベル: 中）。
 */
export const PLUGIN_PERMISSIONS = [
  "ui:slot",
  "data:read:thread",
  "data:read:board",
  "data:write:post",
  "storage:shared",
  "net:fetch",
  "upload:start",
  "github:gist",
  "github:repo",
  "events:subscribe",
  "notify",
  "ai:complete",
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** 権限ごとの審査レベル（板/サイト公開時）。低=自動可、中=条件付き、高=人間承認必須。 */
export const PLUGIN_PERMISSION_RISK: Readonly<Record<PluginPermission, "low" | "medium" | "high">> = {
  "ui:slot": "low",
  "data:read:thread": "low",
  "data:read:board": "low",
  "data:write:post": "medium",
  "storage:shared": "low",
  "net:fetch": "medium",
  "upload:start": "medium",
  "github:gist": "high",
  "github:repo": "high",
  "events:subscribe": "low",
  notify: "low",
  "ai:complete": "medium",
};

/** レジストリ上の状態。draft=非公開作業中 / pending=公開審査待ち / published=公開 / rejected=却下 / disabled=停止（キル）。 */
export const PLUGIN_STATUSES = ["draft", "pending", "published", "rejected", "disabled"] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** 検索・共有の可視性。private=自分のみ / unlisted=URL 共有のみ / public=レジストリ掲載。 */
export const PLUGIN_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type PluginVisibility = (typeof PLUGIN_VISIBILITIES)[number];

/** UI スロット名。WP2 のレイアウト/スレ画面が `<PluginSlot name=...>` で差し込む。 */
export const PLUGIN_SLOTS = [
  // WP3 の汎用名（マニュアル・SDK で使用）
  "thread-head",
  "thread-post-inline",
  "thread-post-footer",
  "post-form-after",
  "board-head",
  "sidebar",
  "plugin-page",
  // WP2 の `components/plugin-slot.tsx` が提供するスロット名（互換のため同一集合に含める）
  "site-header",
  "site-top",
  "board-top",
  "board-sidebar",
  "thread-top",
  "thread-nav",
  "post-form-extra",
  "thread-bottom",
  "board-manage",
  "post-actions",
] as const;
export type PluginSlotName = (typeof PLUGIN_SLOTS)[number];

/** ホストが呼び出すプラグイン側フック。 */
export const PLUGIN_HOOKS = ["beforePost", "onPostRendered"] as const;
export type PluginHookName = (typeof PLUGIN_HOOKS)[number];

/** 通報理由。 */
export const PLUGIN_REPORT_REASONS = ["malicious", "spam", "broken", "inappropriate", "other"] as const;
export type PluginReportReason = (typeof PLUGIN_REPORT_REASONS)[number];

/** 審査（レビュー）状態。 */
export const PLUGIN_REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type PluginReviewStatus = (typeof PLUGIN_REVIEW_STATUSES)[number];

/** レビューの対象スコープ（personal は審査不要のため対象外）。 */
export const PLUGIN_REVIEW_SCOPES = ["board", "site"] as const;
export type PluginReviewScope = (typeof PLUGIN_REVIEW_SCOPES)[number];

/** manifest ファイル名・エントリ既定名（Gist/repo 取込時に探索する）。 */
export const PLUGIN_MANIFEST_FILENAME = "manifest.json";
export const PLUGIN_ENTRY_FILENAME = "plugin.js";

/** semver（major.minor.patch + prerelease）。 */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const semverSchema = z.string().regex(SEMVER_PATTERN, "semver 形式（例 1.0.0）で指定してください");

/** プラグイン名（= レジストリ slug）。 */
export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{2,40}$/;

// ─── manifest ──────────────────────────────────────────────────────

/** 宣言的レンダー規則（投稿表示変換）。ホストが regex→template を実行する（プラグイン JS は不要）。 */
export const pluginPostRenderRuleSchema = z.object({
  /** 対象（正規表現ソース）。`g` を付けた状態で検索する。 */
  pattern: z.string().min(1).max(500),
  /** 正規表現フラグ（g/i/m/s/u）。 */
  flags: z
    .string()
    .regex(/^[gimsu]*$/, "使用できるフラグは gims u のみです")
    .max(6)
    .default("g"),
  /**
   * 置換テンプレート。`$1`..`$9` でキャプチャを参照できる。
   * キャプチャ値はホストが HTML エスケープしてから埋め込む（生 HTML は不可）。
   */
  template: z.string().min(1).max(2000),
  /** 変換後の表示種別（ホストの装飾用）。 */
  kind: z.enum(["spoiler", "dice", "link", "image", "text"]).default("text"),
}).superRefine((rule, ctx) => {
  // ReDoS 対策: 入れ子の量指定子・重なる選択肢の繰り返し・後方参照・過大な長さ/回数を拒否する。
  // 判定は shared の analyzeRegexPattern（API と web で同一実装）。
  const safety = analyzeRegexPattern(rule.pattern, rule.flags);
  if (!safety.safe) {
    ctx.addIssue({
      code: "custom",
      path: ["pattern"],
      message: `危険な正規表現は使用できません: ${safety.reason}`,
    });
  }
});

export type PluginPostRenderRule = z.infer<typeof pluginPostRenderRuleSchema>;

const originSchema = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        (url.pathname === "/" || url.pathname === "") &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "https のオリジン（https://example.com）のみ指定できます");

/** プラグイン manifest。DESIGN §7.2 を正本とする。 */
export const pluginManifestSchema = z
  .object({
    name: z.string().regex(PLUGIN_NAME_PATTERN, "name は英小文字/数字/ハイフン（3〜41文字、英小文字始まり）"),
    version: semverSchema,
    summary: z.string().min(1).max(200),
    description: z.string().max(20_000).optional(),
    scope: z.array(z.enum(PLUGIN_SCOPES)).min(1).max(3),
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).default([]),
    /** net:fetch 使用時は必須。宣言したオリジン以外へはプロキシが転送しない。 */
    connectAllowlist: z.array(originSchema).max(20).default([]),
    entry: z
      .string()
      .regex(/^[A-Za-z0-9._/-]{1,100}$/)
      .default(PLUGIN_ENTRY_FILENAME),
    slots: z.array(z.enum(PLUGIN_SLOTS)).max(8).default([]),
    hooks: z.array(z.enum(PLUGIN_HOOKS)).max(4).default([]),
    /** 宣言的レンダー規則（投稿表示変換）。 */
    render: z
      .object({ post: z.array(pluginPostRenderRuleSchema).max(20).optional() })
      .optional(),
    author: z.string().max(60).optional(),
    license: z.string().max(30).optional(),
    homepage: z.string().max(300).optional(),
  })
  .superRefine((manifest, ctx) => {
    const permissions = new Set(manifest.permissions);

    if (permissions.has("net:fetch") && manifest.connectAllowlist.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["connectAllowlist"],
        message: "net:fetch を使う場合は connectAllowlist に許可オリジンを 1 件以上指定してください",
      });
    }
    if (!permissions.has("net:fetch") && manifest.connectAllowlist.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["connectAllowlist"],
        message: "connectAllowlist は net:fetch 権限がある場合のみ指定できます",
      });
    }
    if (manifest.slots.length > 0 && !permissions.has("ui:slot")) {
      ctx.addIssue({
        code: "custom",
        path: ["slots"],
        message: "スロットを使う場合は ui:slot 権限を宣言してください",
      });
    }
    if (permissions.has("ui:slot") && manifest.slots.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "ui:slot 権限を宣言する場合は slots を 1 つ以上指定してください",
      });
    }
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
/** manifest の入力型（default が埋まる前の形）。 */
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

/** manifest の既定値を埋めた「正規化済み」manifest を返す。 */
export function normalizeManifest(input: unknown): PluginManifest {
  return pluginManifestSchema.parse(input);
}

/** 権限リスクの最大値。サイト公開時の審査レベル判定に使う。 */
export function manifestRiskLevel(manifest: PluginManifest): "low" | "medium" | "high" {
  let level: "low" | "medium" | "high" = "low";
  for (const permission of manifest.permissions) {
    const risk = PLUGIN_PERMISSION_RISK[permission];
    if (risk === "high") return "high";
    if (risk === "medium") level = "medium";
  }
  return level;
}

// ─── ブリッジ RPC envelope（DESIGN §7.1） ───────────────────────────

export const PLUGIN_RPC_VERSION = 1 as const;

const rpcIdSchema = z.union([z.string().max(64), z.number().int()]);

/** プラグイン → ホストの要求。 */
export const pluginRpcRequestSchema = z.object({
  v: z.literal(PLUGIN_RPC_VERSION),
  id: rpcIdSchema.nullable(),
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
});
export type PluginRpcRequest = z.infer<typeof pluginRpcRequestSchema>;

export const pluginRpcErrorSchema = z.object({
  v: z.literal(PLUGIN_RPC_VERSION),
  id: rpcIdSchema.nullable(),
  ok: z.literal(false),
  error: z.object({ code: z.string().max(64), message: z.string().max(1000) }),
});
export type PluginRpcError = z.infer<typeof pluginRpcErrorSchema>;

export const pluginRpcSuccessSchema = z.object({
  v: z.literal(PLUGIN_RPC_VERSION),
  id: rpcIdSchema.nullable(),
  ok: z.literal(true),
  result: z.unknown().optional(),
});
export type PluginRpcSuccess = z.infer<typeof pluginRpcSuccessSchema>;

export const pluginRpcResponseSchema = z.union([pluginRpcSuccessSchema, pluginRpcErrorSchema]);
export type PluginRpcResponse = z.infer<typeof pluginRpcResponseSchema>;

/** ホスト → プラグインの通知/呼び出し（id なし = 通知、id あり = 呼び出し）。 */
export const pluginHostMessageSchema = z.object({
  v: z.literal(PLUGIN_RPC_VERSION),
  id: rpcIdSchema.nullable().optional(),
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
});
export type PluginHostMessage = z.infer<typeof pluginHostMessageSchema>;

/** ホストがプラグインに送るメソッド。 */
export const PLUGIN_HOST_METHODS = ["init", "invoke", "event", "beforePost", "kill", "theme"] as const;
export type PluginHostMethod = (typeof PLUGIN_HOST_METHODS)[number];

/**
 * プラグイン → ホストのメソッドと必要権限の対応（null = 権限不要）。
 * `undefined` を返した場合は未知メソッド = ホストが拒否する。
 */
export const PLUGIN_RPC_PERMISSIONS: Readonly<Record<string, PluginPermission | null>> = {
  handshake: null,
  "ui.resize": null,
  "ui.setTitle": null,
  log: null,
  "storage.get": "storage:shared",
  "storage.set": "storage:shared",
  "storage.delete": "storage:shared",
  "storage.list": "storage:shared",
  "data.thread.get": "data:read:thread",
  "data.posts.list": "data:read:thread",
  "data.board.get": "data:read:board",
  "data.post.create": "data:write:post",
  "events.subscribe": "events:subscribe",
  "upload.start": "upload:start",
  "github.gist": "github:gist",
  "github.repo": "github:repo",
  notify: "notify",
  "ai.complete": "ai:complete",
  "net.fetch": "net:fetch",
};

/** メソッドに必要な権限を返す（未知メソッドは undefined）。 */
export function rpcPermissionFor(method: string): PluginPermission | null | undefined {
  return Object.prototype.hasOwnProperty.call(PLUGIN_RPC_PERMISSIONS, method)
    ? PLUGIN_RPC_PERMISSIONS[method]
    : undefined;
}

/** 権限が必要なメソッドか（署名なしメソッドの判定補助）。 */
export function rpcRequiresPermission(method: string): boolean {
  return rpcPermissionFor(method) !== null && rpcPermissionFor(method) !== undefined;
}

// ─── REST 入力スキーマ ─────────────────────────────────────────────

const codeSchema = z
  .string()
  .min(1, "コードが空です")
  .refine((value) => new TextEncoder().encode(value).byteLength <= PLUGIN_CODE_MAX_BYTES, {
    message: `コードは ${Math.floor(PLUGIN_CODE_MAX_BYTES / 1024)}KB 以下にしてください`,
  });

/** POST /v1/plugins — 新規作成（最初のバージョンを含む）。 */
export const pluginCreateSchema = z.object({
  manifest: pluginManifestSchema,
  code: codeSchema,
  changelog: z.string().max(2000).optional(),
  visibility: z.enum(PLUGIN_VISIBILITIES).default("private"),
});
export type PluginCreateInput = z.infer<typeof pluginCreateSchema>;

/** POST /v1/plugins/:id/versions — 版の追加。 */
export const pluginVersionCreateSchema = z.object({
  version: semverSchema.optional(),
  manifest: pluginManifestSchema.optional(),
  code: codeSchema,
  changelog: z.string().max(2000).optional(),
});
export type PluginVersionCreateInput = z.infer<typeof pluginVersionCreateSchema>;

/** POST /v1/plugins/:id/publish — 公開申請。site を含む場合は承認キューに入る。 */
export const pluginPublishSchema = z.object({
  scopes: z.array(z.enum(PLUGIN_SCOPES)).min(1),
  visibility: z.enum(PLUGIN_VISIBILITIES).default("public"),
});
export type PluginPublishInput = z.infer<typeof pluginPublishSchema>;

const boardIdSchema = z.number().int().positive().max(2_147_483_647);

/** POST /v1/plugins/:id/install — インストール（再実行で最新版へ更新）。 */
export const pluginInstallSchema = z.object({
  scope: z.enum(PLUGIN_SCOPES),
  /** scope=board のとき必須 */
  boardId: boardIdSchema.optional(),
  /** 省略時は公開済み最新版 */
  version: semverSchema.optional(),
  /** true なら自動追随しない */
  pinned: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type PluginInstallInput = z.infer<typeof pluginInstallSchema>;

/** POST /v1/plugins/:id/update — 導入済みの版を更新。 */
export const pluginUpdateSchema = z.object({
  scope: z.enum(PLUGIN_SCOPES),
  boardId: boardIdSchema.optional(),
  version: semverSchema.optional(),
});
export type PluginUpdateInput = z.infer<typeof pluginUpdateSchema>;

/** POST /v1/plugins/:id/uninstall */
export const pluginUninstallSchema = z.object({
  scope: z.enum(PLUGIN_SCOPES),
  boardId: boardIdSchema.optional(),
});
export type PluginUninstallInput = z.infer<typeof pluginUninstallSchema>;

/** POST /v1/plugins/:id/report */
export const pluginReportSchema = z.object({
  reason: z.enum(PLUGIN_REPORT_REASONS),
  detail: z.string().max(2000).optional(),
  version: semverSchema.optional(),
});
export type PluginReportInput = z.infer<typeof pluginReportSchema>;

/** POST /v1/plugins/:id/disable — キルスイッチ（停止）。boardId 指定時はその板の導入だけ無効化。 */
export const pluginDisableSchema = z.object({
  reason: z.string().min(1).max(500),
  boardId: boardIdSchema.optional(),
});
export type PluginDisableInput = z.infer<typeof pluginDisableSchema>;

/** POST /v1/plugins/:id/review — 審査判定。 */
export const pluginReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
  scope: z.enum(PLUGIN_REVIEW_SCOPES).default("site"),
});
export type PluginReviewDecisionInput = z.infer<typeof pluginReviewDecisionSchema>;

/** POST /v1/plugins/preview-check — エディタからの静的検査。 */
export const pluginPreviewCheckSchema = z.object({
  code: z.string().min(1).max(PLUGIN_CODE_MAX_BYTES),
  manifest: pluginManifestSchema.optional(),
});
export type PluginPreviewCheckInput = z.infer<typeof pluginPreviewCheckSchema>;

/** POST /v1/plugins/import/gist — Gist からの取込。 */
export const pluginGistImportSchema = z.object({
  /** Gist URL または Gist ID */
  gist: z.string().min(5).max(300),
});
export type PluginGistImportInput = z.infer<typeof pluginGistImportSchema>;

/** POST /v1/plugins/:id/export/gist */
export const pluginGistExportSchema = z.object({
  public: z.boolean().default(true),
  description: z.string().max(300).optional(),
});
export type PluginGistExportInput = z.infer<typeof pluginGistExportSchema>;

/** POST /v1/plugins/import/repo — リポジトリからの取込。 */
export const pluginRepoImportSchema = z.object({
  repo: z.string().min(3).max(300),
});
export type PluginRepoImportInput = z.infer<typeof pluginRepoImportSchema>;

/** POST /v1/plugins/:id/export/repo */
export const pluginExportRepoSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  path: z.string().max(200).default(""),
  message: z.string().max(200).optional(),
});
export type PluginExportRepoInput = z.infer<typeof pluginExportRepoSchema>;

/** POST /v1/plugins/:id/fork — 公開プラグインを自分の下書きへ複製（共有）。 */
export const pluginForkSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_PATTERN).optional(),
});
export type PluginForkInput = z.infer<typeof pluginForkSchema>;

/** GET /v1/plugins のクエリ。 */
export const pluginListQuerySchema = z.object({
  q: z.string().max(100).optional(),
  scope: z.enum(PLUGIN_SCOPES).optional(),
  sort: z.enum(["updated", "popular", "new"]).default("updated"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(300).optional(),
  mine: z.coerce.boolean().optional(),
});
export type PluginListQuery = z.infer<typeof pluginListQuerySchema>;

/** GET /v1/plugins/active（ホストが実行対象を取得）のクエリ。 */
export const pluginActiveQuerySchema = z.object({
  boardId: z.coerce.number().int().positive().optional(),
  /** 板スラッグ（WP2 のスロット文脈は boardId を持たないため slug から解決する） */
  boardSlug: z.string().min(1).max(100).optional(),
  threadId: z.coerce.number().int().positive().optional(),
});
export type PluginActiveQuery = z.infer<typeof pluginActiveQuerySchema>;

/** GET /v1/plugins/:id/state — storage:shared の読み出し。 */
export const pluginStateQuerySchema = z.object({
  scope: z.enum(PLUGIN_SCOPES),
  boardId: z.coerce.number().int().positive().optional(),
  key: z.string().min(1).max(200).optional(),
});
export type PluginStateQuery = z.infer<typeof pluginStateQuerySchema>;

/** POST /v1/plugins/:id/state — storage:shared の書き込み。 */
export const pluginStateSetSchema = z.object({
  scope: z.enum(PLUGIN_SCOPES),
  boardId: z.coerce.number().int().positive().optional(),
  key: z.string().min(1).max(200),
  value: z.string().max(PLUGIN_STATE_MAX_BYTES),
});
export type PluginStateSetInput = z.infer<typeof pluginStateSetSchema>;

/** POST /v1/plugin-net/fetch — sandbox の net:fetch プロキシ入力。 */
export const pluginNetFetchSchema = z.object({
  pluginId: z.string().min(1).max(64),
  version: semverSchema.optional(),
  scope: z.enum(PLUGIN_SCOPES),
  boardId: boardIdSchema.optional(),
  url: z.string().min(1).max(2000),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(64 * 1024).optional(),
  timeoutMs: z.number().int().min(500).max(10_000).default(5000),
});
export type PluginNetFetchInput = z.infer<typeof pluginNetFetchSchema>;

/**
 * POST /v1/ai/complete — プラグインの AI 連携（ai:complete 権限）。
 * ホストは権限同意を得たうえで `consent: true` を付ける。接続先はサイト設定
 * （plugin.ai.baseUrl / plugin.ai.model）と Worker secret `PLUGIN_AI_API_KEY`。
 */
export const pluginAiCompleteSchema = z.strictObject({
  pluginId: z.string().min(1).max(64),
  version: semverSchema.optional(),
  scope: z.enum(PLUGIN_SCOPES),
  boardId: boardIdSchema.optional(),
  threadId: z.number().int().positive().optional(),
  prompt: z.string().min(1).max(4000),
  system: z.string().max(2000).optional(),
  maxTokens: z.number().int().min(1).max(512).optional(),
  consent: z.literal(true),
});
export type PluginAiCompleteInput = z.infer<typeof pluginAiCompleteSchema>;

export interface PluginAiCompleteResult {
  text: string;
  model: string;
}

// ─── プラグインとホストがやり取りするデータ型 ─────────────────────

export interface PluginPost {
  id: number;
  num: number;
  name: string;
  body: string;
  createdAt: number;
  accountId?: string | null;
  isOp?: boolean;
}

export interface PluginThread {
  id: number;
  boardId: number;
  title: string;
  postCount: number;
}

export interface PluginBoard {
  id: number;
  slug: string;
  name: string;
}

/** 投稿前フックが受け取る下書き。 */
export interface PluginDraft {
  boardId?: number;
  threadId?: number | null;
  name?: string;
  mail?: string;
  body: string;
}

/** 投稿前フックが返せる変更（省略したフィールドは元の値）。 */
export type PluginDraftPatch = Partial<Pick<PluginDraft, "name" | "mail" | "body">> & {
  /** true で投稿自体を中止する */
  cancel?: boolean;
};

export type PluginEventTopic = "post" | "thread" | "board";

export interface PluginPostEvent {
  type: "post";
  threadId: number;
  post: PluginPost;
}

export interface PluginThreadEvent {
  type: "thread";
  boardId: number;
  thread: PluginThread;
}

export type PluginEvent = PluginPostEvent | PluginThreadEvent;

export interface PluginNotifyOptions {
  level?: "info" | "success" | "warn" | "error";
}

export interface PluginAiOptions {
  system?: string;
  maxTokens?: number;
}

export interface PluginUploadOptions {
  accept?: string[];
  maxBytes?: number;
}

export interface PluginGistInput {
  filename: string;
  content: string;
  description?: string;
  public?: boolean;
}

export interface PluginRepoFileInput {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message?: string;
}

// ─── レスポンス型（Web/API 共用） ─────────────────────────────────

export interface PluginOwnerInfo {
  id: string;
  name: string;
}

export interface PluginVersionInfo {
  version: string;
  changelog: string | null;
  codeHash: string;
  status: "draft" | "pending" | "approved" | "rejected";
  createdAt: number;
}

export interface PluginSummary {
  id: string;
  name: string;
  summary: string;
  latestVersion: string | null;
  status: PluginStatus;
  visibility: PluginVisibility;
  scopes: PluginScope[];
  permissions: PluginPermission[];
  slots: PluginSlotName[];
  hasRenderRules: boolean;
  installCount: number;
  reportCount: number;
  flagged: boolean;
  source: "local" | "gist" | "github";
  sourceRef: string | null;
  owner: PluginOwnerInfo | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

export interface PluginDetail extends PluginSummary {
  description: string | null;
  manifest: PluginManifest;
  versions: PluginVersionInfo[];
  /** 呼び出しユーザーの権限（UI 表示制御用。サーバ強制は別途） */
  viewer: {
    isOwner: boolean;
    isAdmin: boolean;
    canEdit: boolean;
    canReview: boolean;
  };
  installs: PluginInstallInfo[];
}

export interface PluginInstallInfo {
  id: string;
  pluginId: string;
  scope: PluginScope;
  scopeRef: string;
  version: string;
  pinned: boolean;
  enabled: boolean;
  installedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** ホストが実行するプラグイン 1 件分の情報（/v1/plugins/active の要素）。 */
export interface PluginActiveInstall {
  installId: string;
  pluginId: string;
  name: string;
  version: string;
  scope: PluginScope;
  scopeRef: string;
  /** 停止（キル）済みなら true。ホストは kill を送って破棄する。 */
  stopped: boolean;
  status: PluginStatus;
  /** コード配信 URL（host が同一オリジンで fetch する） */
  codeUrl: string;
  manifest: PluginManifest;
  config: Record<string, unknown> | null;
  pinned: boolean;
}

export interface PluginReviewInfo {
  id: string;
  pluginId: string;
  pluginName: string;
  version: string;
  scope: PluginReviewScope;
  status: PluginReviewStatus;
  reviewerType: "human" | "ai" | "system";
  reviewerId: string | null;
  note: string | null;
  staticResult: { allowed: boolean; reasons: string[]; riskScore?: number } | null;
  riskLevel: "low" | "medium" | "high" | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface PluginReportInfo {
  id: string;
  pluginId: string;
  version: string | null;
  reason: PluginReportReason;
  detail: string | null;
  status: "open" | "resolved" | "dismissed";
  createdAt: number;
}

/** 静的検査結果（`runStaticChecks` の戻り値と一致させる）。 */
export interface PluginStaticCheckResult {
  allowed: boolean;
  reasons: string[];
  riskScore?: number;
}

/** net:fetch プロキシの応答。 */
export interface PluginNetFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "text" | "base64";
  truncated: boolean;
  url: string;
  durationMs: number;
}

/** レジストリ検索結果。 */
export interface PluginListPage {
  items: PluginSummary[];
  nextCursor: string | null;
}
