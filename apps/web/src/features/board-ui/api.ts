// 掲示板フロントの API クライアント。
// 契約: `docs/design/CONTRACTS.md` と WP1 合意（envelope `{ok:true,data}` / `{ok:false,code,message}`）。
// 開発時は next.config.ts の rewrites により `/api/v1/*` が Worker に届く。

import type {
  AttachmentRef,
  BoardDesign,
  BoardDetail,
  BoardListResponse,
  BoardSettings,
  BoardSummary,
  Post,
  ReportItem,
  ReportReason,
  StaffEntry,
  ThreadDetail,
  ThreadListResponse,
  ThreadPage,
  ThreadSummary,
} from "./types";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  get notImplemented(): boolean {
    return this.status === 501 || this.code === "NOT_IMPLEMENTED";
  }
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
    });
  } catch (cause) {
    throw new ApiError(0, "NETWORK", cause instanceof Error ? cause.message : "ネットワークエラー");
  }

  let json: Envelope | null = null;
  try {
    json = (await response.json()) as Envelope;
  } catch {
    json = null;
  }

  if (!json || typeof json.ok !== "boolean") {
    throw new ApiError(response.status, "INVALID_RESPONSE", `API 応答が不正です (HTTP ${response.status})`);
  }
  if (!json.ok) {
    throw new ApiError(response.status, json.code ?? "UNKNOWN", json.message ?? "エラーが発生しました");
  }
  return json.data as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

function toSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return toSeconds(numeric);
    }
  }
  return Math.floor(Date.now() / 1000);
}

export function normalizePost(raw: unknown): Post {
  const record = (raw ?? {}) as Record<string, unknown>;
  const id = Number(record.id ?? record.postId ?? 0);
  const num = Number(record.num ?? record.number ?? 0);
  return {
    id: Number.isFinite(id) ? id : 0,
    num: Number.isFinite(num) ? num : 0,
    name: String(record.name ?? "名無しさん"),
    trip: typeof record.trip === "string" ? record.trip : undefined,
    cap: typeof record.cap === "string" ? record.cap : undefined,
    mail: typeof record.mail === "string" ? record.mail : undefined,
    sage: Boolean(record.sage),
    body: String(record.body ?? ""),
    createdAt: toSeconds(record.createdAt ?? record.created_at),
    idHash: typeof (record.idHash ?? record.id) === "string" ? String(record.idHash ?? record.id) : undefined,
    isOp: Boolean(record.isOp ?? record.is_op),
    isSub: Boolean(record.isSub ?? record.is_sub),
    attachments: Array.isArray(record.attachments)
      ? (record.attachments as Record<string, unknown>[])
          .map((item) => ({
            id: typeof item.id === "string" ? item.id : undefined,
            url: String(item.url ?? ""),
            contentType: typeof item.contentType === "string" ? item.contentType : undefined,
            size: typeof item.size === "number" ? item.size : undefined,
            name: typeof item.name === "string" ? item.name : undefined,
          }))
          .filter((item) => item.url.length > 0)
      : undefined,
    likeCount: Number(record.likeCount ?? record.like_count ?? 0) || 0,
    liked: Boolean(record.liked),
    backlinks: Array.isArray(record.backlinks)
      ? (record.backlinks as unknown[]).map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : undefined,
    kind: record.kind === "tsubuyaki" ? "tsubuyaki" : "post",
    provider: typeof record.provider === "string" ? record.provider : undefined,
    aiAgent:
      record.aiAgent && typeof record.aiAgent === "object"
        ? (record.aiAgent as { id?: string; name?: string })
        : typeof record.aiAgentId === "string"
          ? { id: record.aiAgentId }
          : null,
    hidden: Boolean(record.hidden),
  };
}

function normalizeThread(raw: unknown): ThreadDetail {
  const record = (raw ?? {}) as Record<string, unknown>;
  return {
    id: Number(record.id ?? 0),
    title: String(record.title ?? ""),
    boardSlug: String(record.boardSlug ?? record.board_slug ?? ""),
    boardName: typeof record.boardName === "string" ? record.boardName : undefined,
    postCount: Number(record.postCount ?? record.post_count ?? 0) || 0,
    maxPosts: record.maxPosts === undefined ? undefined : Number(record.maxPosts),
    live: Boolean(record.live),
    pinned: Boolean(record.pinned),
    status: typeof record.status === "string" ? record.status : undefined,
    createdAt: record.createdAt === undefined ? undefined : toSeconds(record.createdAt),
    lastPostAt: record.lastPostAt === undefined ? undefined : toSeconds(record.lastPostAt),
  };
}

export interface ThreadQuery {
  r?: string;
  id?: string;
  q?: string;
  since?: number;
  images?: boolean;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface UploadPlan {
  mode: "direct" | "proxy-stream";
  url?: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  formFields?: Record<string, string>;
  fileField?: string;
  resultType?: "json" | "text";
  proxyPath?: string;
}

export interface UploadPrepareResult {
  ticketId: string;
  adapter: string;
  mode: "direct" | "proxy-stream";
  plan: UploadPlan;
  maxBytes: number;
  contentType: string;
  uploadToken?: string;
  expiresAt: number;
}

export const api = {
  async listBoards(category?: string): Promise<BoardListResponse> {
    const data = await get<{ items?: BoardSummary[]; categories?: string[] }>(
      `/boards${query({ category, limit: 500 })}`,
    );
    const items = Array.isArray(data.items) ? data.items : [];
    const categories = Array.isArray(data.categories)
      ? data.categories
      : Array.from(new Set(items.map((item) => item.category).filter(Boolean)));
    return { items, categories };
  },

  createBoard(input: {
    slug: string;
    name: string;
    category: string;
    description?: string;
    rulesMd?: string;
    design?: BoardDesign;
    settings?: BoardSettings;
    turnstileToken?: string;
  }): Promise<BoardDetail> {
    return post<{ board: BoardDetail }>("/boards", input).then((data) => data.board);
  },

  getBoard(slug: string): Promise<{ board: BoardDetail; staff: StaffEntry[]; canManage: boolean }> {
    return get<{
      board?: BoardDetail;
      staff?: (StaffEntry & { accountName?: string })[];
      canManage?: boolean;
      design?: BoardDetail["design"];
      settings?: BoardDetail["settings"];
    }>(`/boards/${encodeURIComponent(slug)}`).then((data) => {
      const board = data.board ?? { id: slug, slug, name: slug, category: "" };
      return {
        board: {
          ...board,
          design: board.design ?? data.design,
          settings: board.settings ?? data.settings,
        },
        staff: Array.isArray(data.staff)
          ? data.staff.map((entry) => ({
              accountId: entry.accountId,
              name: entry.accountName ?? entry.name,
              level: entry.level,
            }))
          : [],
        canManage: Boolean(data.canManage),
      };
    });
  },

  updateBoard(slug: string, input: Record<string, unknown>): Promise<BoardDetail> {
    return patch<{ board: BoardDetail }>(`/boards/${encodeURIComponent(slug)}`, input).then((data) => data.board);
  },

  async listThreads(
    slug: string,
    params: { sort?: string; q?: string; cursor?: string; limit?: number } = {},
  ): Promise<ThreadListResponse> {
    const data = await get<{ items?: ThreadSummary[]; nextCursor?: string | null }>(
      `/boards/${encodeURIComponent(slug)}/threads${query({
        sort: params.sort,
        q: params.q,
        cursor: params.cursor,
        limit: params.limit ?? 100,
      })}`,
    );
    return { items: Array.isArray(data.items) ? data.items : [], nextCursor: data.nextCursor ?? null };
  },

  createThread(
    slug: string,
    input: { title: string; body: string; name?: string; mail?: string; mode?: string; turnstileToken?: string },
  ): Promise<{ threadId: number; post?: Post }> {
    return post<{ threadId: number; post?: Post }>(`/boards/${encodeURIComponent(slug)}/threads`, input);
  },

  getStaff(slug: string): Promise<StaffEntry[]> {
    return get<{ items?: (StaffEntry & { accountName?: string })[] }>(
      `/boards/${encodeURIComponent(slug)}/staff`,
    ).then((data) =>
      Array.isArray(data.items)
        ? data.items.map((entry) => ({
            accountId: entry.accountId,
            name: entry.accountName ?? entry.name,
            level: entry.level,
          }))
        : [],
    );
  },

  async setStaff(slug: string, accountName: string, level: string): Promise<StaffEntry[]> {
    await post<unknown>(`/boards/${encodeURIComponent(slug)}/staff`, { accountName, level });
    return api.getStaff(slug);
  },

  async removeStaff(slug: string, accountId: string): Promise<StaffEntry[]> {
    await del<unknown>(`/boards/${encodeURIComponent(slug)}/staff/${encodeURIComponent(accountId)}`);
    return api.getStaff(slug);
  },

  async getThread(threadId: number, params: ThreadQuery = {}): Promise<ThreadPage> {
    const data = await get<{ thread?: unknown; posts?: unknown[]; hasMore?: boolean }>(
      `/threads/${threadId}${query({
        r: params.images ? undefined : params.r,
        images: params.images ? "1" : undefined,
        id: params.id,
        q: params.q,
        since: params.since,
      })}`,
    );
    return {
      thread: normalizeThread(data.thread),
      posts: Array.isArray(data.posts) ? data.posts.map(normalizePost) : [],
      hasMore: Boolean(data.hasMore),
    };
  },

  async getPostsSince(threadId: number, since: number, limit = 100): Promise<{ items: Post[]; postCount: number }> {
    const data = await get<{ items?: unknown[]; thread?: { postCount?: number } }>(
      `/threads/${threadId}/posts${query({ since, limit })}`,
    );
    return {
      items: Array.isArray(data.items) ? data.items.map(normalizePost) : [],
      postCount: Number(data.thread?.postCount ?? 0) || 0,
    };
  },

  createPost(
    threadId: number,
    input: {
      name?: string;
      mail?: string;
      body: string;
      sage?: boolean;
      attachments?: string[];
      turnstileToken?: string;
    },
  ): Promise<{ post: Post; thread?: { postCount?: number } }> {
    return post<{ post?: unknown; thread?: { postCount?: number } }>(`/threads/${threadId}/posts`, input).then(
      (data) => ({ post: normalizePost(data.post), thread: data.thread }),
    );
  },

  sendTsubuyaki(threadId: number, body: string, turnstileToken?: string): Promise<Post | undefined> {
    return post<{ tsubuyaki?: unknown }>(`/threads/${threadId}/tsubuyaki`, { body, turnstileToken }).then((data) =>
      data.tsubuyaki ? normalizePost(data.tsubuyaki) : undefined,
    );
  },

  likePost(postId: number): Promise<{ count: number; liked: boolean }> {
    return post<{ count?: number; liked?: boolean }>(`/posts/${postId}/like`).then((data) => ({
      count: Number(data.count ?? 0) || 0,
      liked: Boolean(data.liked),
    }));
  },

  hidePost(postId: number): Promise<void> {
    return post<unknown>(`/posts/${postId}/hide`).then(() => undefined);
  },

  deletePost(postId: number): Promise<void> {
    return del<unknown>(`/posts/${postId}`).then(() => undefined);
  },

  createReport(input: {
    boardSlug: string;
    threadId: number;
    posts: string;
    reason: ReportReason;
    comment?: string;
    turnstileToken?: string;
  }): Promise<{ id: string | number }> {
    return post<{ id: string | number }>("/reports", input);
  },

  listReports(params: { board?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<{
    items: ReportItem[];
    nextCursor: string | null;
  }> {
    return get<{ items?: ReportItem[]; nextCursor?: string | null }>(`/reports${query(params)}`).then((data) => ({
      items: Array.isArray(data.items) ? data.items : [],
      nextCursor: data.nextCursor ?? null,
    }));
  },

  /** 通報の処理（WP1 `POST /v1/reports/:id/handle`）。 */
  handleReport(
    id: string | number,
    action: "reject" | "resolve" | "hide" | "delete",
    note?: string,
  ): Promise<void> {
    return post<unknown>(`/reports/${encodeURIComponent(String(id))}/handle`, { action, note: note ?? "" }).then(
      () => undefined,
    );
  },

  /** ログイン中アカウント（WP6 API）。未実装・未ログイン時は null。 */
  async getSession(): Promise<{ id: string; name: string; role: string } | null> {
    try {
      const data = await get<{ account?: { id?: string; name?: string; role?: string } | null }>("/auth/session");
      const account = data?.account;
      if (account && account.name) {
        return { id: String(account.id ?? ""), name: account.name, role: String(account.role ?? "user") };
      }
      return null;
    } catch {
      return null;
    }
  },

  /** アップロード準備（WP4 の契約）。 */
  uploadPrepare(input: {
    filename: string;
    contentType: string;
    size: number;
    boardId?: number;
    purpose?: string;
  }): Promise<UploadPrepareResult> {
    return post<UploadPrepareResult>("/uploads/prepare", input);
  },

  /** proxy-stream モード: Worker が外部サービスへ中継する（ファイル本体は Cloudflare に保存されない）。 */
  async uploadProxy(plan: UploadPlan, file: Blob, uploadToken: string | undefined): Promise<void> {
    if (!plan.proxyPath) {
      throw new ApiError(500, "INVALID_PLAN", "proxy のアップロード先がありません");
    }
    const response = await fetch(plan.proxyPath, {
      method: "POST",
      headers: {
        "content-type": file.type || "application/octet-stream",
        ...(uploadToken ? { "x-upload-token": uploadToken } : {}),
      },
      body: file,
      credentials: "include",
    });
    const json = (await response.json().catch(() => null)) as Envelope | null;
    if (!json || json.ok !== true) {
      throw new ApiError(response.status, json?.code ?? "UPLOAD_FAILED", json?.message ?? "アップロードに失敗しました");
    }
  },

  /** direct モード: 外部サービスへ直接送信し、応答を commit に渡す。 */
  async uploadDirect(plan: UploadPlan, file: Blob): Promise<unknown> {
    if (!plan.url) {
      throw new ApiError(500, "INVALID_PLAN", "direct のアップロード先がありません");
    }
    const method = plan.method ?? "POST";
    let body: BodyInit;
    const headers: Record<string, string> = { ...(plan.headers ?? {}) };
    if (plan.formFields) {
      const form = new FormData();
      for (const [key, value] of Object.entries(plan.formFields)) {
        form.append(key, value);
      }
      form.append(plan.fileField ?? "file", file, file instanceof File ? file.name : "upload.bin");
      body = form;
    } else {
      body = file;
      headers["content-type"] = file.type || "application/octet-stream";
    }
    const response = await fetch(plan.url, { method, headers, body });
    if (!response.ok) {
      throw new ApiError(response.status, "UPLOAD_FAILED", `アップロードに失敗しました (HTTP ${response.status})`);
    }
    if (plan.resultType === "text") {
      return response.text();
    }
    return response.json().catch(() => response.text());
  },

  /** アップロード確定。添付 DTO を返す。 */
  uploadCommit(input: { ticketId: string; externalUrl?: string; response?: unknown }): Promise<AttachmentRef> {
    return post<AttachmentRef>("/uploads/commit", input);
  },

  /** 実況の同時接続数（WP1 `/v1/rt/stats`）。 */
  rtStats(channel: string): Promise<{ connections: number; channels: Record<string, number> }> {
    return get<{ connections?: number; channels?: Record<string, number> }>(`/rt/stats${query({ channel })}`).then(
      (data) => ({
        connections: Number(data.connections ?? 0) || 0,
        channels: data.channels ?? {},
      }),
    );
  },
};

/** WebSocket のベース URL。rewrites は WS を中継しないため Worker に直接接続する（DESIGN §2.2）。 */
export function wsBase(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_BASE;
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  const apiBase = process.env.NEXT_PUBLIC_API_BASE;
  if (apiBase && /^https?:\/\//.test(apiBase)) {
    return apiBase.replace(/^http/, "ws").replace(/\/v1$/, "").replace(/\/api$/, "");
  }
  if (typeof window !== "undefined") {
    // 開発時: next dev は WS をプロキシできないため、API の既定ポートへ直接つなぐ。
    const port = process.env.NODE_ENV === "production" ? window.location.port : "8787";
    return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}${
      port ? `:${port}` : ""
    }`;
  }
  return "ws://127.0.0.1:8787";
}

export async function fetchRealtimeTicket(channel: string): Promise<{ ticket: string; expiresAt?: number }> {
  return post<{ ticket?: string; expiresAt?: number }>("/rt/ticket", { channels: [channel] }).then((data) => {
    if (!data.ticket) {
      throw new ApiError(500, "NO_TICKET", "チケットの発行に失敗しました");
    }
    return { ticket: data.ticket, expiresAt: data.expiresAt };
  });
}