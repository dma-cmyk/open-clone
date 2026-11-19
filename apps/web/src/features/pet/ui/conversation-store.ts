// 会話の履歴（sessionStorage。最大 40 件）。
//
// 保存するのは表示に要る形（`PetEntry`）。中継へ送るときは `entriesToMessages()` で
// 契約の `PetMessage` に直す（確認カード・注意書きは送らない）。
// タブを閉じると消える。「会話を消す」で明示的に消せる。
//
// 読み直しでは形を検証する（古い版・壊れた JSON・別タブの書きかけで落ちないように）。
// 決定していない確認カードは「取り消し」として復元する（押せないカードを残さない）。

import { z } from "zod";
import type { PetConfirmRequest, PetToolResult } from "../contract";
import type { PetMessage, PetToolCall } from "shared";

export const PET_CONVERSATION_KEY = "oc.pet.chat.v1";
export const PET_CONVERSATION_MAX = 40;

interface EntryBase {
  key: string;
  at: number;
}

export type PetEntry =
  | ({ role: "user"; content: string } & EntryBase)
  | ({ role: "assistant"; content: string | null; toolCalls: PetToolCall[] } & EntryBase)
  | ({
      role: "tool";
      toolCallId: string;
      name: string;
      label: string;
      content: string;
      result: PetToolResult;
    } & EntryBase)
  | ({
      role: "confirm";
      request: PetConfirmRequest;
      decision: "approved" | "canceled" | null;
    } & EntryBase)
  | ({ role: "notice"; text: string; tone: "info" | "error" } & EntryBase);

/** 表示に要る項目（確認カード・注意書き）。中継には送らない。 */
export type PetEntryRole = PetEntry["role"];

let counter = 0;

/** 並び順を保つためのキー（同じミリ秒に複数作っても衝突しない）。 */
export function newEntryKey(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function appendEntry(entries: PetEntry[], entry: PetEntry): PetEntry[] {
  const next = [...entries, entry];
  if (next.length <= PET_CONVERSATION_MAX) return next;
  let trimmed = next.slice(next.length - PET_CONVERSATION_MAX);
  // 履歴の先頭がツールの結果だけになると、対応する assistant が消えて読めなくなる。
  while (trimmed.length > 0 && trimmed[0]?.role === "tool") {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

/** 中継へ送るメッセージ列（user / assistant / tool だけ）。 */
export function entriesToMessages(entries: PetEntry[]): PetMessage[] {
  const messages: PetMessage[] = [];
  for (const entry of entries) {
    if (entry.role === "user") {
      messages.push({ role: "user", content: entry.content });
    } else if (entry.role === "assistant") {
      messages.push({
        role: "assistant",
        content: entry.content,
        ...(entry.toolCalls.length > 0 ? { toolCalls: entry.toolCalls } : {}),
      });
    } else if (entry.role === "tool") {
      messages.push({
        role: "tool",
        toolCallId: entry.toolCallId,
        name: entry.name,
        content: entry.content,
      });
    }
  }
  return messages;
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

const toolResultSchema = z
  .union([
    z.object({ ok: z.literal(true), data: z.unknown() }),
    z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
  ])
  .transform((value): PetToolResult => (value.ok ? { ok: true, data: value.data } : value));

const confirmRequestSchema = z.object({
  title: z.string(),
  details: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  danger: z.boolean().optional(),
  turnstile: z.boolean().optional(),
});

const entryBase = { key: z.string().min(1), at: z.number() };

/** 保存された会話の 1 件。形が合わない項目は読み直しで捨てる。 */
const entrySchema = z.discriminatedUnion("role", [
  z.object({ ...entryBase, role: z.literal("user"), content: z.string() }),
  z.object({
    ...entryBase,
    role: z.literal("assistant"),
    content: z.string().nullable(),
    toolCalls: z.array(toolCallSchema).default([]),
  }),
  z.object({
    ...entryBase,
    role: z.literal("tool"),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    label: z.string(),
    content: z.string(),
    result: toolResultSchema,
  }),
  z.object({
    ...entryBase,
    role: z.literal("confirm"),
    request: confirmRequestSchema,
    decision: z.union([z.literal("approved"), z.literal("canceled"), z.null()]),
  }),
  z.object({ ...entryBase, role: z.literal("notice"), text: z.string(), tone: z.enum(["info", "error"]) }),
]);

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadEntries(): PetEntry[] {
  const raw = storage()?.getItem(PET_CONVERSATION_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: PetEntry[] = [];
  for (const item of parsed) {
    const result = entrySchema.safeParse(item);
    if (!result.success) continue;
    const entry = result.data;
    // 決定していない確認カードは、読み直した時点で押せないので「取り消し」として残す。
    entries.push(entry.role === "confirm" && entry.decision === null ? { ...entry, decision: "canceled" } : entry);
  }
  return entries;
}

/** 保存する（注意書きは残さない。確認カードは決定済みだけ残す）。 */
export function saveEntries(entries: PetEntry[]): void {
  const persistable = entries.filter((entry) => entry.role !== "notice" && !(entry.role === "confirm" && entry.decision === null));
  try {
    storage()?.setItem(PET_CONVERSATION_KEY, JSON.stringify(persistable));
  } catch {
    /* 容量不足などで保存できなくても会話は続けられる */
  }
}

export function clearEntries(): void {
  try {
    storage()?.removeItem(PET_CONVERSATION_KEY);
  } catch {
    /* 無視 */
  }
}