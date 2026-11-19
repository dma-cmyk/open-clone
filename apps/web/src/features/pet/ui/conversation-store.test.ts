// 会話の履歴（conversation-store.ts）の単体試験。

import { beforeEach, describe, expect, it } from "vitest";
import {
  PET_CONVERSATION_KEY,
  PET_CONVERSATION_MAX,
  appendEntry,
  clearEntries,
  entriesToMessages,
  loadEntries,
  newEntryKey,
  saveEntries,
  type PetEntry,
} from "./conversation-store";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const session = new MemoryStorage();
const globals = globalThis as unknown as { window?: unknown };

beforeEach(() => {
  session.clear();
  globals.window = { sessionStorage: session };
});

function user(content: string): PetEntry {
  return { key: newEntryKey(), at: Date.now(), role: "user", content };
}

describe("履歴の件数", () => {
  it("40 件を超えたら古いものから落とし、先頭にツールの結果を残さない", () => {
    let entries: PetEntry[] = [];
    entries = appendEntry(entries, {
      key: newEntryKey(),
      at: 1,
      role: "assistant",
      content: null,
      toolCalls: [{ id: "c1", name: "peek", arguments: "{}" }],
    });
    entries = appendEntry(entries, {
      key: newEntryKey(),
      at: 2,
      role: "tool",
      toolCallId: "c1",
      name: "peek",
      label: "確認しています",
      content: "{\"ok\":true}",
      result: { ok: true, data: {} },
    });
    for (let index = 0; index < PET_CONVERSATION_MAX; index += 1) {
      entries = appendEntry(entries, user(`発言 ${index}`));
    }
    expect(entries).toHaveLength(PET_CONVERSATION_MAX);
    expect(entries[0]?.role).toBe("user");
  });
});

describe("中継へ送る形", () => {
  it("user / assistant / tool だけを PetMessage にする", () => {
    const entries: PetEntry[] = [
      user("教えて"),
      { key: newEntryKey(), at: 2, role: "assistant", content: null, toolCalls: [{ id: "c1", name: "peek", arguments: "{}" }] },
      {
        key: newEntryKey(),
        at: 3,
        role: "tool",
        toolCallId: "c1",
        name: "peek",
        label: "確認しています",
        content: "{\"ok\":true}",
        result: { ok: true, data: {} },
      },
      { key: newEntryKey(), at: 4, role: "assistant", content: "3 件です", toolCalls: [] },
      { key: newEntryKey(), at: 5, role: "notice", text: "止めました。", tone: "info" },
      {
        key: newEntryKey(),
        at: 6,
        role: "confirm",
        request: { title: "書き込みます", details: [] },
        decision: "approved",
      },
    ];
    expect(entriesToMessages(entries)).toEqual([
      { role: "user", content: "教えて" },
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "peek", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", name: "peek", content: "{\"ok\":true}" },
      { role: "assistant", content: "3 件です" },
    ]);
  });
});

describe("保存と読み直し", () => {
  it("注意書きと未決定の確認カードは保存しない", () => {
    const entries: PetEntry[] = [
      user("こんにちは"),
      { key: newEntryKey(), at: 2, role: "notice", text: "エラー", tone: "error" },
      { key: newEntryKey(), at: 3, role: "confirm", request: { title: "確認", details: [] }, decision: null },
    ];
    saveEntries(entries);
    const stored = JSON.parse(session.getItem(PET_CONVERSATION_KEY) ?? "[]") as unknown[];
    expect(stored).toHaveLength(1);
    expect(loadEntries()).toHaveLength(1);
  });

  it("決定済みの確認カードは読み直しても決定のまま", () => {
    saveEntries([
      { key: newEntryKey(), at: 1, role: "confirm", request: { title: "確認", details: [] }, decision: "approved" },
    ]);
    const loaded = loadEntries();
    expect(loaded[0]).toMatchObject({ role: "confirm", decision: "approved" });
  });

  it("壊れた保存値は空として扱う", () => {
    session.setItem(PET_CONVERSATION_KEY, "{broken");
    expect(loadEntries()).toEqual([]);
    clearEntries();
    expect(session.getItem(PET_CONVERSATION_KEY)).toBeNull();
  });
});