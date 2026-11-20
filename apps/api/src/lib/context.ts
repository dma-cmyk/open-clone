// リクエストコンテキスト生成ミドルウェア。
// device（oc_did Cookie + device_hash）→ session（oc_sess）の順で構築し `reqCtx` に格納する。

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import {
  DEVICE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  hmacSha256Hex,
  randomHex,
  sha256Hex,
  timingSafeEqual,
  ulid,
  type AppRequestContext,
  type AuthAccount,
} from "shared";
import type { AppEnv } from "./env";

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(part));
}

function isValidIpv6(value: string): boolean {
  if (value.length < 2 || value.length > 45 || !value.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  const parts = value.split("::");
  if (parts.length > 2) return false;
  const hasCompression = parts.length === 2;
  const left = parts[0] === "" ? [] : parts[0]!.split(":");
  const right = hasCompression && parts[1] !== "" ? parts[1]!.split(":") : [];
  const checkGroups = (groups: string[], allowIpv4Tail: boolean): number | null => {
    let count = 0;
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i]!;
      if (allowIpv4Tail && i === groups.length - 1 && group.includes(".")) {
        if (!isValidIpv4(group)) return null;
        count += 2;
      } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
        count += 1;
      } else {
        return null;
      }
    }
    return count;
  };
  const leftCount = checkGroups(left, !hasCompression);
  const rightCount = checkGroups(right, hasCompression);
  if (leftCount === null || rightCount === null) return false;
  const total = leftCount + rightCount;
  return hasCompression ? total < 8 : total === 8;
}

function isValidIp(value: string): boolean {
  return isValidIpv4(value) || isValidIpv6(value);
}

/**
 * 信頼された境界プロキシ（Vercel rewrites）から正しい `x-oc-edge-secret` 付きで届いた場合のみ
 * `x-forwarded-for` の先頭を利用者の IP として採用し、形式不正や秘密不一致時は `cf-connecting-ip` へ戻す。
 * `x-real-ip` は Cloudflare Workers 上で Cloudflare が接続元（Vercel 中継サーバー）の IP で上書きするため信頼判定には使わない。
 */
function resolveClientIp(raw: Request, env: AppEnv["Bindings"]): string {
  const edgeSecret = env.EDGE_PROXY_SECRET;
  const providedSecret = raw.headers.get("x-oc-edge-secret");
  const trustedProxy =
    typeof edgeSecret === "string" &&
    edgeSecret.trim().length > 0 &&
    typeof providedSecret === "string" &&
    providedSecret.length > 0 &&
    timingSafeEqual(providedSecret, edgeSecret);

  const forwardedFirst = raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  if (trustedProxy && forwardedFirst && isValidIp(forwardedFirst)) {
    return forwardedFirst;
  }

  const cfIp = raw.headers.get("cf-connecting-ip")?.trim() || undefined;
  if (cfIp) return cfIp;

  if (env.ENVIRONMENT === "development" && !trustedProxy) {
    const realIp = raw.headers.get("x-real-ip")?.trim() || undefined;
    if (realIp) return realIp;
    if (forwardedFirst) return forwardedFirst;
  }
  return "127.0.0.1";
}

/** セッションのスライディング更新を行うか（残り半分を切ったら更新） */
function shouldTouchSession(expiresAt: number, now: number): boolean {
  return expiresAt - now < (SESSION_TTL_DAYS * 86_400) / 2;
}

export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const env = c.env;
  const now = Math.floor(Date.now() / 1000);

  // --- 端末識別 ---
  let deviceId = getCookie(c, DEVICE_COOKIE);
  if (!deviceId || !/^[0-9a-f]{32}$/.test(deviceId)) {
    deviceId = randomHex(16);
    setCookie(c, DEVICE_COOKIE, deviceId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 365 * 86_400,
    });
  }
  const deviceHash = await hmacSha256Hex(env.ID_SALT, `device:${deviceId}`);

  const ip = resolveClientIp(c.req.raw, env);
  const ipHash = await hmacSha256Hex(env.ID_SALT, `ip:${ip}`);

  // --- セッション ---
  let session: AppRequestContext["session"] = null;
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (sessionToken) {
    const tokenHash = await sha256Hex(sessionToken);
    const row = await env.DB.prepare(
      `SELECT s.token_hash, s.expires_at, a.id, a.name, a.email, a.role, a.status,
              sa.stopped_at AS special_admin_stopped_at
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN special_admin_state sa ON sa.account_id = a.id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
      .bind(tokenHash, now)
      .first<{
        token_hash: string;
        expires_at: number;
        id: string;
        name: string;
        email: string | null;
        role: AuthAccount["role"];
        status: AuthAccount["status"];
        special_admin_stopped_at: number | null;
      }>();
    if (row) {
      const specialAdminStopped =
        row.role === "special_admin" && row.special_admin_stopped_at !== null;
      session = {
        tokenHash,
        expiresAt: row.expires_at,
        account: {
          id: row.id,
          name: row.name,
          email: row.email,
          // 停止中の特別管理人は入口で権限を外し、全認可判定で一般利用者相当として扱う（F3）。
          // 表示用（/auth/session・/accounts/me）と /admin の 403 reason 維持のためフラグだけ残す。
          role: specialAdminStopped ? "user" : row.role,
          status: row.status,
          ...(specialAdminStopped ? { specialAdminStopped: true } : {}),
        },
      };
      if (shouldTouchSession(row.expires_at, now)) {
        c.executionCtx.waitUntil(
          env.DB.prepare("UPDATE sessions SET expires_at = ?, touched_at = ? WHERE token_hash = ?")
            .bind(now + SESSION_TTL_DAYS * 86_400, now, tokenHash)
            .run(),
        );
      }
    }
  }

  c.set("reqCtx", {
    requestId: ulid(),
    device: { deviceId, deviceHash, ip, ipHash },
    session,
  });
  await next();
});

/** 現在のリクエストコンテキストを取得する（context ミドルウェア以降でのみ有効）。 */
export function getReqCtx(c: { get(key: "reqCtx"): AppRequestContext }): AppRequestContext {
  return c.get("reqCtx");
}
