// AI ペット（サイト組み込みの AI チャット）の中継 API 契約。
//
// 利用者は自分の好きな AI 事業者の API キーとモデルを使う。キーはブラウザにだけ保存し、
// サーバー（`POST /v1/pet/chat`）は 1 回ごとに `X-Pet-Api-Key` ヘッダーで受け取って事業者へ中継するだけで、
// DB・ログ・監査には一切残さない。サーバーは要求本文をそのまま転送せず、この契約の型から
// 事業者ごとの要求を組み立て直す（汎用の転送口にしない）。
// 設計: サブエージェント報告書「おーぷんクローン_AIペット/00_依頼内容と設計_オーケストレーター.md」。

import { z } from "zod";

/** 事業者の要求形式。`openai` は Chat Completions（tools 付き）、`anthropic` は Messages API。 */
export type PetProtocol = "openai" | "anthropic";

export interface PetProviderPreset {
  id: PetProviderId;
  label: string;
  protocol: PetProtocol;
  /** 固定の接続先。`custom` だけ null（利用者が https の URL を入れる）。 */
  baseUrl: string | null;
  /** API キーを発行する画面（設定画面の案内リンク）。 */
  keyPageUrl: string | null;
}

export const PET_PROVIDER_IDS = ["openai", "anthropic", "gemini", "openrouter", "deepseek", "custom"] as const;
export type PetProviderId = (typeof PET_PROVIDER_IDS)[number];

export const PET_PROVIDER_PRESETS: readonly PetProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    keyPageUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyPageUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyPageUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    keyPageUrl: "https://openrouter.ai/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    keyPageUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "custom",
    label: "OpenAI 互換（URL を指定）",
    protocol: "openai",
    baseUrl: null,
    keyPageUrl: null,
  },
];

export function petProviderPreset(id: PetProviderId): PetProviderPreset {
  const preset = PET_PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown pet provider: ${id}`);
  return preset;
}

/** 上限（サーバーが強制する。画面はこれを超えないよう履歴を切り詰める）。 */
export const PET_LIMITS = {
  /** API キーの最大長（印字可能 ASCII のみ）。 */
  apiKeyMaxChars: 512,
  modelMaxChars: 200,
  baseUrlMaxChars: 300,
  systemMaxChars: 24_000,
  messageMaxChars: 24_000,
  messagesMax: 80,
  toolsMax: 48,
  toolDescriptionMaxChars: 1_000,
  toolArgumentsMaxChars: 24_000,
  /** 要求本文全体（JSON バイト数）。 */
  requestMaxBytes: 512 * 1024,
  /** 事業者応答の読み取り上限。 */
  providerResponseMaxBytes: 1024 * 1024,
  /** 事業者待ちの上限（ミリ秒）。 */
  providerTimeoutMs: 90_000,
  /** 出力トークンの既定と上限（anthropic は必須、openai は指定時のみ送る）。 */
  maxTokensDefault: 2_048,
  maxTokensMax: 8_192,
  /** 中継の回数制限（キー=アカウント ID、未ログインは端末＋IP）。 */
  perMinute: 20,
  perDay: 600,
} as const;

/** OpenAI の function 名の制約（`^[a-zA-Z0-9_-]{1,64}$`）より狭くし、全事業者で通る形にする。 */
export const PET_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const petToolCallSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().regex(PET_TOOL_NAME_RE),
  /** JSON 文字列（事業者が返した引数をそのまま保持する。解釈はブラウザのツール側）。 */
  arguments: z.string().max(PET_LIMITS.toolArgumentsMaxChars),
});
export type PetToolCall = z.infer<typeof petToolCallSchema>;

export const petMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: z.string().min(1).max(PET_LIMITS.messageMaxChars),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.string().max(PET_LIMITS.messageMaxChars).nullable(),
    toolCalls: z.array(petToolCallSchema).max(16).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    toolCallId: z.string().min(1).max(200),
    name: z.string().regex(PET_TOOL_NAME_RE),
    content: z.string().max(PET_LIMITS.messageMaxChars),
  }),
]);
export type PetMessage = z.infer<typeof petMessageSchema>;

export const petToolSpecSchema = z.object({
  name: z.string().regex(PET_TOOL_NAME_RE),
  description: z.string().min(1).max(PET_LIMITS.toolDescriptionMaxChars),
  /** JSON Schema（type: "object"）。サーバーは形だけ確認して事業者に渡す。 */
  parameters: z.record(z.string(), z.unknown()),
});
export type PetToolSpec = z.infer<typeof petToolSpecSchema>;

export const petChatRequestSchema = z
  .object({
    provider: z.enum(PET_PROVIDER_IDS),
    /** `custom` のときだけ必須（https・公開ホストのみ）。それ以外で送られたら 400。 */
    baseUrl: z.string().max(PET_LIMITS.baseUrlMaxChars).optional(),
    model: z.string().trim().min(1).max(PET_LIMITS.modelMaxChars),
    system: z.string().max(PET_LIMITS.systemMaxChars),
    messages: z.array(petMessageSchema).min(1).max(PET_LIMITS.messagesMax),
    tools: z.array(petToolSpecSchema).max(PET_LIMITS.toolsMax),
    maxTokens: z.number().int().min(64).max(PET_LIMITS.maxTokensMax).optional(),
  })
  .strict();
export type PetChatRequest = z.infer<typeof petChatRequestSchema>;

export type PetFinishReason = "stop" | "tool_calls" | "length" | "other";

/** `POST /v1/pet/chat` の成功 data。事業者の違いはサーバーがこの形にそろえる。 */
export interface PetChatResponse {
  message: {
    content: string | null;
    toolCalls: PetToolCall[];
  };
  finishReason: PetFinishReason;
  /** 事業者が返したモデル名（無ければ要求のモデル名）。 */
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/** API キーを渡すヘッダー（本文に入れない＝要求本文のログにキーが混ざらない）。 */
export const PET_API_KEY_HEADER = "X-Pet-Api-Key";
