// 投稿パイプライン用の Turnstile 検証。
// 板設定の方針（off / anonymous / always）に応じて要求し、siteverify は Worker から行う。

import { ApiError, ErrorCode, type BoardSettings } from "shared";
import type { Env } from "../../lib/env";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** ローカル/E2E スタブ用の検証先上書き（未設定なら本番 URL）。 */
export function turnstileVerifyUrl(env: Env): string {
  const value = (env as unknown as Record<string, unknown>)["TURNSTILE_VERIFY_URL"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : VERIFY_URL;
}

interface SiteVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/** 板設定とログイン状態から Turnstile 要求が必要か。 */
export function needsTurnstile(settings: BoardSettings, hasSession: boolean): boolean {
  if (settings.turnstile === "off") return false;
  if (settings.turnstile === "always") return true;
  return !hasSession;
}

/** トークンを検証する。要求が必要なのに無い/不正なら 400 TURNSTILE_FAILED。 */
export async function assertTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
  required: boolean,
): Promise<void> {
  if (!token) {
    if (required) throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile トークンが必要です");
    return;
  }
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (env.ENVIRONMENT === "development") return;
    throw new ApiError(500, ErrorCode.MISCONFIGURED, "TURNSTILE_SECRET_KEY が設定されていません");
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const response = await fetch(turnstileVerifyUrl(env), { method: "POST", body: form });
  if (!response.ok) throw new ApiError(502, ErrorCode.BAD_GATEWAY, "Turnstile 検証に失敗しました");
  const result = (await response.json()) as SiteVerifyResponse;
  if (!result.success) {
    throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile 検証に失敗しました", result["error-codes"]);
  }
}