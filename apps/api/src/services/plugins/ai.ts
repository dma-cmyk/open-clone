// プラグイン AI 連携（POST /v1/ai/complete / RPC ai.complete）。
//
// iframe は外部へ直接通信できないため、ホストが権限（ai:complete）・導入スコープ・レート/日次上限を
// 検証してから、サイト管理者が設定した OpenAI 互換 API へ中継する。接続先が未設定なら
// `AI_DISABLED` を返す（ダミー応答・ローカル生成は行わない）。プロンプト本文は監査に保存しない。

import {
  ApiError,
  ErrorCode,
  PLUGIN_AI_DAILY_LIMIT,
  PLUGIN_AI_MAX_TOKENS,
  PLUGIN_AI_OUTPUT_MAX_CHARS,
  ulid,
  type PluginAiCompleteInput,
  type PluginAiCompleteResult,
  type PluginScope,
} from "shared";
import type { Env } from "../../lib/env";
import { checkRateLimit } from "../../lib/do";
import { assertPublicHttpsUrl } from "../../lib/url-safety";
import { getSiteSettings } from "../account/site-config";
import { readEnvSecret } from "../env-secrets";
import { scopeRefFor, type PluginActor } from "./access";
import {
  findInstall,
  getPluginRow,
  getVersionRow,
  parseManifest,
} from "./registry";

const PROVIDER_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 64 * 1024;

export interface PluginAiCaller {
  accountId: string | null;
  deviceHash: string;
  ipHash: string;
  requestId?: string | null;
}

interface ResolvedConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

interface ProviderResponse {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** サイト管理者が設定した接続先を解決する。未設定なら AI_DISABLED（500 ではない）。 */
async function resolveConfig(env: Env): Promise<ResolvedConfig> {
  const settings = await getSiteSettings(env.DB);
  const baseUrl = settings["plugin.ai.baseUrl"].trim();
  const apiKey = readEnvSecret(env, "PLUGIN_AI_API_KEY");
  if (baseUrl.length === 0 || !apiKey) {
    throw new ApiError(
      503,
      ErrorCode.AI_DISABLED,
      "AI 連携が無効です（サイト管理者が接続先または API キーを設定していません）",
    );
  }
  const base = baseUrl.replace(/\/+$/, "");
  let endpoint: URL;
  try {
    // 接続先はサイト管理者設定だが、DB 改ざん等に備えて送信直前に再検証する（SSRF 共通実装）。
    endpoint = assertPublicHttpsUrl(`${base}/chat/completions`, { allowlist: [base] });
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(500, ErrorCode.MISCONFIGURED, "AI 連携の接続先設定が不正です");
    }
    throw error;
  }
  return {
    endpoint: endpoint.toString(),
    apiKey,
    model: settings["plugin.ai.model"] || "gpt-4o-mini",
  };
}

function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  // OpenAI 互換プロバイダには content をパート配列で返す実装がある。
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text: unknown = Reflect.get(part, "text");
      if (typeof text === "string") parts.push(text);
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

interface LogEntry {
  pluginId: string;
  version: string | null;
  scope: PluginScope;
  boardId?: number | null;
  caller: PluginAiCaller;
  promptChars: number;
  systemChars: number;
  outputChars?: number | null;
  model?: string | null;
  status: "ok" | "error" | "denied";
  errorCode?: string | null;
  durationMs?: number | null;
}

async function writeLog(env: Env, entry: LogEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO plugin_ai_log
       (id, plugin_id, version, scope, board_id, account_id, device_hash,
        prompt_chars, system_chars, output_chars, model, status, error_code, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ulid(),
      entry.pluginId,
      entry.version,
      entry.scope,
      entry.boardId ?? null,
      entry.caller.accountId,
      entry.caller.deviceHash,
      entry.promptChars,
      entry.systemChars,
      entry.outputChars ?? null,
      entry.model ?? null,
      entry.status,
      entry.errorCode ?? null,
      entry.durationMs ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

/** 端末×プラグインの日次カウンタを加算し、上限超過を判定する。 */
async function consumeDaily(env: Env, pluginId: string, caller: PluginAiCaller): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = now - (now % 86_400);
  const identity = caller.accountId ? `account:${caller.accountId}` : `device:${caller.deviceHash}`;
  const row = await env.DB.prepare(
    `INSERT INTO plugin_ai_usage (plugin_id, identity_hash, day_start, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(plugin_id, identity_hash, day_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(pluginId, identity, dayStart)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/**
 * ai:complete を実行する。権限・導入状態・上限を検証し、失敗も plugin_ai_log に残す。
 * 成功時は `{text, model}`。外部接続先が応答しない/壊れた場合は BAD_GATEWAY（ダミー応答なし）。
 */
export async function completePluginAi(
  env: Env,
  input: PluginAiCompleteInput,
  caller: PluginAiCaller,
): Promise<PluginAiCompleteResult> {
  const plugin = await getPluginRow(env.DB, input.pluginId);
  if (!plugin) throw ApiError.notFound("プラグインが見つかりません");

  const actor: PluginActor = {
    accountId: caller.accountId,
    role: null,
    deviceHash: caller.deviceHash,
    isAdmin: false,
  };
  const isOwner = caller.accountId !== null && plugin.owner_account_id === caller.accountId;

  const scopeRef = scopeRefFor(input.scope, actor, input.boardId);
  const install = await findInstall(env.DB, plugin.id, input.scope, scopeRef);
  const version = install?.version ?? input.version ?? plugin.latest_version ?? null;

  const log = (entry: Omit<LogEntry, "pluginId" | "version" | "scope" | "boardId" | "caller">) =>
    writeLog(env, {
      pluginId: plugin.id,
      version,
      scope: input.scope,
      boardId: input.boardId ?? null,
      caller,
      ...entry,
    }).catch((error: unknown) => console.warn("plugin_ai_log failed", error));

  const startedAt = Date.now();
  try {
    if (plugin.status === "disabled") {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "このプラグインは停止されています");
    }
    if (plugin.status !== "published" && !isOwner) {
      throw ApiError.notFound("プラグインが見つかりません");
    }
    if (install && input.version && input.version !== install.version) {
      throw ApiError.conflict("導入されているバージョンと一致しません");
    }
    if (!install && !isOwner) {
      throw ApiError.forbidden("このスコープにプラグインが導入されていません");
    }

    // 権限は「実際に導入されている版」の manifest で判定する（最新版の権限で過去版を許可しない）。
    let manifestJson = plugin.manifest_json;
    if (install) {
      const versionRow = await getVersionRow(env.DB, plugin.id, install.version);
      if (versionRow) manifestJson = versionRow.manifest_json;
    }
    const manifest = parseManifest(manifestJson);
    if (!manifest.permissions.includes("ai:complete")) {
      throw ApiError.forbidden("manifest に ai:complete 権限が宣言されていません");
    }

    const config = await resolveConfig(env);

    const rate = await checkRateLimit(env, "pluginAi", `${plugin.id}:${caller.deviceHash}`);
    if (!rate.allowed) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, "AI 連携の呼び出しが多すぎます。しばらく待ってください", {
        retryAfterSeconds: rate.retryAfterSeconds,
      });
    }
    const daily = await consumeDaily(env, plugin.id, caller);
    if (daily > PLUGIN_AI_DAILY_LIMIT) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, `本日の AI 連携上限（${PLUGIN_AI_DAILY_LIMIT} 回）に達しました`);
    }

    const messages: Array<{ role: "system" | "user"; content: string }> = [];
    if (input.system) messages.push({ role: "system", content: input.system });
    messages.push({ role: "user", content: input.prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "user-agent": "open-clone-plugin-ai/1.0",
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: Math.min(input.maxTokens ?? 256, PLUGIN_AI_MAX_TOKENS),
        }),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError(504, ErrorCode.BAD_GATEWAY, "AI 接続先がタイムアウトしました");
      }
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, "AI 接続先への通信に失敗しました");
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, "AI 接続先がリダイレクトを返しました");
    }
    if (!response.ok) {
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, `AI 接続先が失敗を返しました（HTTP ${response.status}）`);
    }

    const raw = await response.text();
    if (raw.length > PROVIDER_RESPONSE_MAX_BYTES) {
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, "AI 接続先の応答が大きすぎます");
    }
    let parsed: ProviderResponse;
    try {
      parsed = JSON.parse(raw) as ProviderResponse;
    } catch {
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, "AI 接続先の応答が不正です");
    }
    const text = contentToText(parsed.choices?.[0]?.message?.content);
    if (text === null) {
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, "AI 接続先の応答に本文がありません");
    }
    if (Array.from(text).length > PLUGIN_AI_OUTPUT_MAX_CHARS) {
      throw new ApiError(502, ErrorCode.BAD_GATEWAY, "AI 接続先の応答が長すぎます");
    }
    const model = typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : config.model;

    await log({
      promptChars: Array.from(input.prompt).length,
      systemChars: Array.from(input.system ?? "").length,
      outputChars: Array.from(text).length,
      model,
      status: "ok",
      durationMs: Date.now() - startedAt,
    });
    return { text, model };
  } catch (error) {
    const denied =
      error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;
    await log({
      promptChars: Array.from(input.prompt).length,
      systemChars: Array.from(input.system ?? "").length,
      outputChars: null,
      model: null,
      status: denied ? "denied" : "error",
      errorCode: error instanceof ApiError ? error.code : "INTERNAL",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}