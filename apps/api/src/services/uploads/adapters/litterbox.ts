// Litterbox（一時ファイル）アダプタ。DESIGN §9.1 / services.md §1.2。
// CORS `*` を返すためブラウザ直送（direct）。保持は 1h/12h/24h/72h のみで恒久保存には使わない。

import { ApiError, type AttachmentMeta, type DirectResult } from "shared";
import { UPLOAD_ADAPTER_LIMITS } from "shared/schemas/upload";
import type { ServerAdapterContext, ServerUploaderAdapter } from "../types";
import { assertAllowedHost, extractFirstUrl } from "../util";

const UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php";
const ALLOWED_HOSTS = ["litterbox.catbox.moe"] as const;
const MAX_BYTES = UPLOAD_ADAPTER_LIMITS.litterbox.maxBytes;
const TYPES = UPLOAD_ADAPTER_LIMITS.litterbox.types;
const RETENTION_SECONDS: Record<string, number> = {
  "1h": 3600,
  "12h": 12 * 3600,
  "24h": 24 * 3600,
  "72h": 72 * 3600,
};

function retentionOf(ctx: ServerAdapterContext): { time: string; seconds: number } {
  const configured = ctx.config.time;
  const time = typeof configured === "string" && configured in RETENTION_SECONDS ? configured : "72h";
  return { time, seconds: RETENTION_SECONDS[time]! };
}

function responseText(response: DirectResult): string {
  const raw = response.response;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["url", "text", "result"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return "";
}

export const litterboxAdapter: ServerUploaderAdapter = {
  id: "litterbox",
  label: "Litterbox（一時ファイル・最大72時間）",
  mode: "direct",
  retentionSeconds: 72 * 3600,
  requiresGithub: false,
  allowedHosts: ALLOWED_HOSTS,
  limits: { maxBytes: MAX_BYTES, types: TYPES },

  async prepare(_req, ctx) {
    const { time } = retentionOf(ctx);
    return {
      mode: "direct",
      url: ctx.getSecret("LITTERBOX_API_URL") ?? UPLOAD_URL,
      method: "POST",
      formFields: { reqtype: "fileupload", time },
      fileField: "fileToUpload",
      resultType: "text",
      maxBytes: MAX_BYTES,
    };
  },

  isAvailable() {
    return true;
  },

  async finalize(res: Response | DirectResult, ctx: ServerAdapterContext): Promise<AttachmentMeta> {
    const text = res instanceof Response ? await res.text() : responseText(res);
    const url = extractFirstUrl(text);
    if (!url) throw new ApiError(502, "BAD_GATEWAY", "Litterbox がファイル URL を返しませんでした");
    assertAllowedHost(url, ALLOWED_HOSTS, "Litterbox");
    const ticket = ctx.runtime.ticket;
    if (!ticket) throw new ApiError(500, "INTERNAL", "アップロード情報が失われています");
    const { seconds } = retentionOf(ctx);
    return {
      externalUrl: url,
      contentType: ticket.contentType,
      size: ticket.size,
      meta: { service: "litterbox", retentionSeconds: seconds },
    };
  },

  async verify(url: string): Promise<boolean> {
    const response = await fetch(url, { method: "HEAD" });
    if (response.status === 404 || response.status === 410) return false;
    return true;
  },
};