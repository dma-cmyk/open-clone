// 検索・ランキング・ヘッドライン・通報管理ページ共通の API クライアント。
// 契約: `{ ok: true, data }` / `{ ok: false, code, message }`（CONTRACTS §2）。

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

export class Wp1ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "Wp1ApiError";
    this.status = status;
    this.code = code;
  }
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

export async function wp1Request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: "include",
      ...init,
      headers: init.body === undefined ? init.headers : { "content-type": "application/json", ...init.headers },
    });
  } catch (cause) {
    throw new Wp1ApiError(0, "NETWORK", cause instanceof Error ? cause.message : "ネットワークエラー");
  }
  let json: Envelope | null = null;
  try {
    json = (await response.json()) as Envelope;
  } catch {
    json = null;
  }
  if (!json || typeof json.ok !== "boolean") {
    throw new Wp1ApiError(response.status, "INVALID_RESPONSE", `API 応答が不正です (HTTP ${response.status})`);
  }
  if (!json.ok) {
    throw new Wp1ApiError(response.status, json.code ?? "UNKNOWN", json.message ?? "エラーが発生しました");
  }
  return json.data as T;
}

export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export interface ThreadHit {
  id: number;
  title: string;
  postCount: number;
  lastPostAt: number;
  createdAt: number;
  boardSlug: string;
  boardName: string;
}

export interface PostHit {
  id: number;
  threadId: number;
  num: number;
  name: string;
  body: string;
  createdAt: number;
  idHash: string;
}

export type SearchItem =
  | { type: "thread"; thread: ThreadHit }
  | {
      type: "post";
      post: PostHit;
      thread: { id: number; title: string; boardSlug: string; boardName: string };
    };

export interface SearchResponse {
  type: string;
  items: SearchItem[];
  nextCursor: string | null;
}

export function search(params: {
  q: string;
  type: "thread" | "full" | "id" | "image";
  board?: string;
  limit?: number;
  cursor?: string;
}): Promise<SearchResponse> {
  return wp1Request<SearchResponse>(`/search${queryString(params)}`);
}

export function suggest(): Promise<{ items: Array<{ term: string; count: number }> }> {
  return wp1Request<{ items: Array<{ term: string; count: number }> }>("/search/suggest");
}

export interface RankingItem {
  rank: number;
  threadId: number;
  title: string;
  boardSlug: string;
  boardName: string;
  postCount: number;
  recentPosts: number;
  speed: number;
  connections: number;
  lastPostAt: number;
  createdAt: number;
}

export function ranking(params: {
  period: "hour" | "day" | "all";
  metric: "speed" | "posts" | "connections";
  board?: string;
  limit?: number;
}): Promise<{ period: string; metric: string; items: RankingItem[]; capturedAt: number }> {
  return wp1Request(`/ranking${queryString(params)}`);
}

export interface HeadlineItem {
  threadId: number;
  title: string;
  boardSlug: string;
  boardName: string;
  postCount: number;
  lastPostAt: number;
  createdAt: number;
  live: boolean;
  pinned: boolean;
  speed: number;
}

export function headline(params: {
  period: "1h" | "24h" | "7d" | "all";
  sort: "bump" | "created" | "posts" | "speed";
  board?: string;
  minPosts?: number;
  limit?: number;
}): Promise<{ period: string; sort: string; items: HeadlineItem[] }> {
  return wp1Request(`/headline${queryString(params)}`);
}