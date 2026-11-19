// AI ペット中継の本体（POST /v1/pet/chat から呼ぶ）。
//
// 設計（サブエージェント報告書 00 §5）:
// - 接続先はプリセット 5 社の固定 URL か、custom の https 公開ホストだけ（`assertPublicHttpsUrl`）。
// - 要求本文はそのまま転送せず、`services/pet/request.ts` が契約から組み直す。
// - API キーはヘッダーで受けた 1 回だけ使い、DB・console・監査・エラーの cause に残さない。
// - 失敗は `PET_PROVIDER_*` に区別し、事業者のエラー文は伏せて 300 文字までにする。
// - E2E は `PET_PROVIDER_BASE_OVERRIDE` でスタブへ向ける（custom の URL 検査は差し替えの前）。

import {
  ApiError,
  ErrorCode,
  PET_LIMITS,
  petProviderPreset,
  type PetChatRequest,
  type PetChatResponse,
  type PetProtocol,
  type PetProviderId,
} from "shared";
import type { Env } from "../../lib/env";
import { checkRateLimit } from "../../lib/do";
import { assertPublicHttpsUrl } from "../../lib/url-safety";
import { fetchProviderJson } from "./http";
import { normalizeAnthropicResponse, normalizeOpenAiResponse } from "./normalize";
import { buildPetProviderRequest } from "./request";

export interface PetRelayIdentity {
  accountId: string | null;
  deviceHash: string;
  ipHash: string;
}

export interface PetRelayInput {
  env: Env;
  request: PetChatRequest;
  /** `X-Pet-Api-Key` の値。 */
  apiKey: string;
  identity: PetRelayIdentity;
  /** openrouter の HTTP-Referer に使うサイト URL。 */
  siteUrl: string;
  /** このリクエスト自身の URL（「このサイト自身」を接続先にさせない検査に使う）。 */
  requestUrl: string;
}

export interface PetTarget {
  protocol: PetProtocol;
  /** 要求を組み立てる基底（末尾スラッシュ無し）。 */
  baseUrl: string;
  endpoint: string;
}

/** 接続先の候補がこのサイト自身（API / web）でないことを確認する。 */
function assertNotOwnSite(url: URL, requestUrl: string, allowedOrigins: string): void {
  const origins = new Set<string>();
  try {
    origins.add(new URL(requestUrl).origin);
  } catch {
    // requestUrl は Workers が渡すので通常は解析できる。壊れていても他の検査は続ける。
  }
  for (const entry of allowedOrigins.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed === "*") continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // 許可オリジンの書式不正は originGuard 側の責務。ここでは無視する。
    }
  }
  if (origins.has(url.origin)) {
    throw ApiError.validation("このサイト自身を接続先にすることはできません");
  }
}

/**
 * custom の URL を検査する。http・私設 IP・localhost・このサイト自身はすべて 400 にそろえる
 * （`assertPublicHttpsUrl` は 403 を投げるため、そのまま返さない）。
 */
function assertCustomBaseUrl(raw: string, requestUrl: string, allowedOrigins: string): URL {
  let url: URL;
  try {
    url = assertPublicHttpsUrl(raw);
  } catch (error) {
    if (error instanceof ApiError) {
      throw ApiError.validation("接続先 URL が不正です（https の公開ホストだけを使えます）");
    }
    throw error;
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw ApiError.validation("接続先 URL にクエリやフラグメントは指定できません");
  }
  assertNotOwnSite(url, requestUrl, allowedOrigins);
  return url;
}

/**
 * 送信先を決める。
 * - custom: `baseUrl` 必須（https・公開ホスト・このサイト以外）。他の事業者で `baseUrl` が来たら 400。
 * - `PET_PROVIDER_BASE_OVERRIDE` があれば、openai は `{override}/openai`、anthropic は `{override}/anthropic`。
 *   差し替えは custom の検査の後に行う。
 */
export function resolvePetTarget(input: {
  provider: PetProviderId;
  baseUrl?: string;
  override?: string | null;
  requestUrl: string;
  allowedOrigins: string;
}): PetTarget {
  const preset = petProviderPreset(input.provider);
  let base: string;
  if (input.provider === "custom") {
    const raw = input.baseUrl?.trim() ?? "";
    if (raw.length === 0) throw ApiError.validation("custom のときは baseUrl が必要です");
    base = assertCustomBaseUrl(raw, input.requestUrl, input.allowedOrigins).toString().replace(/\/+$/, "");
  } else {
    if (input.baseUrl !== undefined) {
      throw ApiError.validation("baseUrl は custom のときだけ指定できます");
    }
    if (!preset.baseUrl) throw new ApiError(500, ErrorCode.MISCONFIGURED, "AI 事業者の接続先設定がありません");
    base = preset.baseUrl;
  }

  const override = input.override?.trim() ?? "";
  if (override.length > 0) base = `${override.replace(/\/+$/, "")}/${preset.protocol}`;

  return {
    protocol: preset.protocol,
    baseUrl: base,
    endpoint: `${base}${preset.protocol === "openai" ? "/chat/completions" : "/messages"}`,
  };
}

interface RateWindowResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * 同じ scope を複数の識別子で消費し、1 つでも上限なら拒否する（既存の checkRateLimitMulti と
 * 同じ考え方。こちらは `PET_LIMITS` の上限を窓定義より優先させる）。
 */
async function consumePetWindow(
  env: Env,
  scope: "petMinute" | "petDay",
  identities: readonly string[],
  max: number,
): Promise<RateWindowResult> {
  const results = await Promise.all(identities.map((identity) => checkRateLimit(env, scope, identity, max)));
  const denied = results.filter((result) => !result.allowed);
  if (denied.length === 0) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(...denied.map((result) => result.retryAfterSeconds)),
  };
}

/** 回数制限（1 分 `perMinute`・1 日 `perDay`）。キーはアカウント、未ログインは端末＋IP。 */
async function assertPetRateLimit(env: Env, identity: PetRelayIdentity): Promise<void> {
  const identities = identity.accountId
    ? [`account:${identity.accountId}`]
    : [`device:${identity.deviceHash}`, `ip:${identity.ipHash}`];

  const minute = await consumePetWindow(env, "petMinute", identities, PET_LIMITS.perMinute);
  if (!minute.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "AI ペットの利用が多すぎます。1 分ほど待ってください", {
      retryAfterSeconds: minute.retryAfterSeconds,
    });
  }
  const day = await consumePetWindow(env, "petDay", identities, PET_LIMITS.perDay);
  if (!day.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, "本日の AI ペットの利用上限に達しました", {
      retryAfterSeconds: day.retryAfterSeconds,
    });
  }
}

/**
 * `POST /v1/pet/chat` の本体。
 * 失敗はすべて ApiError（`PET_PROVIDER_*`）で返し、キー・会話・ツール結果は保存しない。
 */
export async function relayPetChat(input: PetRelayInput): Promise<PetChatResponse> {
  const target = resolvePetTarget({
    provider: input.request.provider,
    baseUrl: input.request.baseUrl,
    override: input.env.PET_PROVIDER_BASE_OVERRIDE,
    requestUrl: input.requestUrl,
    allowedOrigins: input.env.ALLOWED_ORIGINS ?? "",
  });

  await assertPetRateLimit(input.env, input.identity);

  const providerRequest = buildPetProviderRequest({
    provider: input.request.provider,
    protocol: target.protocol,
    endpoint: target.endpoint,
    apiKey: input.apiKey,
    siteUrl: input.siteUrl,
    request: input.request,
  });

  const raw = await fetchProviderJson({
    url: providerRequest.endpoint,
    method: "POST",
    headers: providerRequest.headers,
    body: providerRequest.body,
    apiKey: input.apiKey,
  });

  return target.protocol === "anthropic"
    ? normalizeAnthropicResponse(raw, input.request.model)
    : normalizeOpenAiResponse(raw, input.request.model);
}