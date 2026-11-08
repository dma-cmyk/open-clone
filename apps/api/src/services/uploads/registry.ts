// アップローダ・レジストリ（交換可能なアダプタ構造の中心）。
//
// 拡張点:
//  1. コード拡張: `registerUploaderAdapter(adapter)`（組み込みもこれで登録。プラグイン/将来の実装が追加可能）
//  2. 設定拡張: `uploader_adapters` テーブルの `kind='declarative'` 行（HTTP エンドポイントを宣言するだけで
//     新しい保存先を追加できる。プラグインは `saveAdapterRow()` で登録する）
// どちらも `UploaderAdapter` IF（shared）に準拠し、板設定/サイト設定で既定を切り替えられる。

import { z } from "zod";
import {
  ApiError,
  ErrorCode,
  UPLOAD_PROXY_MAX_BYTES,
  type AttachmentMeta,
  type DirectResult,
  type UploadRequest,
} from "shared";
import {
  uploaderAdapterIdSchema,
  type UploaderAdapterInfo,
} from "shared/schemas/upload";
import type { Env } from "../../lib/env";
import { readEnvSecret } from "../env-secrets";
import { listAdapterRows, readAdapterRow, readUploaderSettings, type AdapterRow } from "./config";
import type { ServerAdapterContext, ServerUploaderAdapter, UploadRuntime } from "./types";
import { assertAllowedHost, extractFirstUrl, readJsonPath } from "./util";
import { catboxAdapter } from "./adapters/catbox";
import { cloudinaryAdapter } from "./adapters/cloudinary";
import { gistAdapter } from "./adapters/gist";
import { githubRepoAdapter } from "./adapters/github";
import { litterboxAdapter } from "./adapters/litterbox";
import { mockAdapter } from "./adapters/mock";

const registry = new Map<string, ServerUploaderAdapter>();

/** アダプタを登録する（プラグイン/追加実装の拡張点）。 */
export function registerUploaderAdapter(adapter: ServerUploaderAdapter, options: { replace?: boolean } = {}): void {
  const parsed = uploaderAdapterIdSchema.safeParse(adapter.id);
  if (!parsed.success) {
    throw new Error(`不正なアダプタ ID: ${adapter.id}`);
  }
  if (registry.has(adapter.id) && !options.replace) {
    throw new Error(`アダプタ '${adapter.id}' は既に登録されています`);
  }
  registry.set(adapter.id, adapter);
}

export function unregisterUploaderAdapter(id: string): boolean {
  return registry.delete(id);
}

export function getRegisteredAdapter(id: string): ServerUploaderAdapter | null {
  return registry.get(id) ?? null;
}

export function listRegisteredAdapters(): ServerUploaderAdapter[] {
  return [...registry.values()];
}

// 組み込みアダプタ（DESIGN §9.1: catbox 既定 + cloudinary 代替 + gist/github テキスト + mock）
for (const adapter of [catboxAdapter, cloudinaryAdapter, gistAdapter, githubRepoAdapter, litterboxAdapter, mockAdapter]) {
  registerUploaderAdapter(adapter, { replace: true });
}

/** アダプタ実行コンテキストを作る（secret は env からのみ読む）。 */
export function makeAdapterContext(
  env: Env,
  config: Record<string, unknown>,
  runtime: UploadRuntime,
): ServerAdapterContext {
  return {
    config,
    getSecret: (name: string) => readEnvSecret(env, name),
    runtime,
  };
}

// ───────────────────────── 宣言的アダプタ（設定だけで追加） ─────────────────────────

const declarativeConfigSchema = z
  .object({
    label: z.string().min(1).max(80).default("カスタムアップローダ"),
    mode: z.enum(["direct", "proxy-stream"]),
    maxBytes: z.number().int().positive().max(UPLOAD_PROXY_MAX_BYTES),
    types: z.array(z.string().min(1)).min(1),
    allowedHosts: z.array(z.string().min(1)).min(1),
    retentionSeconds: z.number().int().positive().nullable().optional(),
    requiresGithub: z.boolean().optional(),
    direct: z
      .object({
        url: z.string().url(),
        method: z.enum(["POST", "PUT"]).default("POST"),
        headers: z.record(z.string(), z.string()).optional(),
        formFields: z.record(z.string(), z.string()).optional(),
        fileField: z.string().optional(),
        resultType: z.enum(["json", "text"]).optional(),
        responseUrlPath: z.string().optional(),
      })
      .optional(),
    proxy: z
      .object({
        url: z.string().url(),
        method: z.enum(["POST", "PUT"]).default("POST"),
        headers: z.record(z.string(), z.string()).optional(),
        responseUrlPath: z.string().optional(),
        multipart: z
          .object({
            fields: z.record(z.string(), z.string()).default({}),
            fileField: z.string().default("file"),
          })
          .optional(),
      })
      .optional(),
  })
  .refine((value) => (value.mode === "direct" ? Boolean(value.direct) : Boolean(value.proxy)), {
    message: "mode に対応する direct / proxy 設定が必要です",
  });

type DeclarativeConfig = z.infer<typeof declarativeConfigSchema>;

function extractUrlFromResponse(response: unknown, path: string | undefined): string | null {
  if (typeof response === "string") return extractFirstUrl(response);
  const value = readJsonPath(response, path ?? "url");
  if (typeof value === "string") return value;
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    for (const key of ["url", "secure_url", "link", "download_url"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return null;
}

/** `uploader_adapters` の宣言的設定からアダプタを組み立てる。設定が不正なら null。 */
export function createDeclarativeAdapter(row: AdapterRow): ServerUploaderAdapter | null {
  const parsed = declarativeConfigSchema.safeParse(row.config);
  if (!parsed.success) {
    console.warn("DECLARATIVE_ADAPTER_INVALID", row.id, parsed.error.issues.map((issue) => issue.message));
    return null;
  }
  const config: DeclarativeConfig = parsed.data;
  const allowedHosts = config.allowedHosts;

  return {
    id: row.id,
    label: config.label,
    mode: config.mode,
    retentionSeconds: config.retentionSeconds ?? null,
    requiresGithub: config.requiresGithub ?? false,
    allowedHosts,
    limits: { maxBytes: config.maxBytes, types: config.types },

    async prepare() {
      if (config.mode === "direct" && config.direct) {
        return {
          mode: "direct",
          url: config.direct.url,
          method: config.direct.method,
          headers: config.direct.headers,
          formFields: config.direct.formFields,
          fileField: config.direct.fileField,
          resultType: config.direct.resultType,
          maxBytes: config.maxBytes,
        };
      }
      return { mode: "proxy-stream", proxyPath: "/v1/uploads/proxy", maxBytes: config.maxBytes };
    },

    isAvailable() {
      return true;
    },

    async finalize(res: Response | DirectResult, ctx: ServerAdapterContext): Promise<AttachmentMeta> {
      const raw = res instanceof Response ? await res.text() : res.response;
      const url = extractUrlFromResponse(raw, config.direct?.responseUrlPath);
      if (!url) throw new ApiError(502, ErrorCode.BAD_GATEWAY, `${config.label} がファイル URL を返しませんでした`);
      assertAllowedHost(url, allowedHosts, config.label);
      const ticket = ctx.runtime.ticket;
      if (!ticket) throw new ApiError(500, ErrorCode.INTERNAL, "アップロード情報が失われています");
      return {
        externalUrl: url,
        contentType: ticket.contentType,
        size: ticket.size,
        meta: { service: "declarative", adapter: row.id },
      };
    },

    upstream(req: UploadRequest) {
      const proxy = config.proxy!;
      return {
        url: proxy.url,
        method: proxy.method,
        headers: proxy.headers,
        multipart: proxy.multipart
          ? {
              fields: proxy.multipart.fields,
              fileField: proxy.multipart.fileField,
              filename: req.filename,
              contentType: req.contentType,
            }
          : undefined,
      };
    },

    async verify(url: string): Promise<boolean> {
      const response = await fetch(url, { method: "HEAD" });
      if (response.status === 404 || response.status === 410) return false;
      return true;
    },
  };
}

// ───────────────────────── 解決 ─────────────────────────

export interface ResolvedAdapter {
  id: string;
  adapter: ServerUploaderAdapter;
  config: Record<string, unknown>;
  row: AdapterRow | null;
}

/** ID からアダプタを解決する（組み込み → 宣言的設定の順）。 */
export async function resolveAdapterById(
  db: D1Database,
  adapterId: string,
): Promise<ResolvedAdapter | null> {
  const row = await readAdapterRow(db, adapterId);
  const builtin = registry.get(adapterId);
  if (builtin) {
    return { id: adapterId, adapter: builtin, config: row?.config ?? {}, row };
  }
  if (row && row.kind === "declarative") {
    const adapter = createDeclarativeAdapter(row);
    if (adapter) return { id: adapterId, adapter, config: row.config, row };
  }
  return null;
}

export interface ResolveRequestAdapterInput {
  requested?: string | null;
  boardId: number | null;
}

/** リクエストのアダプタを決める（板/サイト既定 + 有効リスト + 行の enabled）。 */
export async function resolveRequestAdapter(
  db: D1Database,
  input: ResolveRequestAdapterInput,
): Promise<ResolvedAdapter> {
  const settings = await readUploaderSettings(db, input.boardId);
  const adapterId = input.requested ?? settings.defaultAdapter;

  if (settings.enabledAdapters && !settings.enabledAdapters.includes(adapterId)) {
    throw new ApiError(400, ErrorCode.VALIDATION, `アップローダ '${adapterId}' はこのサイトで無効化されています`);
  }

  const resolved = await resolveAdapterById(db, adapterId);
  if (!resolved) {
    throw new ApiError(400, ErrorCode.VALIDATION, `不明なアップローダ '${adapterId}' です`);
  }
  if (resolved.row && resolved.row.enabled === 0) {
    throw new ApiError(400, ErrorCode.VALIDATION, `アップローダ '${adapterId}' は無効化されています`);
  }
  return resolved;
}

/** UI 向けのアダプタ一覧（有効/利用可否つき）。 */
export async function listAdapterInfos(
  env: Env,
  db: D1Database,
  runtime: UploadRuntime,
  boardId: number | null,
): Promise<{ items: UploaderAdapterInfo[]; defaultAdapter: string }> {
  const settings = await readUploaderSettings(db, boardId);
  const rows = await listAdapterRows(db);
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const candidates: Array<{ adapter: ServerUploaderAdapter; row: AdapterRow | null }> = [];
  for (const adapter of registry.values()) {
    candidates.push({ adapter, row: rowById.get(adapter.id) ?? null });
  }
  for (const row of rows) {
    if (registry.has(row.id) || row.kind !== "declarative") continue;
    const adapter = createDeclarativeAdapter(row);
    if (adapter) candidates.push({ adapter, row });
  }

  const items: UploaderAdapterInfo[] = [];
  for (const { adapter, row } of candidates) {
    if (settings.enabledAdapters && !settings.enabledAdapters.includes(adapter.id)) continue;
    const ctx = makeAdapterContext(env, row?.config ?? {}, runtime);
    const enabled = row ? row.enabled !== 0 : true;
    const available = enabled && adapter.isAvailable(ctx);
    items.push({
      id: adapter.id,
      mode: adapter.mode,
      maxBytes: adapter.limits.maxBytes,
      types: [...adapter.limits.types],
      label: adapter.label,
      available,
      reason: available ? undefined : (adapter.unavailableReason?.(ctx) || "無効化されています"),
      retentionSeconds: adapter.retentionSeconds,
      requiresGithub: adapter.requiresGithub,
    });
  }

  return { items, defaultAdapter: settings.defaultAdapter };
}