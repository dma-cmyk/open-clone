// sandbox の net:fetch プロキシ（DESIGN §7.1 / §7.2）。
// プラグイン iframe は CSP で直接通信できないため、ホスト経由でこのプロキシだけが外部へ出る。
// 許可: manifest.connectAllowlist のオリジン（https のみ）・SSRF 防止・全呼び出し監査・レート制限。

import { ApiError, ulid, type PluginNetFetchInput, type PluginNetFetchResult } from "shared";
import { assertPublicHttpsUrl } from "../../lib/url-safety";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const RATE_WINDOW_SECONDS = 60;
const RATE_MAX_PER_WINDOW = 60;

/** 転送してよいリクエストヘッダ（Cookie/Authorization は絶対に転送しない）。 */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "accept-language"] as const;

/** 返してよいレスポンスヘッダ。 */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "etag", "last-modified", "location"] as const;

export interface NetCaller {
  accountId: string | null;
  deviceHash: string;
  installId: string | null;
}

/** URL を検証し、許可オリジン・https・非内部アドレスであることを強制する。 */
export function assertAllowedTarget(rawUrl: string, allowlist: readonly string[]): URL {
  return assertPublicHttpsUrl(rawUrl, { allowlist });
}

/** 呼び出し元のレート制限（60 回/分）。 */
export async function assertNetRateLimit(db: D1Database, caller: NetCaller): Promise<void> {
  const since = Math.floor(Date.now() / 1000) - RATE_WINDOW_SECONDS;
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM plugin_net_log WHERE device_hash = ? AND created_at > ?")
    .bind(caller.deviceHash, since)
    .first<{ count: number }>();
  if ((row?.count ?? 0) >= RATE_MAX_PER_WINDOW) {
    throw ApiError.rateLimited("プラグインの外部通信が多すぎます。しばらく待ってください");
  }
}

export interface NetLogEntry {
  pluginId: string | null;
  version: string | null;
  installId: string | null;
  scope: string | null;
  caller: NetCaller;
  url: string;
  method: string;
  status: number | null;
  bytes: number | null;
  allowed: boolean;
  reason: string | null;
}

/** 監査ログ（許可・拒否の両方を記録する）。 */
export async function logNetAttempt(db: D1Database, entry: NetLogEntry): Promise<void> {
  let host = "";
  // 監査ログには query/fragment を残さない（API キー等が URL に載るケースの漏洩防止 / L-3）。
  let urlForLog = entry.url;
  try {
    const parsed = new URL(entry.url);
    host = parsed.hostname;
    parsed.search = "";
    parsed.hash = "";
    urlForLog = parsed.toString();
  } catch {
    host = "";
  }
  await db
    .prepare(
      `INSERT INTO plugin_net_log
         (id, plugin_id, version, install_id, scope, account_id, device_hash, url, host, method, status, bytes, allowed, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ulid(),
      entry.pluginId,
      entry.version,
      entry.installId,
      entry.scope,
      entry.caller.accountId,
      entry.caller.deviceHash,
      urlForLog.slice(0, 2000),
      host,
      entry.method,
      entry.status,
      entry.bytes,
      entry.allowed ? 1 : 0,
      entry.reason,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

function isTextual(contentType: string): boolean {
  return /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)|image\/svg\+xml)/i.test(
    contentType,
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** プロキシ本体。検証済み URL へ fetch し、サイズ上限付きで返す。 */
export async function proxyFetch(
  input: PluginNetFetchInput,
  allowlist: readonly string[],
): Promise<PluginNetFetchResult> {
  const url = assertAllowedTarget(input.url, allowlist);

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = input.headers?.[name];
    if (value) headers.set(name, value);
  }
  headers.set("user-agent", "open-clone-plugin-proxy/1.0");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url.toString(), {
      method: input.method,
      headers,
      body: input.method === "GET" || input.method === "HEAD" ? undefined : input.body,
      redirect: "manual",
      signal: controller.signal,
    });

    const responseHeaders: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;

    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = MAX_RESPONSE_BYTES - received;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          received += remaining;
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        received += value.byteLength;
      }
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const textual = isTextual(contentType);
    return {
      status: response.status,
      headers: responseHeaders,
      body: textual ? new TextDecoder().decode(bytes) : toBase64(bytes),
      bodyEncoding: textual ? "text" : "base64",
      truncated,
      url: url.toString(),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError(504, "BAD_GATEWAY", "外部通信がタイムアウトしました");
    }
    throw new ApiError(502, "BAD_GATEWAY", "外部通信に失敗しました", {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}