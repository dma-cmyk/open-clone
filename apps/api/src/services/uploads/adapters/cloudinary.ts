// Cloudinary アダプタ（代替・direct）。
// services.md §1.2: unsigned preset は誰でも使えるため **署名付きアップロード** を Worker で発行し、
// 25 credits/月 を守るため強めのレート制限（アップロード全体の上限）と併用する。
// ブラウザは Worker から受け取った署名で Cloudinary へ直送する（Worker はバイト列を中継しない）。

import {
  ApiError,
  ErrorCode,
  asBufferSource,
  toHex,
  type AttachmentMeta,
  type DirectResult,
} from "shared";
import { UPLOAD_ADAPTER_LIMITS } from "shared/schemas/upload";
import type { ServerAdapterContext, ServerUploaderAdapter } from "../types";
import { assertAllowedHost } from "../util";

const ALLOWED_HOSTS = ["res.cloudinary.com"] as const;
const MAX_BYTES = UPLOAD_ADAPTER_LIMITS.cloudinary.maxBytes;
const TYPES = UPLOAD_ADAPTER_LIMITS.cloudinary.types;

interface CloudinaryConfig {
  cloudName?: string;
  apiKey?: string;
  apiSecret?: string;
  folder?: string;
  /** API ベース（E2E スタブ差し替え用。既定 https://api.cloudinary.com） */
  apiBase: string;
  unavailableReason?: string;
}

function resolveConfig(ctx: ServerAdapterContext): CloudinaryConfig {
  const cloudName =
    (typeof ctx.config.cloudName === "string" && ctx.config.cloudName) ||
    ctx.getSecret("CLOUDINARY_CLOUD_NAME") ||
    undefined;
  const apiKey = ctx.getSecret("CLOUDINARY_API_KEY");
  const apiSecret = ctx.getSecret("CLOUDINARY_API_SECRET");
  const folder = typeof ctx.config.folder === "string" && ctx.config.folder ? ctx.config.folder : undefined;
  const apiBase = (ctx.getSecret("CLOUDINARY_API_BASE") ?? "https://api.cloudinary.com").replace(/\/+$/, "");

  const missing: string[] = [];
  if (!cloudName) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!apiKey) missing.push("CLOUDINARY_API_KEY");
  if (!apiSecret) missing.push("CLOUDINARY_API_SECRET");
  return {
    cloudName,
    apiKey,
    apiSecret,
    folder,
    apiBase,
    unavailableReason:
      missing.length > 0 ? `Cloudinary の設定（${missing.join(", ")}）が不足しています` : undefined,
  };
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", asBufferSource(new TextEncoder().encode(input)));
  return toHex(new Uint8Array(digest));
}

interface CloudinaryUploadResponse {
  secure_url?: string;
  url?: string;
  public_id?: string;
  resource_type?: string;
  format?: string;
  version?: number;
  bytes?: number;
  delete_token?: string;
}

function parseResponse(res: Response | DirectResult): CloudinaryUploadResponse {
  if (res instanceof Response) return {};
  const raw = res.response;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as CloudinaryUploadResponse;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") return raw as CloudinaryUploadResponse;
  return {};
}

export const cloudinaryAdapter: ServerUploaderAdapter = {
  id: "cloudinary",
  label: "Cloudinary（署名付き・画像/短尺動画）",
  mode: "direct",
  retentionSeconds: null,
  requiresGithub: false,
  allowedHosts: ALLOWED_HOSTS,
  limits: { maxBytes: MAX_BYTES, types: TYPES },

  isAvailable(ctx: ServerAdapterContext): boolean {
    return resolveConfig(ctx).unavailableReason === undefined;
  },

  unavailableReason(ctx: ServerAdapterContext): string {
    return resolveConfig(ctx).unavailableReason ?? "";
  },

  async prepare(_req, ctx) {
    const config = resolveConfig(ctx);
    if (!config.cloudName || !config.apiKey || !config.apiSecret) {
      throw new ApiError(
        400,
        ErrorCode.VALIDATION,
        config.unavailableReason ?? "Cloudinary が設定されていません",
      );
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const timestampString = String(timestamp);
    const params: Record<string, string> = {
      timestamp: timestampString,
      return_delete_token: "true",
    };
    if (config.folder) params.folder = config.folder;

    const toSign = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");
    const signature = await sha1Hex(`${toSign}${config.apiSecret}`);

    return {
      mode: "direct",
      url: `${config.apiBase}/v1_1/${encodeURIComponent(config.cloudName)}/auto/upload`,
      method: "POST",
      formFields: {
        api_key: config.apiKey,
        timestamp: timestampString,
        signature,
        return_delete_token: "true",
        ...(config.folder ? { folder: config.folder } : {}),
      },
      fileField: "file",
      resultType: "json",
      maxBytes: MAX_BYTES,
    };
  },

  async finalize(res: Response | DirectResult, ctx: ServerAdapterContext): Promise<AttachmentMeta> {
    const body = parseResponse(res);
    const url = body.secure_url ?? body.url;
    if (!url) throw new ApiError(502, ErrorCode.BAD_GATEWAY, "Cloudinary がファイル URL を返しませんでした");
    assertAllowedHost(url, ALLOWED_HOSTS, "Cloudinary");
    const ticket = ctx.runtime.ticket;
    if (!ticket) throw new ApiError(500, ErrorCode.INTERNAL, "アップロード情報が失われています");
    return {
      externalUrl: url,
      deleteUrl: body.delete_token ? "cloudinary:delete_by_token" : undefined,
      contentType: ticket.contentType,
      size: body.bytes ?? ticket.size,
      meta: {
        service: "cloudinary",
        publicId: body.public_id,
        resourceType: body.resource_type,
        format: body.format,
        version: body.version,
        deleteToken: body.delete_token,
      },
    };
  },

  async remove(meta: AttachmentMeta, ctx: ServerAdapterContext): Promise<void> {
    const config = resolveConfig(ctx);
    const deleteToken = meta.meta?.deleteToken;
    if (!config.cloudName || typeof deleteToken !== "string") return;
    const form = new FormData();
    form.append("token", deleteToken);
    const response = await fetch(
      `${config.apiBase}/v1_1/${encodeURIComponent(config.cloudName)}/delete_by_token`,
      { method: "POST", body: form },
    );
    if (!response.ok) {
      console.warn("CLOUDINARY_DELETE_FAILED", response.status);
    }
  },

  async verify(url: string): Promise<boolean> {
    const response = await fetch(url, { method: "HEAD" });
    if (response.status === 404 || response.status === 410) return false;
    return true;
  },
};