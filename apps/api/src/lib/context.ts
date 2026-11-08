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
  ulid,
  type AppRequestContext,
  type AuthAccount,
} from "shared";
import type { AppEnv } from "./env";

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

  const raw = c.req.raw;
  const ip =
    raw.headers.get("cf-connecting-ip") ??
    raw.headers.get("x-real-ip") ??
    raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "127.0.0.1";
  const ipHash = await hmacSha256Hex(env.ID_SALT, `ip:${ip}`);

  // --- セッション ---
  let session: AppRequestContext["session"] = null;
  const sessionToken = getCookie(c, SESSION_COOKIE);
  if (sessionToken) {
    const tokenHash = await sha256Hex(sessionToken);
    const row = await env.DB.prepare(
      `SELECT s.token_hash, s.expires_at, a.id, a.name, a.email, a.role, a.status
       FROM sessions s JOIN accounts a ON a.id = s.account_id
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
      }>();
    if (row) {
      session = {
        tokenHash,
        expiresAt: row.expires_at,
        account: {
          id: row.id,
          name: row.name,
          email: row.email,
          role: row.role,
          status: row.status,
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
