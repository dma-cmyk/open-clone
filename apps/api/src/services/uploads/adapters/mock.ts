// モックアダプタ（ローカル/E2E/テスト用）。
// 外部へ一切送信せず、予測可能な URL を返す。D1 には URL とメタだけが入る（本体は保存しない）。

import { ulid, type AttachmentMeta, type UploadRequest } from "shared";
import { UPLOAD_ADAPTER_LIMITS } from "shared/schemas/upload";
import type { ServerAdapterContext, ServerUploaderAdapter } from "../types";

const DEFAULT_BASE_URL = "https://mock.uploads.local";
const MAX_BYTES = UPLOAD_ADAPTER_LIMITS.mock.maxBytes;

function baseUrlOf(ctx: ServerAdapterContext): string {
  const configured = ctx.config.baseUrl;
  if (typeof configured === "string" && configured.length > 0) {
    return configured.replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "mock.uploads.local";
  }
}

export const mockAdapter: ServerUploaderAdapter = {
  id: "mock",
  label: "モック（ローカル/テスト専用）",
  mode: "proxy-stream",
  retentionSeconds: null,
  requiresGithub: false,
  allowedHosts: ["mock.uploads.local"],
  limits: { maxBytes: MAX_BYTES, types: UPLOAD_ADAPTER_LIMITS.mock.types },

  async prepare() {
    return { mode: "proxy-stream", proxyPath: "/v1/uploads/proxy", maxBytes: MAX_BYTES };
  },

  isAvailable() {
    return true;
  },

  allowedHostsFor(ctx: ServerAdapterContext): readonly string[] {
    return [hostOf(baseUrlOf(ctx))];
  },

  async handleProxy(_request: Request, req: UploadRequest, ctx: ServerAdapterContext): Promise<AttachmentMeta> {
    const base = baseUrlOf(ctx);
    const ticketId = ctx.runtime.ticket?.id ?? ulid();
    const filename = encodeURIComponent(req.filename);
    return {
      externalUrl: `${base}/${ticketId}/${filename}`,
      contentType: req.contentType,
      size: req.size,
      meta: { service: "mock", roles: ["test"] },
    };
  },

  async verify(): Promise<boolean> {
    // ローカルのダミーホストは確認不能なので常に生存扱い（cron で誤検知させない）
    return true;
  },
};