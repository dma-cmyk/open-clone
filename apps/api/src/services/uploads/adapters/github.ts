// GitHub リポジトリ・アダプタ（連携ユーザーのリポジトリへコミット）。
// GitHub はメディア保存先ではない（services.md §2）ため既定にしない。1MB 以下のテキスト限定。
// Contents API は base64 送信のため実用上限 1MB（100MB はハード上限）。

import {
  ApiError,
  ErrorCode,
  ulid,
  type AttachmentMeta,
  type UploadRequest,
} from "shared";
import { UPLOAD_ADAPTER_LIMITS } from "shared/schemas/upload";
import { GITHUB_CONTENTS_API_MAX_BYTES } from "shared/schemas/github";
import type { ServerAdapterContext, ServerUploaderAdapter } from "../types";
import { GithubClient, githubLinkRequiredError, pushToRepo } from "../../github/service";
import { sanitizeGistFilename } from "./gist";

const ALLOWED_HOSTS = ["raw.githubusercontent.com", "github.com"] as const;
const MAX_BYTES = Math.min(UPLOAD_ADAPTER_LIMITS.github.maxBytes, GITHUB_CONTENTS_API_MAX_BYTES);
const TYPES = UPLOAD_ADAPTER_LIMITS.github.types;

interface RepoAdapterConfig {
  owner: string;
  repo: string;
  branch?: string;
  pathPrefix: string;
}

function resolveConfig(ctx: ServerAdapterContext): RepoAdapterConfig | null {
  const owner = typeof ctx.config.owner === "string" ? ctx.config.owner : undefined;
  const repo = typeof ctx.config.repo === "string" ? ctx.config.repo : undefined;
  if (!owner || !repo) return null;
  const branch = typeof ctx.config.branch === "string" && ctx.config.branch ? ctx.config.branch : undefined;
  const rawPrefix = typeof ctx.config.pathPrefix === "string" ? ctx.config.pathPrefix : "attachments/";
  const pathPrefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
  return { owner, repo, branch, pathPrefix };
}

async function readTextBody(request: Request, maxBytes: number): Promise<string> {
  const buffer = new Uint8Array(await request.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "リポジトリ添付は 1MB までです");
  }
  if (buffer.byteLength === 0) throw ApiError.validation("空のファイルは保存できません");
  if (buffer.includes(0)) throw ApiError.validation("リポジトリ添付にはテキストファイルのみ保存できます");
  return new TextDecoder().decode(buffer);
}

export const githubRepoAdapter: ServerUploaderAdapter = {
  id: "github",
  label: "GitHub リポジトリ（テキスト/コード・要連携）",
  mode: "proxy-stream",
  retentionSeconds: null,
  requiresGithub: true,
  allowedHosts: ALLOWED_HOSTS,
  limits: { maxBytes: MAX_BYTES, types: TYPES },

  async prepare() {
    return { mode: "proxy-stream", proxyPath: "/v1/uploads/proxy", maxBytes: MAX_BYTES };
  },

  isAvailable(ctx: ServerAdapterContext): boolean {
    return Boolean(ctx.runtime.github) && resolveConfig(ctx) !== null;
  },

  unavailableReason(ctx: ServerAdapterContext): string {
    if (!ctx.runtime.github) return "GitHub 連携が必要です";
    if (!resolveConfig(ctx)) return "保存先リポジトリ（owner / repo）が設定されていません";
    return "";
  },

  async handleProxy(request: Request, req: UploadRequest, ctx: ServerAdapterContext): Promise<AttachmentMeta> {
    const connection = ctx.runtime.github;
    if (!connection) throw githubLinkRequiredError();
    const config = resolveConfig(ctx);
    if (!config) {
      throw new ApiError(400, ErrorCode.VALIDATION, "保存先リポジトリ（owner / repo）が設定されていません");
    }
    const content = await readTextBody(request, MAX_BYTES);
    const safeName = sanitizeGistFilename(req.filename).replace(/[^\w.-]+/g, "_");
    const path = `${config.pathPrefix}${ulid()}-${safeName}`;
    const client = new GithubClient(ctx.runtime.env, connection);
    const result = await pushToRepo(client, {
      owner: config.owner,
      repo: config.repo,
      path,
      content,
      message: `Add attachment: ${safeName}`,
      branch: config.branch,
    });
    const branch = config.branch ?? "main";
    const externalUrl =
      result.rawUrl ??
      `https://raw.githubusercontent.com/${config.owner}/${config.repo}/${encodeURIComponent(branch)}/${path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;
    return {
      externalUrl,
      contentType: req.contentType,
      size: new TextEncoder().encode(content).byteLength,
      meta: {
        service: "github",
        owner: config.owner,
        repo: config.repo,
        path,
        branch,
        htmlUrl: result.htmlUrl,
        sha: result.sha,
      },
    };
  },

  async verify(url: string): Promise<boolean> {
    const response = await fetch(url, { method: "HEAD" });
    if (response.status === 404 || response.status === 410) return false;
    return true;
  },
};