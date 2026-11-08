// Catbox アダプタ（既定）。DESIGN §9.1 / services.md §1.2。
// Catbox は CORS を返さず Referer なしで 412 になるため、必ず Worker がストリーム中継する。
// 本体はメモリに溜めず、multipart の境界をストリーム連結して転送するだけ（Cloudflare に保存しない）。

import { ApiError, type AttachmentMeta, type DirectResult, type UploadRequest } from "shared";
import { UPLOAD_ADAPTER_LIMITS } from "shared/schemas/upload";
import type { ServerAdapterContext, ServerUploaderAdapter, UpstreamTarget } from "../types";
import { assertAllowedHost, extractFirstUrl } from "../util";

const UPLOAD_URL = "https://catbox.moe/user/api.php";
const ALLOWED_HOSTS = ["files.catbox.moe"] as const;
const MAX_BYTES = UPLOAD_ADAPTER_LIMITS.catbox.maxBytes;
const TYPES = UPLOAD_ADAPTER_LIMITS.catbox.types;

/**
 * 許可ホスト。`CATBOX_API_URL` を差し替えている環境（ローカル E2E スタブ等）では
 * そのホストも受け入れる。未設定なら実 Catbox のみ。
 */
export function catboxAllowedHosts(ctx: ServerAdapterContext): readonly string[] {
  const override = ctx.getSecret("CATBOX_API_URL");
  if (!override) return ALLOWED_HOSTS;
  try {
    return [...ALLOWED_HOSTS, new URL(override).hostname];
  } catch {
    return ALLOWED_HOSTS;
  }
}

function responseText(response: Response | DirectResult): string {
  if (response instanceof Response) return ""; // Response は呼び出し側で text() 済みの値を使う
  const raw = response.response;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["url", "text", "result"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

export const catboxAdapter: ServerUploaderAdapter = {
  id: "catbox",
  label: "Catbox（既定・画像/動画/テキスト）",
  mode: "proxy-stream",
  retentionSeconds: null,
  requiresGithub: false,
  allowedHosts: ALLOWED_HOSTS,
  allowedHostsFor: catboxAllowedHosts,
  limits: { maxBytes: MAX_BYTES, types: TYPES },

  async prepare() {
    return { mode: "proxy-stream", proxyPath: "/v1/uploads/proxy", maxBytes: MAX_BYTES };
  },

  isAvailable() {
    return true;
  },

  upstream(req: UploadRequest, ctx: ServerAdapterContext): UpstreamTarget {
    const userhash = ctx.getSecret("CATBOX_USERHASH");
    const fields: Record<string, string> = { reqtype: "fileupload" };
    if (userhash) fields.userhash = userhash;
    return {
      url: ctx.getSecret("CATBOX_API_URL") ?? UPLOAD_URL,
      method: "POST",
      headers: {
        // services.md §1.3 実測: Referer / ブラウザ UA なしは 412
        Referer: "https://catbox.moe/",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      },
      multipart: {
        fields,
        fileField: "fileToUpload",
        filename: req.filename,
        contentType: req.contentType,
      },
    };
  },

  async finalize(res: Response | DirectResult, ctx: ServerAdapterContext): Promise<AttachmentMeta> {
    const text = res instanceof Response ? await res.text() : responseText(res);
    const url = extractFirstUrl(text);
    if (!url) {
      throw new ApiError(502, "BAD_GATEWAY", "Catbox がファイル URL を返しませんでした");
    }
    assertAllowedHost(url, catboxAllowedHosts(ctx), "Catbox");
    const ticket = ctx.runtime.ticket;
    if (!ticket) throw new ApiError(500, "INTERNAL", "アップロード情報が失われています");
    return {
      externalUrl: url,
      contentType: ticket.contentType,
      size: ticket.size,
      meta: { service: "catbox", anonymous: !ctx.getSecret("CATBOX_USERHASH") },
    };
  },

  async verify(url: string): Promise<boolean> {
    const response = await fetch(url, {
      method: "HEAD",
      headers: { Referer: "https://catbox.moe/", "User-Agent": "open-clone-linkcheck/1.0" },
    });
    // 5xx は「不明」として生存扱い（一時障害で添付を消さない）
    if (response.status === 404 || response.status === 410) return false;
    return true;
  },
};