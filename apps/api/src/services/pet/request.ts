// ペット中継の要求組み立て（契約 → 事業者の形式）。
//
// ブラウザの要求本文をそのまま転送しない。`PetChatRequest` から openai（Chat Completions）/
// anthropic（Messages API）の要求を作り直す。これにより中継が汎用の転送口にならない。
// ここにはネットワークも DB も無い（単体試験で形を固定する）。

import {
  ApiError,
  PET_LIMITS,
  type PetChatRequest,
  type PetMessage,
  type PetProtocol,
  type PetProviderId,
  type PetToolCall,
} from "shared";

export interface PetProviderRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface BuildInput {
  provider: PetProviderId;
  protocol: PetProtocol;
  /** 解決済みの送信先（プリセット / custom / E2E 差し替えの後）。 */
  endpoint: string;
  apiKey: string;
  /** openrouter の HTTP-Referer に載せるサイト URL。 */
  siteUrl: string;
  request: PetChatRequest;
}

const USER_AGENT = "open-clone-pet/1.0";

/** openai 形式の messages（system → 会話 → tool の順序をそのまま保つ）。 */
function openAiMessages(request: PetChatRequest): unknown[] {
  const messages: unknown[] = [];
  if (request.system.length > 0) messages.push({ role: "system", content: request.system });
  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      messages.push({
        role: "assistant",
        content: message.content,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
      continue;
    }
    // tool 結果は tool_call_id で assistant の呼び出しと対応させる（name は OpenAI では送らない）。
    messages.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
  }
  return messages;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

/** 引数は JSON 文字列。読めない履歴は事業者へ送る前に 400 にする（設計 §5）。 */
function parseToolArguments(call: PetToolCall): unknown {
  try {
    return JSON.parse(call.arguments);
  } catch {
    throw ApiError.validation("ツール呼び出しの引数が JSON として不正です");
  }
}

/**
 * anthropic 形式の messages。
 * - system は最上位（`buildPetProviderRequest` が入れる）なのでここには出さない。
 * - assistant のツール呼び出しは `tool_use` ブロック。
 * - tool 結果は user の `tool_result` ブロック。**連続する tool は 1 つの user メッセージにまとめる**
 *   （Anthropic は同じ役割の連続を許さず、tool 結果は user 側に置く決まりのため）。
 */
export function toAnthropicMessages(messages: readonly PetMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (message.content !== null && message.content.length > 0) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parseToolArguments(call) });
      }
      // Anthropic は空の content 配列を受け付けない。
      if (blocks.length === 0) blocks.push({ type: "text", text: "" });
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    const block: AnthropicBlock = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    };
    const last = out[out.length - 1];
    if (last && last.role === "user") {
      const blocks: AnthropicBlock[] =
        typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      blocks.push(block);
      last.content = blocks;
      continue;
    }
    out.push({ role: "user", content: [block] });
  }
  return out;
}

function openAiBody(request: PetChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: request.model, messages: openAiMessages(request) };
  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;
  return body;
}

function anthropicBody(request: PetChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    // anthropic は max_tokens 必須。未指定なら契約の既定値を使う。
    max_tokens: request.maxTokens ?? PET_LIMITS.maxTokensDefault,
    messages: toAnthropicMessages(request.messages),
  };
  if (request.system.length > 0) body["system"] = request.system;
  if (request.tools.length > 0) {
    body["tools"] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return body;
}

/** 契約から事業者ごとの要求（送信先・ヘッダー・本文）を組み立てる。 */
export function buildPetProviderRequest(input: BuildInput): PetProviderRequest {
  const { provider, protocol, endpoint, apiKey, siteUrl, request } = input;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
  };
  if (protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return { endpoint, headers, body: anthropicBody(request) };
  }
  headers["authorization"] = `Bearer ${apiKey}`;
  if (provider === "openrouter") {
    if (siteUrl.length > 0) headers["HTTP-Referer"] = siteUrl;
    headers["X-Title"] = "open-clone";
  }
  return { endpoint, headers, body: openAiBody(request) };
}