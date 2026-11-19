// `POST /v1/pet/models` — 事業者のモデル一覧を取り寄せる（設計 §10.1）。
//
// - キーは chat と同じくヘッダーで 1 回だけ受け取り、DB・console に残さない。
// - 接続先の検査（custom の https 公開ホスト）と E2E 差し替えは chat と同じ `resolvePetTarget`。
// - openai 形式は `GET {base}/models`。anthropic は `GET {base}/models?limit=1000` で、
//   `has_more` の間 `after_id` で次を取る（最大 5 回）。
// - id は 1〜200 文字の文字列だけ。重複を除いて id 順に並べ、`PET_MODELS_MAX` で切る。

import {
  ApiError,
  ErrorCode,
  PET_LIMITS,
  PET_MODELS_MAX,
  type PetModelsRequest,
  type PetModelsResponse,
  type PetProtocol,
  type PetProviderId,
} from "shared";
import type { Env } from "../../lib/env";
import { checkRateLimit } from "../../lib/do";
import { fetchProviderJson } from "./http";
import { resolvePetTarget, type PetRelayIdentity } from "./relay";

const USER_AGENT = "open-clone-pet/1.0";
const MODEL_ID_MAX_CHARS = 200;
const ANTHROPIC_MODELS_PAGE_SIZE = "1000";
const ANTHROPIC_MODELS_MAX_PAGES = 5;

export interface PetModelsInput {
  env: Env;
  request: PetModelsRequest;
  apiKey: string;
  identity: PetRelayIdentity;
  siteUrl: string;
  requestUrl: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function uninterpretable(): ApiError {
  return new ApiError(502, ErrorCode.PET_PROVIDER_ERROR, "AI 事業者のモデル一覧を解釈できませんでした");
}

/** ページ送りを含めた一覧取得全体の期限切れ（`providerTimeoutMs`）。 */
function modelsTimeout(): ApiError {
  return new ApiError(504, ErrorCode.PET_PROVIDER_TIMEOUT, "モデル一覧の取得が時間内に終わりませんでした");
}

/** 事業者への一覧要求ヘッダー（chat と同じ認証方法。Accept だけ足す）。 */
function modelsHeaders(
  protocol: PetProtocol,
  provider: PetProviderId,
  apiKey: string,
  siteUrl: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  headers["authorization"] = `Bearer ${apiKey}`;
  if (provider === "openrouter") {
    if (siteUrl.length > 0) headers["HTTP-Referer"] = siteUrl;
    headers["X-Title"] = "open-clone";
  }
  return headers;
}

/** 回数制限（chat とは別枠で 1 分 `modelsPerMinute`）。キーの付け方は chat と同じ。 */
async function assertModelsRateLimit(env: Env, identity: PetRelayIdentity): Promise<void> {
  const identities = identity.accountId
    ? [`account:${identity.accountId}`]
    : [`device:${identity.deviceHash}`, `ip:${identity.ipHash}`];
  const results = await Promise.all(
    identities.map((hash) => checkRateLimit(env, "petModelsMinute", hash, PET_LIMITS.modelsPerMinute)),
  );
  const denied = results.filter((result) => !result.allowed);
  if (denied.length === 0) return;
  throw new ApiError(429, ErrorCode.RATE_LIMITED, "モデル一覧の取得が多すぎます。1 分ほど待ってください", {
    retryAfterSeconds: Math.max(...denied.map((result) => result.retryAfterSeconds)),
  });
}

/**
 * 一覧に 1 件足す。id が文字列で 1〜200 文字のものだけ。
 * 同じ id が複数回来たら最初の 1 件を残し、表示名だけ後から補う。
 */
function addModel(map: Map<string, string | null>, id: unknown, label: unknown): void {
  if (typeof id !== "string" || id.length < 1 || id.length > MODEL_ID_MAX_CHARS) return;
  const display = typeof label === "string" && label.trim().length > 0 ? label : null;
  if (!map.has(id)) {
    map.set(id, display);
    return;
  }
  if (map.get(id) === null && display !== null) map.set(id, display);
}

function rowsOf(data: unknown): unknown[] | null {
  const root = asRecord(data);
  const rows = root?.["data"];
  return Array.isArray(rows) ? rows : null;
}

async function collectOpenAiModels(
  url: string,
  headers: Record<string, string>,
  apiKey: string,
  deadline: number,
): Promise<Map<string, string | null>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw modelsTimeout();
  const rows = rowsOf(
    await fetchProviderJson({ url, method: "GET", headers, apiKey, timeoutMs: remaining }),
  );
  if (!rows) throw uninterpretable();
  const models = new Map<string, string | null>();
  for (const row of rows) {
    const record = asRecord(row);
    if (record) addModel(models, record["id"], null);
  }
  return models;
}

export async function collectAnthropicModels(
  baseUrl: string,
  headers: Record<string, string>,
  apiKey: string,
  deadline: number,
): Promise<Map<string, string | null>> {
  const models = new Map<string, string | null>();
  let afterId: string | null = null;

  for (let page = 0; page < ANTHROPIC_MODELS_MAX_PAGES; page += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw modelsTimeout();
    const url = new URL(`${baseUrl}/models`);
    url.searchParams.set("limit", ANTHROPIC_MODELS_PAGE_SIZE);
    if (afterId !== null) url.searchParams.set("after_id", afterId);

    const data = await fetchProviderJson({
      url: url.toString(),
      method: "GET",
      headers,
      apiKey,
      timeoutMs: remaining,
    });
    const root = asRecord(data);
    const rows = rowsOf(data);
    if (!root || !rows) throw uninterpretable();

    let lastRowId: string | null = null;
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) continue;
      const id = record["id"];
      addModel(models, id, record["display_name"]);
      if (typeof id === "string" && id.length > 0) lastRowId = id;
    }

    if (root["has_more"] !== true) break;
    const cursor = typeof root["last_id"] === "string" && root["last_id"].length > 0 ? root["last_id"] : lastRowId;
    // カーソルが進まない実装で無限に叩かない。
    if (cursor === null || cursor === afterId) break;
    afterId = cursor;
  }
  return models;
}

/** 一覧を id 順に並べ、上限を超えた分を捨てる。 */
function finishModels(models: Map<string, string | null>): PetModelsResponse {
  const sorted = [...models.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    models: sorted.slice(0, PET_MODELS_MAX).map(([id, label]) => ({ id, label })),
    truncated: sorted.length > PET_MODELS_MAX,
  };
}

/** `POST /v1/pet/models` の本体。 */
export async function fetchPetModels(input: PetModelsInput): Promise<PetModelsResponse> {
  const target = resolvePetTarget({
    provider: input.request.provider,
    baseUrl: input.request.baseUrl,
    override: input.env.PET_PROVIDER_BASE_OVERRIDE,
    requestUrl: input.requestUrl,
    allowedOrigins: input.env.ALLOWED_ORIGINS ?? "",
  });

  await assertModelsRateLimit(input.env, input.identity);

  // ページ送りを含めた一覧取得全体の期限。1 ページごとの待ち（providerTimeoutMs）を
  // 5 回重ねて最長 7.5 分 Worker を拘束しないよう、全体を 90 秒で区切る。
  const deadline = Date.now() + PET_LIMITS.providerTimeoutMs;
  const headers = modelsHeaders(target.protocol, input.request.provider, input.apiKey, input.siteUrl);
  const models =
    target.protocol === "anthropic"
      ? await collectAnthropicModels(target.baseUrl, headers, input.apiKey, deadline)
      : await collectOpenAiModels(`${target.baseUrl}/models`, headers, input.apiKey, deadline);
  return finishModels(models);
}