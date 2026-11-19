// サーバー側 fetch の宛先検証（SSRF 防止）。plugin-net と AI Webhook で共通利用する（H-2）。
//
// 方針:
// - https のみ・ポート 443 のみ・userinfo 禁止
// - ローカル/プライベート/リンクローカル/メタデータ/内部 TLD を拒否
// - 単一ラベルのホスト名（`https://intranet/` 等）を拒否
// - DNS 解決後の IP は Workers の fetch API では取得できないため、ホスト名と URL 正規化に依存する。
//   呼び出し側は必ず `redirect: "manual"` でリダイレクトを追わないこと（追うと検証を迂回できる）。

import { ApiError } from "shared";

/** 内部・メタデータ・ローカル向けの IPv4 レンジ。 */
const PRIVATE_IPV4_PATTERNS: readonly RegExp[] = [
  /^0\./,
  /^10\./,
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
  /^127\./,
  /^169\.254\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^192\.168\./,
  /^198\.(?:18|19)\./, // 198.18.0.0/15 benchmark
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^22[4-9]\./, // multicast
  /^2[3-5]\d\./,
];

/** 内部向けホスト名（大文字小文字を無視）。 */
const PRIVATE_HOSTNAME_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.home\.arpa$/i,
  /^metadata(?:\.|$)/i,
];

/** IPv6 に埋め込まれた 2 つの 16bit グループを IPv4 のドット表記にする。 */
function embeddedIpv4(highHex: string, lowHex: string): string {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

// 埋め込み IPv4 はドット形式（::ffff:127.0.0.1）と 16 進 2 グループ（::ffff:7f00:1）の両方で来る。
// WHATWG URL は後者へ正規化するため、片方だけを見ると私設 IPv4 がすり抜ける。
const IPV4_MAPPED_IPV6_RE = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/;
const IPV4_COMPATIBLE_IPV6_RE = /^::(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/;
const NAT64_IPV6_RE = /^64:ff9b::(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/;

/** 埋め込み IPv4 の一致結果を検査する（1 = ドット形式、2/3 = 16 進 2 グループ）。 */
function embeddedIpv4IsPrivate(match: RegExpExecArray): boolean {
  if (match[1]) return isPrivateIpv4(match[1]);
  return isPrivateIpv4(embeddedIpv4(match[2]!, match[3]!));
}

/** IPv6 のループバック・リンクローカル・ULA・未指定・埋め込み IPv4 を判定する（ブラケットは除去済み）。 */
function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7
  // IPv4-mapped（::ffff:127.0.0.1 / ::ffff:7f00:1）
  const mapped = IPV4_MAPPED_IPV6_RE.exec(normalized);
  if (mapped) return embeddedIpv4IsPrivate(mapped);
  // IPv4-compatible（::127.0.0.1 / ::7f00:1）。::1 と :: は上で除外済み。
  const compatible = IPV4_COMPATIBLE_IPV6_RE.exec(normalized);
  if (compatible) return embeddedIpv4IsPrivate(compatible);
  // NAT64 well-known prefix（64:ff9b::/96）
  const nat64 = NAT64_IPV6_RE.exec(normalized);
  if (nat64) return embeddedIpv4IsPrivate(nat64);
  return false;
}

export function isPrivateIpv4(host: string): boolean {
  return PRIVATE_IPV4_PATTERNS.some((pattern) => pattern.test(host));
}

/** ホスト名が内部・ローカル・メタデータ向けなら true。 */
export function isPrivateHostname(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host.length === 0) return true;
  if (PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(host))) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  // 単一ラベル（ドットなし）は内部ホスト名とみなす。
  if (!host.includes(".")) return true;
  return false;
}

export interface PublicUrlOptions {
  /** 許可するオリジンの完全一致リスト（指定時は必須）。 */
  allowlist?: readonly string[];
}

/**
 * 外部へ fetch してよい URL かを検証して返す。違反時は ApiError を投げる。
 * plugin-net の `assertAllowedTarget` と Webhook 登録・配信の共通実装。
 */
export function assertPublicHttpsUrl(rawUrl: string, options: PublicUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw ApiError.validation("URL が不正です");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "VALIDATION", "https の URL のみ許可されています");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "VALIDATION", "URL に認証情報を含めることはできません");
  }
  if (url.port && url.port !== "443") {
    throw ApiError.forbidden("ポート 443 以外への接続は禁止されています");
  }
  if (isPrivateHostname(url.hostname)) {
    throw ApiError.forbidden("内部アドレスへのアクセスは禁止されています");
  }
  if (options.allowlist) {
    const allowed = options.allowlist.some((entry) => {
      try {
        return new URL(entry).origin === url.origin;
      } catch {
        return false;
      }
    });
    if (!allowed) {
      throw ApiError.forbidden(`許可されていないオリジンです: ${url.origin}`);
    }
  }
  return url;
}