// Gist アダプタ（テキスト/コード。連携ユーザーの Gist へ保存）。
// Gist 作成には `gist` スコープのトークンが必要で、ブラウザにトークンを出せないため
// Worker が本文（1MB 以下のテキスト）を受け取って GitHub API へ転送する（保存はしない）。

import { ApiError, ErrorCode, type AttachmentMeta, type UploadRequest } from "shared";
import { UPLOAD_ADAPTER_LIMITS } from "shared/schemas/upload";
import { GIST_MAX_FILE_BYTES } from "shared/schemas/github";
import type { ServerAdapterContext, ServerUploaderAdapter } from "../types";
import { GithubClient, createGist, githubLinkRequiredError } from "../../github/service";

const MAX_BYTES = Math.min(UPLOAD_ADAPTER_LIMITS.gist.maxBytes, GIST_MAX_FILE_BYTES);
const ALLOWED_HOSTS = ["gist.githubusercontent.com", "gist.github.com"] as const;
const TYPES = UPLOAD_ADAPTER_LIMITS.gist.types;

/** Gist のファイル名に使えない文字を落とす（パス区切り・制御文字など）。 */
export function sanitizeGistFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "attachment.txt";
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const safe = cleaned.length > 0 ? cleaned : "attachment.txt";
  return safe.length > 100 ? safe.slice(-100) : safe;
}

async function readTextBody(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "Gist のファイルサイズ上限（1MB）を超えています");
  }
  const buffer = new Uint8Array(await request.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "Gist のファイルサイズ上限（1MB）を超えています");
  }
  if (buffer.byteLength === 0) throw ApiError.validation("空のファイルは保存できません");
  if (buffer.includes(0)) {
    throw ApiError.validation("Gist にはテキストファイルのみ保存できます");
  }
  return new TextDecoder().decode(buffer);
}

export const gistAdapter: ServerUploaderAdapter = {
  id: "gist",
  label: "GitHub Gist（テキスト/コード・要連携）",
  mode: "proxy-stream",
  retentionSeconds: null,
  requiresGithub: true,
  allowedHosts: ALLOWED_HOSTS,
  limits: { maxBytes: MAX_BYTES, types: TYPES },

  async prepare() {
    return { mode: "proxy-stream", proxyPath: "/v1/uploads/proxy", maxBytes: MAX_BYTES };
  },

  isAvailable(ctx: ServerAdapterContext): boolean {
    return Boolean(ctx.runtime.github);
  },

  unavailableReason() {
    return "GitHub 連携が必要です";
  },

  async handleProxy(request: Request, req: UploadRequest, ctx: ServerAdapterContext): Promise<AttachmentMeta> {
    const connection = ctx.runtime.github;
    if (!connection) throw githubLinkRequiredError();
    const content = await readTextBody(request, MAX_BYTES);
    const filename = sanitizeGistFilename(req.filename);
    const client = new GithubClient(ctx.runtime.env, connection);
    const gist = await createGist(client, {
      description: `おーぷんクローン添付: ${filename}`,
      public: false,
      files: { [filename]: { content } },
    });
    const externalUrl = gist.rawUrl ?? gist.htmlUrl;
    return {
      externalUrl,
      contentType: req.contentType,
      size: new TextEncoder().encode(content).byteLength,
      meta: {
        service: "gist",
        gistId: gist.id,
        htmlUrl: gist.htmlUrl,
        filename,
        public: gist.public,
      },
    };
  },

  async verify(url: string): Promise<boolean> {
    const response = await fetch(url, { method: "HEAD" });
    if (response.status === 404 || response.status === 410) return false;
    return true;
  },
};
