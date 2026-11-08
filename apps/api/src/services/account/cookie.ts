// セッション Cookie の設定/削除（auth・invites・admin で共通）。

import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { SESSION_COOKIE, SESSION_TTL_DAYS } from "shared";
import type { AppEnv } from "../../lib/env";

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 86_400,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}