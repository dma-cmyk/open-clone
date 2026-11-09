// プラグイン API クライアント。
// 同一オリジンの `/api/v1`（next dev rewrites / vercel rewrites）経由で Worker を呼ぶ。

import type {
  PluginActiveInstall,
  PluginDetail,
  PluginInstallInfo,
  PluginListPage,
  PluginManifest,
  PluginNetFetchResult,
  PluginReviewInfo,
  PluginScope,
  PluginStaticCheckResult,
  PluginVersionInfo,
} from "shared";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

export class PluginApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PluginApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
  details?: unknown;
}

// ─── `/active` のメモ化 ──────────────────────────────────────────
// スレ画面はレス 1 件ごとに `<PluginSlot>` を置くため、同じ問い合わせが
// レス数ぶん飛ぶ。進行中の Promise を共有し、TTL 内は結果を使い回す。
const ACTIVE_TTL_MS = 5_000;
const activeCache = new Map<string, { at: number; promise: Promise<{ items: PluginActiveInstall[] }> }>();

/** 適用中プラグインを取得する（同一条件の同時/直後の呼び出しはまとめる）。 */
export function loadActiveInstalls(
  params: { boardId?: number; boardSlug?: string; threadId?: number } = {},
): Promise<{ items: PluginActiveInstall[] }> {
  const key = JSON.stringify([params.boardId ?? null, params.boardSlug ?? null, params.threadId ?? null]);
  const now = Date.now();
  const cached = activeCache.get(key);
  if (cached && now - cached.at < ACTIVE_TTL_MS) return cached.promise;

  const promise = pluginApi.active(params).catch((error: unknown) => {
    activeCache.delete(key);
    throw error;
  });
  activeCache.set(key, { at: now, promise });
  return promise;
}

/** 書き込み後・停止直後に呼ばれる（次の取得で最新を取り直す）。 */
export function invalidateActiveInstalls(): void {
  activeCache.clear();
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });

  const text = await response.text();
  let envelope: Envelope | null = null;
  try {
    envelope = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    envelope = null;
  }

  if (!envelope) {
    throw new PluginApiError(response.status, "INVALID_RESPONSE", `API 応答が不正です（HTTP ${response.status}）`);
  }
  if (envelope.ok !== true) {
    throw new PluginApiError(
      response.status,
      envelope.code ?? "UNKNOWN",
      envelope.message ?? "API エラー",
      envelope.details,
    );
  }
  // 導入・停止・バージョン更新の直後に `/active` のキャッシュを引きずらない
  if (method !== "GET") invalidateActiveInstalls();
  return envelope.data as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface PluginListParams {
  q?: string;
  scope?: PluginScope;
  sort?: "updated" | "popular" | "new";
  limit?: number;
  cursor?: string;
  mine?: boolean;
}

export interface PluginCreateInput {
  manifest: PluginManifest;
  code: string;
  changelog?: string;
  visibility?: "private" | "unlisted" | "public";
  /** テンプレート由来の任意メタ（report28 §6.3。changelog の `[template:<id>]` と併用）。 */
  templateId?: string;
}

export interface PluginVersionInput {
  version?: string;
  manifest?: PluginManifest;
  code: string;
  changelog?: string;
}

export interface PluginInstallInput {
  scope: PluginScope;
  boardId?: number;
  version?: string;
  pinned?: boolean;
  config?: Record<string, unknown>;
}

export interface PluginStateScope {
  scope: PluginScope;
  boardId?: number;
}

export const pluginApi = {
  list(params: PluginListParams = {}): Promise<PluginListPage> {
    return request("GET", `/plugins${query({ ...params })}`);
  },

  mine(): Promise<PluginListPage> {
    return request("GET", "/plugins/mine");
  },

  detail(id: string): Promise<PluginDetail> {
    return request("GET", `/plugins/${encodeURIComponent(id)}`);
  },

  versions(id: string): Promise<{ items: PluginVersionInfo[] }> {
    return request("GET", `/plugins/${encodeURIComponent(id)}/versions`);
  },

  create(input: PluginCreateInput): Promise<{
    id: string;
    name: string;
    version: string;
    checks: PluginStaticCheckResult;
    warnings: string[];
  }> {
    return request("POST", "/plugins", input);
  },

  addVersion(
    id: string,
    input: PluginVersionInput,
  ): Promise<{ version: string; checks: PluginStaticCheckResult; warnings: string[] }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/versions`, input);
  },

  publish(
    id: string,
    input: { scopes: PluginScope[]; visibility?: "private" | "unlisted" | "public" },
  ): Promise<{
    status: string;
    visibility: string;
    reviewId: string | null;
    needsReview: boolean;
    checks: PluginStaticCheckResult;
  }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/publish`, input);
  },

  install(
    id: string,
    input: PluginInstallInput,
  ): Promise<{ install: PluginInstallInfo; created: boolean; updated: boolean }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/install`, input);
  },

  update(
    id: string,
    input: { scope: PluginScope; boardId?: number; version?: string },
  ): Promise<{ install: PluginInstallInfo; updated: boolean }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/update`, input);
  },

  uninstall(id: string, input: { scope: PluginScope; boardId?: number }): Promise<{ uninstalled: boolean }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/uninstall`, input);
  },

  report(
    id: string,
    input: { reason: string; detail?: string; version?: string },
  ): Promise<{ id: string }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/report`, input);
  },

  disable(id: string, input: { reason: string; boardId?: number }): Promise<{ stopped: string }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/disable`, input);
  },

  enable(id: string): Promise<{ status: string }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/enable`, {});
  },

  remove(id: string): Promise<{ deleted: boolean }> {
    return request("DELETE", `/plugins/${encodeURIComponent(id)}`);
  },

  fork(id: string, name?: string): Promise<{ id: string; name: string; version: string }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/fork`, name ? { name } : {});
  },

  previewCheck(
    code: string,
    manifest?: PluginManifest,
  ): Promise<{ checks: PluginStaticCheckResult; warnings: string[] }> {
    return request("POST", "/plugins/preview-check", { code, manifest });
  },

  active(
    params: { boardId?: number; boardSlug?: string; threadId?: number } = {},
  ): Promise<{ items: PluginActiveInstall[] }> {
    return request("GET", `/plugins/active${query(params)}`);
  },

  installed(
    scope: PluginScope,
    boardId?: number,
  ): Promise<{
    items: Array<{
      id: string;
      pluginId: string;
      name: string;
      scope: PluginScope;
      scopeRef: string;
      version: string;
      pinned: boolean;
      enabled: boolean;
      pluginStatus: string;
      manifest: PluginManifest;
      installedBy: string | null;
      createdAt: number;
      updatedAt: number;
    }>;
  }> {
    return request("GET", `/plugins/installed${query({ scope, boardId })}`);
  },

  reviews(params: { status?: string; scope?: string; limit?: number } = {}): Promise<{ items: PluginReviewInfo[] }> {
    return request("GET", `/plugins/reviews${query({ ...params })}`);
  },

  decideReview(
    id: string,
    input: { decision: "approve" | "reject"; note?: string; scope?: "board" | "site" },
  ): Promise<{ decision: string; pluginStatus: string }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/review`, input);
  },

  exportGist(id: string, input: { public?: boolean; description?: string } = {}): Promise<{
    htmlUrl: string;
    sourceRef: string;
  }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/export/gist`, input);
  },

  exportRepo(
    id: string,
    input: { owner: string; repo: string; path?: string; message?: string },
  ): Promise<{ written: string[]; sourceRef: string }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/export/repo`, input);
  },

  importGist(gist: string): Promise<{ id: string; name: string; version: string; source: string }> {
    return request("POST", "/plugins/import/gist", { gist });
  },

  importRepo(repo: string): Promise<{ id: string; name: string; version: string; source: string }> {
    return request("POST", "/plugins/import/repo", { repo });
  },

  sync(id: string): Promise<{ updated: boolean; version: string }> {
    return request("POST", `/plugins/${encodeURIComponent(id)}/sync`, {});
  },

  state: {
    get(pluginId: string, scope: PluginStateScope, key: string): Promise<{ value: string | null }> {
      return request(
        "GET",
        `/plugins/${encodeURIComponent(pluginId)}/state${query({ scope: scope.scope, boardId: scope.boardId, key })}`,
      );
    },
    set(pluginId: string, scope: PluginStateScope, key: string, value: string): Promise<{ saved: boolean }> {
      return request("POST", `/plugins/${encodeURIComponent(pluginId)}/state`, {
        scope: scope.scope,
        boardId: scope.boardId,
        key,
        value,
      });
    },
    delete(pluginId: string, scope: PluginStateScope, key: string): Promise<{ deleted: boolean }> {
      return request(
        "DELETE",
        `/plugins/${encodeURIComponent(pluginId)}/state${query({ scope: scope.scope, boardId: scope.boardId, key })}`,
      );
    },
    list(pluginId: string, scope: PluginStateScope): Promise<{ items: Record<string, string> }> {
      return request(
        "GET",
        `/plugins/${encodeURIComponent(pluginId)}/state${query({ scope: scope.scope, boardId: scope.boardId })}`,
      );
    },
  },

  /** コード配信 URL（同一オリジン）。 */
  codeUrl(pluginId: string, version: string): string {
    return `${API_BASE}/plugins/${encodeURIComponent(pluginId)}/code?version=${encodeURIComponent(version)}`;
  },

  /** コードを取得する。停止済み（410）は PLUGIN_STOPPED で失敗する。 */
  async fetchCode(pluginId: string, version: string): Promise<string> {
    const response = await fetch(pluginApi.codeUrl(pluginId, version), { credentials: "include" });
    if (response.status === 410) {
      throw new PluginApiError(410, "PLUGIN_STOPPED", "このプラグインは停止されています");
    }
    if (!response.ok) {
      throw new PluginApiError(response.status, "CODE_FETCH_FAILED", `コード取得に失敗しました（HTTP ${response.status}）`);
    }
    return response.text();
  },

  netFetch(input: {
    pluginId: string;
    version?: string;
    scope: PluginScope;
    boardId?: number;
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<PluginNetFetchResult> {
    return request("POST", "/plugin-net/fetch", input);
  },

  githubGist(input: {
    filename: string;
    content: string;
    description?: string;
    public?: boolean;
  }): Promise<{ htmlUrl: string; id: string }> {
    return request("POST", "/github/files/gists", input);
  },

  githubPush(input: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message?: string;
  }): Promise<{ url?: string }> {
    return request("POST", "/github/files/repo/file", input);
  },

  aiComplete(input: {
    pluginId: string;
    version?: string;
    scope: PluginScope;
    boardId?: number;
    threadId?: number;
    prompt: string;
    system?: string;
    maxTokens?: number;
    consent: true;
  }): Promise<{ text: string; model?: string }> {
    return request("POST", "/ai/complete", input);
  },

  threadGet(threadId: number): Promise<unknown> {
    return request("GET", `/threads/${threadId}`);
  },

  boardGet(target: { slug?: string; boardId?: number }): Promise<unknown> {
    const key = target.slug ?? target.boardId;
    if (key === undefined) throw new PluginApiError(400, "VALIDATION", "slug か boardId が必要です");
    return request("GET", `/boards/${encodeURIComponent(String(key))}`);
  },

  postsList(threadId: number): Promise<unknown> {
    // API の上限は 100（`limit` は 1..100）。プラグインには直近 100 レスを渡す。
    return request("GET", `/threads/${threadId}/posts${query({ limit: 100 })}`);
  },

  createPost(draft: {
    boardId?: number;
    threadId?: number | null;
    name?: string;
    mail?: string;
    body: string;
  }): Promise<{ postId: number; num: number }> {
    return request("POST", "/posts", draft);
  },
};