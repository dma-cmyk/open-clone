// エラーハンドリング。
// 投げられたエラーを全て `{ ok: false, code, message }` envelope に変換する。
// App Error 以外は内部情報を漏らさず `INTERNAL` 500 に丸める。

import { createMiddleware } from "hono/factory";
import { ApiError, ErrorCode, type AppRequestContext } from "shared";
import type { AppEnv } from "../env";

export const errorHandler = createMiddleware<AppEnv>(async (c, next) => {
  try {
    await next();
  } catch (error) {
    // requestContext より前に例外が出ると reqCtx は未設定（Hono の型は非 optional のため明示的に扱う）。
    const reqCtx: AppRequestContext | undefined = c.get("reqCtx");
    const response = toErrorResponse(error, {
      requestId: reqCtx?.requestId,
      method: c.req.method,
      path: c.req.path,
    });
    return Response.json(response.body, { status: response.status });
  }
});

/** 想定外エラーの構造化ログ（内部情報はレスポンスに含めない）。 */
export interface ErrorLogContext {
  requestId?: string;
  method?: string;
  path?: string;
}

function logUnhandled(error: unknown, context: ErrorLogContext = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  // 1 行 JSON で構造化する（wrangler tail / Logpush で検索しやすくする）。
  console.error(
    JSON.stringify({
      event: "UNHANDLED_ERROR",
      requestId: context.requestId ?? null,
      method: context.method ?? null,
      path: context.path ?? null,
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    }),
  );
}

export function toErrorResponse(
  error: unknown,
  context: ErrorLogContext = {},
): {
  status: number;
  body: { ok: false; code: string; message: string; details?: unknown };
} {
  if (error instanceof ApiError) {
    // 5xx の ApiError は設定不備などの可能性があるため、本文は契約どおり返しつつログに残す。
    if (error.status >= 500) logUnhandled(error, context);
    return {
      status: error.status,
      body: {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  if (error instanceof Error && error.name === "ZodError") {
    return {
      status: 400,
      body: {
        ok: false,
        code: ErrorCode.VALIDATION,
        message: "入力が不正です",
        details: (error as { issues?: unknown[] }).issues,
      },
    };
  }

  logUnhandled(error, context);
  return {
    status: 500,
    body: { ok: false, code: ErrorCode.INTERNAL, message: "内部エラーが発生しました" },
  };
}

/** 404。存在しないルートへのフォールバック。 */
export const notFoundHandler = (): Response => {
  return Response.json(
    { ok: false, code: ErrorCode.NOT_FOUND, message: "リソースが見つかりません" },
    { status: 404 },
  );
};
