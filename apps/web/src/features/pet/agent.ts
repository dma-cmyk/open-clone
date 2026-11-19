// 会話の進行役（設計書 §7「会話の進行」）。
//
// 役目は 1 回の依頼を進めること:
//  1. 中継 API を 1 回呼ぶ（中身は `relay-client.ts`）。
//  2. 返事にツール呼び出しがあれば、読むツールはその場で実行し、結果を JSON にして返す。
//     書くツールは必ず確認カードを出し、「実行」のときだけ走らせる（取り消しは `CANCELED`）。
//  3. 移動（navigate）ツールは、その回の他のツールを全部済ませてから、履歴を保存した後に実行する
//     （フルページ遷移で会話が途切れても残るように）。
//  4. ツールの往復は 1 依頼で 8 回まで。超えたら実行せずに打ち切りを返す。
//  5. ツール結果は JSON にして 8000 文字で切る（長いスレ本文で本文上限を超えないように）。
//
// React に依存しない（単体試験は偽のツールと偽の send で、この流れだけを確かめる）。

import { PET_LIMITS, type PetChatResponse, type PetMessage, type PetToolCall, type PetToolSpec } from "shared";
import type {
  PetApproval,
  PetConfig,
  PetConfirmRequest,
  PetTool,
  PetToolContext,
  PetToolResult,
} from "./contract";
import type { PetChatInput } from "./relay-client";

export const PET_MAX_TOOL_ROUNDS = 8;
export const PET_TOOL_RESULT_MAX_CHARS = 8_000;

export type PetTurnEvent =
  /** AI の返事（ツール呼び出しを含むことがある）。 */
  | { type: "assistant"; content: string | null; toolCalls: PetToolCall[] }
  /** ツールの実行を始めた（画面の「〇〇しています」）。 */
  | { type: "tool_start"; call: PetToolCall; label: string }
  | { type: "tool_end"; call: PetToolCall; label: string; result: PetToolResult }
  /** 確認カードを出す（利用者の返事は `confirm` の戻り値）。 */
  | { type: "confirm"; request: PetConfirmRequest };

export interface PetTurnInput {
  config: PetConfig;
  system: string;
  tools: PetTool[];
  ctx: PetToolContext;
  /** ここまでの会話（今回の利用者の発言を含む）。 */
  messages: PetMessage[];
  send(input: PetChatInput, options: { signal: AbortSignal }): Promise<PetChatResponse>;
  /** 確認カードを出して待つ。`null` は取り消し。 */
  confirm(
    request: PetConfirmRequest,
    tool: { call: PetToolCall; name: string },
  ): Promise<PetApproval | null>;
  /** 会話の保存（ツールの結果を返す前・移動の前に必ず呼ばれる）。 */
  onMessages?(messages: PetMessage[]): void;
  onEvent?(event: PetTurnEvent): void;
  maxRounds?: number;
}

export interface PetTurnResult {
  messages: PetMessage[];
  /** 最後の AI の文章（無ければ null）。 */
  content: string | null;
  /** ツールの往復の上限で打ち切った。 */
  limitReached: boolean;
  /** 移動ツールを実行した（画面が変わる）。 */
  navigated: boolean;
}

/** ツールを中継 API の `tools` に渡す形にする。 */
export function toToolSpecs(tools: PetTool[]): PetToolSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * ツール結果を AI に返す文字列にする。JSON にして、8000 文字を超えたら切る
 * （サロゲートペアの途中では切らない）。
 */
export function toolResultContent(result: PetToolResult): string {
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    json = JSON.stringify({ ok: false, code: "SERIALIZE", error: "結果を文字にできませんでした" });
  }
  if (json.length <= PET_TOOL_RESULT_MAX_CHARS) return json;
  let end = PET_TOOL_RESULT_MAX_CHARS - 1;
  const code = json.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${json.slice(0, end)}…`;
}

/** 引数の JSON 文字列を読む（空は `{}`）。 */
export function parseToolArguments(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "ツールの引数が JSON として読めませんでした。" };
  }
}

function isToolResult(value: PetConfirmRequest | PetToolResult): value is PetToolResult {
  return typeof (value as PetToolResult).ok === "boolean";
}

function clampText(text: string): string {
  return text.length > PET_LIMITS.messageMaxChars ? text.slice(0, PET_LIMITS.messageMaxChars) : text;
}

/**
 * 送信できる形に整える。
 * - 結果の無いツール呼び出し（履歴を切った境目など）は落とす。事業者は「すべての tool_calls に
 *   tool の結果がある」ことを要求するため。
 * - 直前の assistant に対応しない tool メッセージも落とす。
 * - 上限（80 件）を超えたら古いものから落とす（先頭が tool にならないように）。
 */
export function sanitizeMessages(messages: PetMessage[]): PetMessage[] {
  const out: PetMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") {
      out.push({ role: "user", content: clampText(message.content) });
      continue;
    }
    if (message.role !== "assistant") continue;
    const expected = message.toolCalls ?? [];
    const results = new Map<string, PetMessage>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool") {
      const result = messages[cursor];
      if (result && result.role === "tool" && expected.some((call) => call.id === result.toolCallId)) {
        results.set(result.toolCallId, result);
      }
      cursor += 1;
    }
    const calls = expected.filter((call) => results.has(call.id));
    const content = message.content === null ? null : clampText(message.content);
    if (calls.length > 0) {
      out.push({ role: "assistant", content, toolCalls: calls });
      for (const call of calls) {
        const result = results.get(call.id);
        if (result && result.role === "tool") {
          out.push({ role: "tool", toolCallId: result.toolCallId, name: result.name, content: clampText(result.content) });
        }
      }
    } else if (content) {
      out.push({ role: "assistant", content });
    }
    index = cursor - 1;
  }

  const limit = PET_LIMITS.messagesMax;
  let trimmed = out.length > limit ? out.slice(out.length - limit) : out;
  while (trimmed.length > 0 && trimmed[0]?.role === "tool") {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/** ツールを実行する。ツールの例外で会話を止めない（結果として AI に返す）。 */
async function runTool(
  tool: PetTool,
  args: unknown,
  ctx: PetToolContext,
  approval: PetApproval,
): Promise<PetToolResult> {
  try {
    if (tool.kind === "write") {
      return await tool.run(args, ctx, approval);
    }
    return await tool.run(args, ctx);
  } catch (cause) {
    return {
      ok: false,
      code: "TOOL_ERROR",
      error: cause instanceof Error ? cause.message : "ツールの実行に失敗しました。",
    };
  }
}

export async function runPetTurn(input: PetTurnInput): Promise<PetTurnResult> {
  const maxRounds = input.maxRounds ?? PET_MAX_TOOL_ROUNDS;
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const specs = toToolSpecs(input.tools);
  const messages: PetMessage[] = [...input.messages];
  let content: string | null = null;
  let limitReached = false;
  let navigated = false;
  let executed = 0;

  const finishTool = (tool: PetTool, call: PetToolCall, result: PetToolResult): void => {
    messages.push({ role: "tool", toolCallId: call.id, name: tool.name, content: toolResultContent(result) });
    input.onEvent?.({ type: "tool_end", call, label: tool.label, result });
  };

  try {
    for (;;) {
      const response = await input.send(
        { system: input.system, messages: sanitizeMessages(messages), tools: specs },
        { signal: input.ctx.signal },
      );
      content = response.message.content;
      const calls = response.message.toolCalls;

      if (calls.length === 0) {
        if (content) messages.push({ role: "assistant", content: clampText(content) });
        input.onEvent?.({ type: "assistant", content, toolCalls: [] });
        break;
      }
      if (executed >= maxRounds) {
        // 打ち切り。結果を返せないツール呼び出しは履歴に残さない（事業者へ送る形が壊れるため）。
        limitReached = true;
        input.onEvent?.({ type: "assistant", content, toolCalls: [] });
        break;
      }

      messages.push({ role: "assistant", content: content === null ? null : clampText(content), toolCalls: calls });
      input.onEvent?.({ type: "assistant", content, toolCalls: calls });
      executed += 1;

      const navigations: Array<{ call: PetToolCall; tool: PetTool; args: unknown }> = [];
      for (const call of calls) {
        const tool = toolsByName.get(call.name);
        if (!tool) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: toolResultContent({
              ok: false,
              code: "UNKNOWN_TOOL",
              error: `このツール（${call.name}）はありません。`,
            }),
          });
          input.onEvent?.({
            type: "tool_end",
            call,
            label: call.name,
            result: { ok: false, code: "UNKNOWN_TOOL", error: "このツールはありません。" },
          });
          continue;
        }
        const parsed = parseToolArguments(call.arguments);
        if (!parsed.ok) {
          finishTool(tool, call, { ok: false, code: "BAD_ARGUMENTS", error: parsed.error });
          continue;
        }
        if (tool.kind === "navigate") {
          navigations.push({ call, tool, args: parsed.value });
          continue;
        }

        input.onEvent?.({ type: "tool_start", call, label: tool.label });
        if (tool.kind === "write") {
          const prepared = await tool.prepare(parsed.value, input.ctx);
          if (isToolResult(prepared)) {
            finishTool(tool, call, prepared);
            continue;
          }
          input.onEvent?.({ type: "confirm", request: prepared });
          const approval = await input.confirm(prepared, { call, name: tool.name });
          if (!approval) {
            finishTool(tool, call, { ok: false, code: "CANCELED", error: "利用者が取り消しました。" });
            continue;
          }
          finishTool(tool, call, await runTool(tool, parsed.value, input.ctx, approval));
        } else {
          finishTool(tool, call, await runTool(tool, parsed.value, input.ctx, { turnstileToken: null }));
        }
      }

      if (navigations.length > 0) {
        for (const pending of navigations) {
          input.onEvent?.({ type: "tool_start", call: pending.call, label: pending.tool.label });
          finishTool(pending.tool, pending.call, { ok: true, data: { navigated: true } });
        }
        // 移動の前に履歴を残す（移動がフルページ遷移でも会話が続く）。
        input.onMessages?.(messages);
        for (const pending of navigations) {
          await runTool(pending.tool, pending.args, input.ctx, { turnstileToken: null });
        }
        navigated = true;
        break;
      }

      input.onMessages?.(messages);
    }
  } finally {
    input.onMessages?.(messages);
  }

  return { messages, content, limitReached, navigated };
}