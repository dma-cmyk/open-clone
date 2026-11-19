// 中継 API（`POST /api/v1/pet/chat`）のクライアント。
//
// 契約: `packages/shared/src/schemas/pet.ts`。API キーは本文に入れず `X-Pet-Api-Key` ヘッダーで送る
// （要求本文・サーバーのログにキーが混ざらない）。サーバーは組み立て直して事業者に中継するだけで保存しない。
//
// 失敗は `PetRelayError`（code つき）にそろえ、画面に出す日本語の案内もここで決める
// （キー・回数・時間切れ・モデル名のどれかを利用者が切り分けられるようにする）。

import { PET_API_KEY_HEADER, type PetChatResponse, type PetMessage, type PetModelInfo, type PetModelsResponse, type PetToolSpec } from "shared";
import type { PetConfig } from "./contract";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

/** 中継・事業者の失敗。`code` は API のコード（通信できなければ `NETWORK`）。 */
export class PetRelayError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "PetRelayError";
    this.code = code;
    this.status = status;
  }
}

export interface PetChatInput {
  system: string;
  messages: PetMessage[];
  tools: PetToolSpec[];
  maxTokens?: number;
}

export interface PetRelayOptions {
  signal?: AbortSignal;
  /** 試験用の差し替え（既定はグローバルの fetch）。 */
  fetchImpl?: typeof fetch;
}

/** code ごとの利用者向けの案内。API の文言より具体的にし、次に何をすればよいかを書く。 */
export function petRelayMessage(code: string, status: number, apiMessage: string | null): string {
  switch (code) {
    case "PET_PROVIDER_AUTH":
      return "AI 事業者が API キーを受け付けませんでした。設定の API キー（と事業者）を確かめてください。";
    case "PET_PROVIDER_RATE_LIMITED":
      return "AI 事業者の回数・残高の上限にかかりました。少し待ってから試してください。";
    case "PET_PROVIDER_TIMEOUT":
      return "AI 事業者の応答が時間内に返りませんでした。もう一度試してください。";
    case "PET_PROVIDER_ERROR":
      return apiMessage
        ? `${apiMessage}（モデル名と接続先を確かめてください）`
        : "AI 事業者がエラーを返しました。モデル名と接続先を確かめてください。";
    case "RATE_LIMITED":
      return "ペットの利用回数が上限に達しました。少し待ってから試してください。";
    case "PAYLOAD_TOO_LARGE":
      return "会話が長すぎます。「会話を消す」で履歴を消してから試してください。";
    case "NETWORK":
      return "中継 API に通信できませんでした。ネットワークを確かめてから試してください。";
    case "VALIDATION":
    case "BAD_REQUEST":
      return apiMessage ?? "設定か会話の内容が正しくありません。";
    case "INTERNAL":
      return "中継 API で問題が起きました。時間をおいて試してください。";
    default:
      return apiMessage ?? `中継 API がエラーを返しました（HTTP ${status}）。`;
  }
}

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

/** 応答の `PetChatResponse` を最小限に検証する（形が違えば中継の不具合として扱う）。 */
function readChatResponse(data: unknown): PetChatResponse {
  const record = (data ?? {}) as Record<string, unknown>;
  const message = (record.message ?? {}) as Record<string, unknown>;
  if (!message || typeof message !== "object") {
    throw new PetRelayError("INTERNAL", "中継 API の応答が不正です（message がありません）。", 200);
  }
  const content = typeof message.content === "string" ? message.content : null;
  const rawCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
  const toolCalls = rawCalls
    .map((raw) => {
      const call = (raw ?? {}) as Record<string, unknown>;
      if (typeof call.id !== "string" || typeof call.name !== "string" || typeof call.arguments !== "string") return null;
      return { id: call.id, name: call.name, arguments: call.arguments };
    })
    .filter((call): call is { id: string; name: string; arguments: string } => call !== null);
  const finishReason =
    record.finishReason === "stop" || record.finishReason === "tool_calls" || record.finishReason === "length"
      ? record.finishReason
      : "other";
  const usage = (record.usage ?? {}) as Record<string, unknown>;
  return {
    message: { content, toolCalls },
    finishReason,
    model: typeof record.model === "string" ? record.model : "",
    usage: {
      inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : null,
      outputTokens: typeof usage.outputTokens === "number" ? usage.outputTokens : null,
    },
  };
}

/**
 * 中継 API を 1 回呼び、`data` を返す（失敗は `PetRelayError` にそろえる）。
 * キーは必ずヘッダーで送る。
 */
async function postPet(
  path: string,
  config: Pick<PetConfig, "provider" | "baseUrl" | "apiKey">,
  body: Record<string, unknown>,
  options: PetRelayOptions,
): Promise<unknown> {
  if (config.provider === "custom" && config.baseUrl.trim().length === 0) {
    throw new PetRelayError("VALIDATION", "接続先の URL を入れてください。", 0);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        [PET_API_KEY_HEADER]: config.apiKey,
      },
      body: JSON.stringify({
        provider: config.provider,
        ...(config.provider === "custom" ? { baseUrl: config.baseUrl.trim() } : {}),
        ...body,
      }),
      signal: options.signal,
    });
  } catch (cause) {
    // 「止める」で中断したときは、利用者の操作なので案内を出さない（呼び出し側が signal で判断する）。
    if (options.signal?.aborted) throw cause;
    throw new PetRelayError("NETWORK", petRelayMessage("NETWORK", 0, null), 0);
  }

  let envelope: Envelope | null = null;
  try {
    envelope = (await response.json()) as Envelope;
  } catch {
    envelope = null;
  }

  if (!envelope || typeof envelope.ok !== "boolean") {
    throw new PetRelayError("INTERNAL", petRelayMessage("INTERNAL", response.status, null), response.status);
  }
  if (!envelope.ok) {
    const code = envelope.code ?? "UNKNOWN";
    throw new PetRelayError(code, petRelayMessage(code, response.status, envelope.message ?? null), response.status);
  }
  return envelope.data;
}

/** 1 往復ぶん中継する。 */
export async function petChat(
  config: PetConfig,
  input: PetChatInput,
  options: PetRelayOptions = {},
): Promise<PetChatResponse> {
  const data = await postPet(
    "/pet/chat",
    config,
    {
      model: config.model.trim(),
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    },
    options,
  );
  return readChatResponse(data);
}

/** モデル一覧（`POST /pet/models`）。取れた一覧は保存しない（設定画面が持つだけ）。 */
export async function petModels(
  config: Pick<PetConfig, "provider" | "baseUrl" | "apiKey">,
  options: PetRelayOptions = {},
): Promise<PetModelsResponse> {
  const data = await postPet("/pet/models", config, {}, options);
  const record = (data ?? {}) as Record<string, unknown>;
  const rawModels = Array.isArray(record.models) ? record.models : [];
  const models = rawModels
    .map((raw) => {
      const model = (raw ?? {}) as Record<string, unknown>;
      if (typeof model.id !== "string" || model.id.length === 0) return null;
      return { id: model.id, label: typeof model.label === "string" ? model.label : null };
    })
    .filter((model): model is PetModelInfo => model !== null);
  return { models, truncated: record.truncated === true };
}

/** 「接続を試す」。ツールを付けずに短い文を 1 回だけ送り、返事を返す。 */
export async function petTestConnection(config: PetConfig, options: PetRelayOptions = {}): Promise<string> {
  const response = await petChat(
    config,
    {
      system: "あなたは接続確認の相手です。日本語で短く答えてください。",
      messages: [{ role: "user", content: "接続の確認です。「つながりました」とだけ返してください。" }],
      tools: [],
      maxTokens: 64,
    },
    options,
  );
  return (response.message.content ?? "").trim() || "（空の返事が返りました）";
}