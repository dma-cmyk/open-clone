// AI ペットのチャット中継（POST /v1/pet/chat）とモデル一覧（POST /v1/pet/models）。
//
// ブラウザはサイトの CSP のため AI 事業者へ直接つながない。このルートが 1 回だけ受け取り、
// 利用者のキーで事業者へ送って契約の形にそろえて返す。ログインは不要（未ログインは端末＋IP で回数制限）。
// キーは `X-Pet-Api-Key` ヘッダーだけ（本文に入れない＝要求本文のログに混ざらない）。
// キー・会話本文・ツール結果は DB・console・監査に残さない。

import { Hono, type Context } from "hono";
import {
  ApiError,
  ErrorCode,
  PET_API_KEY_HEADER,
  PET_LIMITS,
  ok,
  petChatRequestSchema,
  petModelsRequestSchema,
} from "shared";
import type { AppEnv } from "../lib/env";
import { getReqCtx } from "../lib/context";
import { requestOrigin } from "../lib/middleware/origin";
import { fetchPetModels } from "../services/pet/models";
import { relayPetChat } from "../services/pet/relay";

const app = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

/**
 * API キーのヘッダー検証。無い・長すぎ・印字可能 ASCII 以外は 400（設計 §5）。
 * 値を trim しない（事業者によっては空白を含むキー形式があるため、そのまま使う）。
 */
function readApiKey(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) {
    throw ApiError.validation("API キーが必要です（X-Pet-Api-Key）");
  }
  if (raw.length > PET_LIMITS.apiKeyMaxChars) {
    throw ApiError.validation("API キーが長すぎます");
  }
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      throw ApiError.validation("API キーに使えない文字が含まれています（印字可能 ASCII のみ）");
    }
  }
  return raw;
}

/** 要求本文（JSON）を上限バイト数まで読む。JSON として読めなければ 400。 */
async function readJsonBody(c: Ctx): Promise<unknown> {
  // 宣言長で早めに落とし、実際に読んだ UTF-8 バイト数でも確認する。
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PET_LIMITS.requestMaxBytes) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "リクエストが大きすぎます");
  }
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > PET_LIMITS.requestMaxBytes) {
    throw new ApiError(413, ErrorCode.PAYLOAD_TOO_LARGE, "リクエストが大きすぎます");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw ApiError.validation("リクエスト本文が JSON として不正です");
  }
}

/** zod の issue は入力値を含み得るため、path と message だけ返す。 */
function validationError(issues: readonly { path: PropertyKey[]; message: string }[]): ApiError {
  return ApiError.validation("入力が不正です", {
    issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
  });
}

app.post("/chat", async (c) => {
  const apiKey = readApiKey(c.req.header(PET_API_KEY_HEADER));
  const parsed = petChatRequestSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw validationError(parsed.error.issues);

  const reqCtx = getReqCtx(c);
  const data = await relayPetChat({
    env: c.env,
    request: parsed.data,
    apiKey,
    identity: {
      accountId: reqCtx.session?.account.id ?? null,
      deviceHash: reqCtx.device.deviceHash,
      ipHash: reqCtx.device.ipHash,
    },
    siteUrl: requestOrigin(c),
    requestUrl: c.req.url,
  });
  return c.json(ok(data));
});

app.post("/models", async (c) => {
  const apiKey = readApiKey(c.req.header(PET_API_KEY_HEADER));
  const parsed = petModelsRequestSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw validationError(parsed.error.issues);

  const reqCtx = getReqCtx(c);
  const data = await fetchPetModels({
    env: c.env,
    request: parsed.data,
    apiKey,
    identity: {
      accountId: reqCtx.session?.account.id ?? null,
      deviceHash: reqCtx.device.deviceHash,
      ipHash: reqCtx.device.ipHash,
    },
    siteUrl: requestOrigin(c),
    requestUrl: c.req.url,
  });
  return c.json(ok(data));
});

export default app;