// GitHub サービスの実装。
//
// - 契約（WORKPACKAGES / CONTRACTS §12）の関数名 `createGist / updateGist / pushToRepo / getFile /
//   listUserRepos / getRateInfo` を export する。マルチユーザーのトークンを扱うため、
//   第2引数に解決済みの `GithubClient`（= `await githubClient(env, accountId)`）を受け取る。
// - 全ての操作は本人の GitHub リソースのみ・レート残確認付き・`github_ops_log` に監査記録する。
// - GitHub の制限（100MiB/ファイル、Contents API は 1MiB を実用上限、Gist 1MiB/ファイル）をコードで守る。

import { ApiError, ErrorCode, ulid } from "shared";
import {
  GITHUB_API_BASE,
  GITHUB_CONTENTS_API_MAX_BYTES,
  GITHUB_LINK_REQUIRED_DETAILS,
  GITHUB_MAX_FILE_BYTES,
  GITHUB_RATE_SAFETY_MARGIN,
  GIST_MAX_FILE_BYTES,
  type GistSummary,
  type GithubRate,
  type RepoFileDto,
  type RepoSummaryDto,
} from "shared/schemas/github";
import type { Env } from "../../lib/env";
import { baseUrlOf } from "../env-secrets";
import { decryptSecret, encryptSecret } from "./crypto";
import type { GithubConnection, GithubOpLog } from "./types";
import { bytesToBase64, base64ToBytes } from "../uploads/util";

// ───────────────────────── 契約互換の型 ─────────────────────────

export interface CreateGistInput {
  description?: string;
  public: boolean;
  files: Record<string, { content: string; filename?: string }>;
}

export interface CreateGistResult {
  id: string;
  htmlUrl: string;
  rawUrl?: string;
  description: string | null;
  public: boolean;
  files: Array<{ filename: string; size: number; rawUrl: string | null }>;
}

export interface UpdateGistInput {
  description?: string;
  /** null を渡すとそのファイルを削除する */
  files?: Record<string, { content: string; filename?: string } | null>;
}

export interface PushToRepoInput {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  sha?: string;
  branch?: string;
}

export interface PushToRepoResult {
  sha: string;
  commitSha: string | null;
  htmlUrl: string | null;
  rawUrl: string | null;
}

export interface RepoSummary {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
}

export interface RateInfo {
  limit: number;
  remaining: number;
  reset: number;
  resource: string;
}

export interface GetFileInput {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}

interface GistCreateBody {
  description?: string;
  public: boolean;
  files: Record<string, { content: string }>;
}

interface GistUpdateBody {
  description?: string;
  files?: Record<string, { content: string } | null>;
}

interface RepoListQuery {
  page: number;
  perPage: number;
  sort: "updated" | "pushed" | "full_name" | "created";
}

// ───────────────────────── 監査ログ ─────────────────────────

export async function logGithubOp(db: D1Database, entry: GithubOpLog): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO github_ops_log (id, account_id, op, ref, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        ulid(),
        entry.accountId,
        entry.op,
        entry.ref ?? null,
        entry.status,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        Math.floor(Date.now() / 1000),
      )
      .run();
  } catch (error) {
    console.error("GITHUB_OP_LOG_FAILED", { op: entry.op, error: String(error) });
  }
}

// ───────────────────────── 連携の解決・保存 ─────────────────────────

interface GithubLinkRow {
  account_id: string;
  github_user: string;
  github_user_id: number | null;
  avatar_url: string | null;
  token_enc: string;
  scopes: string;
  method: "oauth" | "pat";
  rate_limit: number | null;
  rate_remaining: number | null;
  rate_reset: number | null;
  rate_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

export function githubLinkRequiredError(): ApiError {
  return new ApiError(
    403,
    ErrorCode.FORBIDDEN,
    "GitHub 連携が必要です。アカウント設定（/account/github）から連携してください",
    GITHUB_LINK_REQUIRED_DETAILS,
  );
}

/** 連携済みトークンを復号して返す。未連携は 403 + 連携誘導 details。 */
export async function resolveGithubConnection(env: Env, accountId: string): Promise<GithubConnection> {
  const row = await env.DB.prepare(
    `SELECT account_id, github_user, github_user_id, avatar_url, token_enc, scopes, method,
            rate_limit, rate_remaining, rate_reset, rate_checked_at, created_at, updated_at
     FROM github_links WHERE account_id = ?`,
  )
    .bind(accountId)
    .first<GithubLinkRow>();
  if (!row) throw githubLinkRequiredError();

  const token = await decryptSecret(row.token_enc, env.ENC_KEY);
  return {
    accountId,
    token,
    login: row.github_user,
    userId: row.github_user_id,
    avatarUrl: row.avatar_url,
    scopes: row.scopes.split(/\s+/).filter(Boolean),
    method: row.method,
    rate:
      row.rate_limit === null && row.rate_remaining === null
        ? null
        : {
            limit: row.rate_limit ?? 0,
            remaining: row.rate_remaining ?? 0,
            reset: row.rate_reset ?? 0,
            resource: "core",
          },
  };
}

export interface SaveGithubLinkInput {
  accountId: string;
  token: string;
  login: string;
  userId: number | null;
  avatarUrl: string | null;
  scopes: string[];
  method: "oauth" | "pat";
  rate?: GithubRate | null;
}

/** トークンを AES-GCM で暗号化して保存する（平文は保存しない）。 */
export async function saveGithubLink(env: Env, input: SaveGithubLinkInput): Promise<GithubConnection> {
  const now = Math.floor(Date.now() / 1000);
  const tokenEnc = await encryptSecret(input.token, env.ENC_KEY);
  await env.DB.prepare(
    `INSERT INTO github_links
       (account_id, github_user, github_user_id, avatar_url, token_enc, scopes, method,
        rate_limit, rate_remaining, rate_reset, rate_checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       github_user = excluded.github_user,
       github_user_id = excluded.github_user_id,
       avatar_url = excluded.avatar_url,
       token_enc = excluded.token_enc,
       scopes = excluded.scopes,
       method = excluded.method,
       rate_limit = excluded.rate_limit,
       rate_remaining = excluded.rate_remaining,
       rate_reset = excluded.rate_reset,
       rate_checked_at = excluded.rate_checked_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.accountId,
      input.login,
      input.userId,
      input.avatarUrl,
      tokenEnc,
      input.scopes.join(" "),
      input.method,
      input.rate?.limit ?? null,
      input.rate?.remaining ?? null,
      input.rate?.reset ?? null,
      input.rate ? now : null,
      now,
      now,
    )
    .run();

  return {
    accountId: input.accountId,
    token: input.token,
    login: input.login,
    userId: input.userId,
    avatarUrl: input.avatarUrl,
    scopes: input.scopes,
    method: input.method,
    rate: input.rate ?? null,
  };
}

export async function deleteGithubLink(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM github_links WHERE account_id = ?").bind(accountId).run();
}

export interface GithubLinkStatusRow {
  login: string;
  userId: number | null;
  avatarUrl: string | null;
  method: "oauth" | "pat";
  scopes: string[];
  linkedAt: number;
  rate: GithubRate | null;
}

/** 連携状態（トークンは含めない）。 */
export async function readGithubLinkStatus(env: Env, accountId: string): Promise<GithubLinkStatusRow | null> {
  const row = await env.DB.prepare(
    `SELECT github_user, github_user_id, avatar_url, method, scopes, created_at,
            rate_limit, rate_remaining, rate_reset
     FROM github_links WHERE account_id = ?`,
  )
    .bind(accountId)
    .first<{
      github_user: string;
      github_user_id: number | null;
      avatar_url: string | null;
      method: "oauth" | "pat";
      scopes: string;
      created_at: number;
      rate_limit: number | null;
      rate_remaining: number | null;
      rate_reset: number | null;
    }>();
  if (!row) return null;
  return {
    login: row.github_user,
    userId: row.github_user_id,
    avatarUrl: row.avatar_url,
    method: row.method,
    scopes: row.scopes.split(/\s+/).filter(Boolean),
    linkedAt: row.created_at,
    rate:
      row.rate_limit === null
        ? null
        : { limit: row.rate_limit, remaining: row.rate_remaining ?? 0, reset: row.rate_reset ?? 0, resource: "core" },
  };
}

// ───────────────────────── API 呼び出し ─────────────────────────

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  op: string;
  ref?: string;
  body?: unknown;
  /** レート残チェックをスキップ（/rate_limit 自体の取得用） */
  skipRateGuard?: boolean;
  /** レートキャッシュを更新しない（監視用の軽い呼び出し） */
  skipRatePersist?: boolean;
}

function parseRate(response: Response): GithubRate | null {
  const limit = response.headers.get("x-ratelimit-limit");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return null;
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    reset: Number(reset),
    resource: response.headers.get("x-ratelimit-resource") ?? "core",
  };
}

async function readGithubErrorBody(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { message?: string };
    return typeof body.message === "string" ? body.message.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** GitHub API のエラーを API envelope のエラーへ変換する（生の本文は details に短縮して載せる）。 */
export async function toGithubApiError(response: Response): Promise<ApiError> {
  const rate = parseRate(response);
  if (response.status === 401) {
    return new ApiError(401, ErrorCode.UNAUTHORIZED, "GitHub の認証が失効しました。再連携してください");
  }
  if (response.status === 403 && rate && rate.remaining === 0) {
    return new ApiError(429, ErrorCode.RATE_LIMITED, "GitHub API のレート上限に達しました。時間をおいて再試行してください", {
      reset: rate.reset,
    });
  }
  if (response.status === 404) {
    return ApiError.notFound("GitHub のリソースが見つかりません");
  }
  if (response.status === 422) {
    const message = await readGithubErrorBody(response);
    return ApiError.validation(message ?? "GitHub がリクエストを受理しませんでした");
  }
  if (response.status === 429) {
    return new ApiError(429, ErrorCode.RATE_LIMITED, "GitHub API のレート上限に達しました", { reset: rate?.reset });
  }
  const message = await readGithubErrorBody(response);
  return new ApiError(502, ErrorCode.BAD_GATEWAY, `GitHub API エラー（HTTP ${response.status}）`, {
    githubMessage: message,
  });
}

/** 認証付き GitHub API クライアント。1 リクエスト内で使い捨てる（トークンはメモリ上のみ）。 */
export class GithubClient {
  constructor(
    private readonly env: Env,
    public readonly connection: GithubConnection,
  ) {}

  private async persistRate(rate: GithubRate | null): Promise<void> {
    if (!rate) return;
    this.connection.rate = rate;
    try {
      await this.env.DB.prepare(
        "UPDATE github_links SET rate_limit = ?, rate_remaining = ?, rate_reset = ?, rate_checked_at = ? WHERE account_id = ?",
      )
        .bind(rate.limit, rate.remaining, rate.reset, Math.floor(Date.now() / 1000), this.connection.accountId)
        .run();
    } catch (error) {
      console.error("GITHUB_RATE_PERSIST_FAILED", String(error));
    }
  }

  /** GitHub API へ 1 回だけ投げ、レートを更新し、失敗を ApiError に変換する。 */
  async request<T>(path: string, options: RequestOptions): Promise<{ data: T; rate: GithubRate | null }> {
    const now = Math.floor(Date.now() / 1000);
    const cached = this.connection.rate;
    if (
      !options.skipRateGuard &&
      cached &&
      cached.remaining <= GITHUB_RATE_SAFETY_MARGIN &&
      cached.reset > now
    ) {
      await logGithubOp(this.env.DB, {
        accountId: this.connection.accountId,
        op: options.op,
        ref: options.ref,
        status: "blocked",
        detail: { reason: "rate_margin", remaining: cached.remaining, reset: cached.reset },
      });
      throw new ApiError(429, ErrorCode.RATE_LIMITED, "GitHub API のレート残が少ないため操作を停止しました", {
        remaining: cached.remaining,
        reset: cached.reset,
      });
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrlOf(this.env, "GITHUB_API_BASE", GITHUB_API_BASE)}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "open-clone/1.0 (+https://github.com/)",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      await logGithubOp(this.env.DB, {
        accountId: this.connection.accountId,
        op: options.op,
        ref: options.ref,
        status: "error",
        detail: { reason: "network", message: String(error).slice(0, 200) },
      });
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, "GitHub に接続できませんでした");
    }

    const rate = parseRate(response);
    if (!options.skipRatePersist) await this.persistRate(rate);

    if (!response.ok) {
      const error = await toGithubApiError(response);
      await logGithubOp(this.env.DB, {
        accountId: this.connection.accountId,
        op: options.op,
        ref: options.ref,
        status: "error",
        detail: { status: response.status, code: error.code },
      });
      throw error;
    }

    await logGithubOp(this.env.DB, {
      accountId: this.connection.accountId,
      op: options.op,
      ref: options.ref,
      status: "ok",
      detail: rate ? { remaining: rate.remaining } : undefined,
    });

    if (response.status === 204) return { data: undefined as T, rate };
    const text = await response.text();
    if (!text) return { data: undefined as T, rate };
    return { data: JSON.parse(text) as T, rate };
  }
}

/** 連携を解決してクライアントを作る（WP3 のプラグイン配布等から使う）。 */
export async function githubClient(env: Env, accountId: string): Promise<GithubClient> {
  return new GithubClient(env, await resolveGithubConnection(env, accountId));
}

// ───────────────────────── Gist ─────────────────────────

interface GistApiFile {
  filename: string;
  size?: number;
  raw_url?: string;
  content?: string;
}

interface GistApiResponse {
  id: string;
  html_url: string;
  description: string | null;
  public: boolean;
  created_at?: string;
  updated_at?: string;
  files: Record<string, GistApiFile>;
}

function mapGist(data: GistApiResponse): CreateGistResult {
  const files = Object.values(data.files ?? {}).map((file) => ({
    filename: file.filename,
    size: file.size ?? file.content?.length ?? 0,
    rawUrl: file.raw_url ?? null,
  }));
  const rawUrl = files.map((file) => file.rawUrl).find((url): url is string => Boolean(url));
  return {
    id: data.id,
    htmlUrl: data.html_url,
    rawUrl,
    description: data.description ?? null,
    public: data.public,
    files,
  };
}

function toGistApiFiles(
  files: Record<string, { content: string; filename?: string }>,
): Record<string, { content: string }> {
  const result: Record<string, { content: string }> = {};
  for (const [name, file] of Object.entries(files)) {
    if (new TextEncoder().encode(file.content).byteLength > GIST_MAX_FILE_BYTES) {
      throw ApiError.validation(`${name} が Gist の 1 ファイル上限（1MB）を超えています`);
    }
    result[file.filename ?? name] = { content: file.content };
  }
  return result;
}

export async function createGist(client: GithubClient, input: CreateGistInput): Promise<CreateGistResult> {
  const body: GistCreateBody = {
    description: input.description,
    public: input.public,
    files: toGistApiFiles(input.files),
  };
  const { data } = await client.request<GistApiResponse>("/gists", {
    method: "POST",
    op: "gist.create",
    ref: body.description?.slice(0, 80),
    body,
  });
  return mapGist(data);
}

export async function updateGist(
  client: GithubClient,
  gistId: string,
  input: UpdateGistInput,
): Promise<CreateGistResult> {
  const files: Record<string, { content: string } | null> = {};
  for (const [name, file] of Object.entries(input.files ?? {})) {
    if (file === null) {
      files[name] = null;
      continue;
    }
    if (new TextEncoder().encode(file.content).byteLength > GIST_MAX_FILE_BYTES) {
      throw ApiError.validation(`${name} が Gist の 1 ファイル上限（1MB）を超えています`);
    }
    files[file.filename ?? name] = { content: file.content };
  }
  const body: GistUpdateBody = { description: input.description, files };
  const { data } = await client.request<GistApiResponse>(`/gists/${encodeURIComponent(gistId)}`, {
    method: "PATCH",
    op: "gist.update",
    ref: gistId,
    body,
  });
  return mapGist(data);
}

export async function getGist(client: GithubClient, gistId: string): Promise<GistSummary> {
  const { data } = await client.request<GistApiResponse>(`/gists/${encodeURIComponent(gistId)}`, {
    method: "GET",
    op: "gist.get",
    ref: gistId,
  });
  return {
    id: data.id,
    htmlUrl: data.html_url,
    description: data.description ?? null,
    public: data.public,
    createdAt: data.created_at ?? null,
    updatedAt: data.updated_at ?? null,
    files: Object.values(data.files ?? {}).map((file) => ({
      filename: file.filename,
      size: file.size ?? 0,
      rawUrl: file.raw_url ?? null,
    })),
  };
}

export async function listGists(client: GithubClient, page = 1, perPage = 30): Promise<GistSummary[]> {
  const { data } = await client.request<GistApiResponse[]>(
    `/gists?page=${page}&per_page=${Math.min(perPage, 100)}`,
    { method: "GET", op: "gist.list" },
  );
  return data.map((gist) => ({
    id: gist.id,
    htmlUrl: gist.html_url,
    description: gist.description ?? null,
    public: gist.public,
    createdAt: gist.created_at ?? null,
    updatedAt: gist.updated_at ?? null,
    files: Object.values(gist.files ?? {}).map((file) => ({
      filename: file.filename,
      size: file.size ?? 0,
      rawUrl: file.raw_url ?? null,
    })),
  }));
}

export async function deleteGist(client: GithubClient, gistId: string): Promise<void> {
  await client.request<undefined>(`/gists/${encodeURIComponent(gistId)}`, {
    method: "DELETE",
    op: "gist.delete",
    ref: gistId,
  });
}

// ───────────────────────── リポジトリ ─────────────────────────

interface ContentsApiResponse {
  content?: string;
  encoding?: string;
  sha: string;
  size: number;
  html_url?: string;
  download_url?: string;
  path: string;
}

interface ContentsWriteResponse {
  content: ContentsApiResponse | null;
  commit?: { sha?: string; html_url?: string };
}

function decodeRepoContent(data: ContentsApiResponse): string | null {
  if (!data.content || data.encoding !== "base64") return null;
  if (data.size > GITHUB_CONTENTS_API_MAX_BYTES) return null;
  try {
    const bytes = base64ToBytes(data.content.replace(/\s+/g, ""));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function toRepoFileDto(data: ContentsApiResponse): RepoFileDto {
  return {
    path: data.path,
    sha: data.sha,
    size: data.size,
    content: decodeRepoContent(data),
    encoding: data.encoding ?? null,
    htmlUrl: data.html_url ?? null,
    downloadUrl: data.download_url ?? null,
    rawUrl: data.download_url ?? null,
  };
}

export async function getFile(client: GithubClient, input: GetFileInput): Promise<RepoFileDto> {
  const query = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
  const { data } = await client.request<ContentsApiResponse | ContentsApiResponse[]>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeRepoPath(input.path)}${query}`,
    { method: "GET", op: "repo.getFile", ref: `${input.owner}/${input.repo}/${input.path}` },
  );
  if (Array.isArray(data)) throw ApiError.validation("指定パスはディレクトリです");
  return toRepoFileDto(data);
}

function encodeRepoPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function assertPushableSize(content: string, path: string): void {
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > GITHUB_MAX_FILE_BYTES) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, `${path} が GitHub の 100MB 上限を超えています`);
  }
  if (bytes > GITHUB_CONTENTS_API_MAX_BYTES) {
    throw new ApiError(
      413,
      ErrorCode.PAYLOAD_TOO_LARGE,
      `${path} が Contents API の実用上限（1MB）を超えています`,
    );
  }
}

export async function pushToRepo(client: GithubClient, input: PushToRepoInput): Promise<PushToRepoResult> {
  assertPushableSize(input.content, input.path);
  const body = {
    message: input.message,
    content: bytesToBase64(new TextEncoder().encode(input.content)),
    ...(input.sha ? { sha: input.sha } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
  const { data } = await client.request<ContentsWriteResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeRepoPath(input.path)}`,
    {
      method: "PUT",
      op: "repo.putFile",
      ref: `${input.owner}/${input.repo}/${input.path}`,
      body,
    },
  );
  return {
    sha: data.content?.sha ?? "",
    commitSha: data.commit?.sha ?? null,
    htmlUrl: data.content?.html_url ?? null,
    rawUrl: data.content?.download_url ?? null,
  };
}

export interface DeleteRepoFileInput {
  owner: string;
  repo: string;
  path: string;
  sha: string;
  message: string;
  branch?: string;
}

export async function deleteRepoFile(client: GithubClient, input: DeleteRepoFileInput): Promise<void> {
  await client.request<undefined>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeRepoPath(input.path)}`,
    {
      method: "DELETE",
      op: "repo.deleteFile",
      ref: `${input.owner}/${input.repo}/${input.path}`,
      body: {
        message: input.message,
        sha: input.sha,
        ...(input.branch ? { branch: input.branch } : {}),
      },
    },
  );
}

interface RepoApiResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch?: string;
  permissions?: { push?: boolean } | null;
}

export async function listUserRepos(
  client: GithubClient,
  query: RepoListQuery = { page: 1, perPage: 30, sort: "updated" },
): Promise<RepoSummaryDto[]> {
  const { data } = await client.request<RepoApiResponse[]>(
    `/user/repos?per_page=${query.perPage}&page=${query.page}&sort=${query.sort}&affiliation=owner,collaborator,organization_member`,
    { method: "GET", op: "repo.list" },
  );
  return data.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch ?? "main",
    permissions: repo.permissions ? { push: repo.permissions.push === true } : null,
  }));
}

interface RateLimitResponse {
  resources: Record<string, { limit: number; remaining: number; reset: number }>;
}

export async function getRateInfo(client: GithubClient): Promise<RateInfo> {
  const { data } = await client.request<RateLimitResponse>("/rate_limit", {
    method: "GET",
    op: "rate.read",
    skipRateGuard: true,
  });
  const core = data.resources.core ?? { limit: 0, remaining: 0, reset: 0 };
  client.connection.rate = { limit: core.limit, remaining: core.remaining, reset: core.reset, resource: "core" };
  return client.connection.rate;
}

// ───────────────────────── トークン検証（OAuth / PAT 共通） ─────────────────────────

export interface GithubUserProfile {
  login: string;
  id: number;
  avatarUrl: string | null;
  scopes: string[];
  name: string | null;
}

/** トークンからユーザー情報とスコープを取得する（連携時のみ使用。監査ログにトークンは出さない）。 */
export async function fetchGithubUser(env: Env, token: string): Promise<GithubUserProfile> {
  const response = await fetch(`${baseUrlOf(env, "GITHUB_API_BASE", GITHUB_API_BASE)}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "open-clone/1.0",
    },
  });
  if (response.status === 401) {
    throw new ApiError(400, ErrorCode.VALIDATION, "GitHub トークンが無効です");
  }
  if (!response.ok) {
    throw new ApiError(502, ErrorCode.BAD_GATEWAY, `GitHub ユーザー情報の取得に失敗しました（HTTP ${response.status}）`);
  }
  const body = (await response.json()) as { login?: string; id?: number; avatar_url?: string; name?: string };
  if (!body.login || typeof body.id !== "number") {
    throw new ApiError(502, ErrorCode.BAD_GATEWAY, "GitHub の応答形式が想定と異なります");
  }
  const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
  return {
    login: body.login,
    id: body.id,
    avatarUrl: body.avatar_url ?? null,
    scopes: scopesHeader.split(",").map((scope) => scope.trim()).filter(Boolean),
    name: body.name ?? null,
  };
}

/** トークンで /rate_limit を 1 回だけ引き、残量を得る（連携直後の表示用）。 */
export async function fetchRateForToken(env: Env, token: string): Promise<GithubRate | null> {
  try {
    const response = await fetch(`${baseUrlOf(env, "GITHUB_API_BASE", GITHUB_API_BASE)}/rate_limit`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "open-clone/1.0",
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as RateLimitResponse;
    const core = body.resources.core;
    if (!core) return null;
    return { limit: core.limit, remaining: core.remaining, reset: core.reset, resource: "core" };
  } catch {
    return null;
  }
}