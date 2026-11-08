// Turnstile 検証。siteverify は必ず Worker から行い、クライアントに secret を出さない。
// ローカルは公式テストキー（`TURNSTILE_TEST_KEYS`）で動作する。

import { createMiddleware } from "hono/factory";
import { ApiError, ErrorCode } from "shared";
import type { AppEnv } from "../env";
import type { AppMiddleware } from "./auth";

const DEFAULT_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * E2E 用の上書き（`TURNSTILE_VERIFY_URL`）。未設定なら本物の siteverify を叩く。
 * `lib/env.ts` の Env 型に含まれないため、ここでは optional binding として読む
 * （Env に追加されれば交差型はそのまま成立する）。
 */
type TurnstileBindings = AppEnv["Bindings"] & { TURNSTILE_VERIFY_URL?: string };

function verifyUrlOf(env: AppEnv["Bindings"]): string {
  const bindings: TurnstileBindings = env;
  return bindings.TURNSTILE_VERIFY_URL ?? DEFAULT_VERIFY_URL;
}

interface SiteVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
}

/**
 * リクエストボディ `cf-turnstile-response` またはヘッダ `x-turnstile-token` を検証する。
 * `required` が false の場合はトークンが存在する時のみ検証（異常検知後の段階的要求用）。
 */
export function requireTurnstile(options: {
  required?: boolean;
  ip?: string;
} = {}): AppMiddleware {
  const required = options.required ?? true;
  return createMiddleware<AppEnv>(async (c, next) => {
    const secret = c.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
      if (c.env.ENVIRONMENT === "development" && !required) {
        await next();
        return;
      }
      throw new ApiError(500, ErrorCode.MISCONFIGURED, "TURNSTILE_SECRET_KEY が設定されていません");
    }

    let token: string | undefined = c.req.header("x-turnstile-token");
    if (!token) {
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = (await c.req.json().catch(() => null)) as { "cf-turnstile-response"?: string } | null;
        token = body?.["cf-turnstile-response"];
      } else if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
        const form = await c.req.formData().catch(() => null);
        const value = form?.get("cf-turnstile-response");
        if (typeof value === "string") token = value;
      }
    }

    if (!token) {
      if (required) throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile トークンが必要です");
      await next();
      return;
    }

    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (options.ip) form.append("remoteip", options.ip);

    // subrequest は Cloudflare quotas に含まれる。無料枠節約のため、同一リクエスト内で重複検証しない。
    if (c.get("turnstileVerified" as never) === true) {
      await next();
      return;
    }

    const response = await fetch(verifyUrlOf(c.env), { method: "POST", body: form });
    if (!response.ok) throw new ApiError(502, ErrorCode.BAD_GATEWAY, "Turnstile 検証に失敗しました");

    const result = (await response.json()) as SiteVerifyResponse;
    if (!result.success) {
      throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile 検証に失敗しました", result["error-codes"]);
    }

    // 開発時はテストキー hostname が空のことがある
    c.set("turnstileVerified" as never, true as never);
    await next();
  });
}
