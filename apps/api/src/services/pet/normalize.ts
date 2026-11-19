// 事業者の応答 → `PetChatResponse` の正規化。
//
// 事業者ごとに形が違う応答を契約の形にそろえる:
// - finishReason: `stop`/`end_turn` → stop、`tool_calls`/`tool_use` → tool_calls、`length`/`max_tokens` → length、他 → other
// - ツール引数は JSON 文字列（anthropic の `input` は文字列化する）
// - `PET_TOOL_NAME_RE` に合わない名前のツール呼び出しは捨てる（ブラウザのツール実行に渡さない）
// - 解釈できない応答は 502 `PET_PROVIDER_ERROR`

import {
  ApiError,
  ErrorCode,
  PET_LIMITS,
  PET_TOOL_NAME_RE,
  type PetChatResponse,
  type PetFinishReason,
  type PetProtocol,
  type PetToolCall,
} from "shared";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

const OPENAI_FINISH_REASONS: Record<string, PetFinishReason> = {
  stop: "stop",
  tool_calls: "tool_calls",
  length: "length",
};

const ANTHROPIC_FINISH_REASONS: Record<string, PetFinishReason> = {
  end_turn: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
};

export function mapFinishReason(raw: unknown, protocol: PetProtocol): PetFinishReason {
  if (typeof raw !== "string") return "other";
  const table = protocol === "anthropic" ? ANTHROPIC_FINISH_REASONS : OPENAI_FINISH_REASONS;
  // 事業者由来の任意文字列（`toString` 等）で Object.prototype を拾わない。
  return Object.hasOwn(table, raw) ? table[raw]! : "other";
}

function uninterpretable(): ApiError {
  return new ApiError(502, ErrorCode.PET_PROVIDER_ERROR, "AI 事業者の応答を解釈できませんでした");
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/** OpenAI 互換の content（文字列 or パート配列）を 1 本の文字列にする。 */
function contentToText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    const text = asRecord(part)?.["text"];
    if (typeof text === "string") parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

/** 引数は JSON 文字列のまま保持する。長すぎる／直列化できない呼び出しは捨てる。 */
function normalizeArguments(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? "{}"
        : (() => {
            try {
              return JSON.stringify(value);
            } catch {
              return null;
            }
          })();
  if (typeof raw !== "string" || raw.length > PET_LIMITS.toolArgumentsMaxChars) return null;
  return raw;
}

function normalizeToolCallId(value: unknown, index: number): string {
  if (typeof value === "string" && value.length > 0) return value.slice(0, 200);
  // id を返さない互換実装向け。ブラウザが結果を返すときの対応付けにだけ使う。
  return `call_${index}`;
}

function openAiToolCall(raw: unknown, index: number): PetToolCall | null {
  const record = asRecord(raw);
  const fn = record ? asRecord(record["function"]) : null;
  if (!record || !fn) return null;
  const name = typeof fn["name"] === "string" ? fn["name"] : "";
  if (!PET_TOOL_NAME_RE.test(name)) return null;
  const args = normalizeArguments(fn["arguments"]);
  if (args === null) return null;
  return { id: normalizeToolCallId(record["id"], index), name, arguments: args };
}

export function normalizeOpenAiResponse(data: unknown, requestedModel: string): PetChatResponse {
  const root = asRecord(data);
  const choice = root && Array.isArray(root["choices"]) ? asRecord(root["choices"][0]) : null;
  const message = choice ? asRecord(choice["message"]) : null;
  if (!message) throw uninterpretable();

  const rawCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : [];
  const toolCalls: PetToolCall[] = [];
  rawCalls.forEach((raw, index) => {
    const call = openAiToolCall(raw, index);
    if (call) toolCalls.push(call);
  });

  const usage = asRecord(root?.["usage"]);
  const model = root?.["model"];
  return {
    message: { content: contentToText(message["content"]), toolCalls },
    finishReason: mapFinishReason(choice?.["finish_reason"], "openai"),
    model: typeof model === "string" && model.length > 0 ? model : requestedModel,
    usage: {
      inputTokens: tokenCount(usage?.["prompt_tokens"]),
      outputTokens: tokenCount(usage?.["completion_tokens"]),
    },
  };
}

export function normalizeAnthropicResponse(data: unknown, requestedModel: string): PetChatResponse {
  const root = asRecord(data);
  const blocks = root && Array.isArray(root["content"]) ? root["content"] : null;
  if (!blocks) throw uninterpretable();

  const texts: string[] = [];
  const toolCalls: PetToolCall[] = [];
  blocks.forEach((raw, index) => {
    const block = asRecord(raw);
    if (!block) return;
    if (block["type"] === "text") {
      if (typeof block["text"] === "string") texts.push(block["text"]);
      return;
    }
    if (block["type"] !== "tool_use") return;
    const name = typeof block["name"] === "string" ? block["name"] : "";
    if (!PET_TOOL_NAME_RE.test(name)) return;
    const args = normalizeArguments(block["input"]);
    if (args === null) return;
    toolCalls.push({ id: normalizeToolCallId(block["id"], index), name, arguments: args });
  });

  const usage = asRecord(root?.["usage"]);
  const model = root?.["model"];
  return {
    message: { content: texts.length > 0 ? texts.join("") : null, toolCalls },
    finishReason: mapFinishReason(root?.["stop_reason"], "anthropic"),
    model: typeof model === "string" && model.length > 0 ? model : requestedModel,
    usage: {
      inputTokens: tokenCount(usage?.["input_tokens"]),
      outputTokens: tokenCount(usage?.["output_tokens"]),
    },
  };
}