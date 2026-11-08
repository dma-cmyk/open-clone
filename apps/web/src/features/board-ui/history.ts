// 書き込み履歴・既読・ブクマ（端末ローカル、open2ch の 300 件上限に準拠）。

import { createLocalStore } from "./storage";

export interface HistoryEntry {
  key: string;
  path: string;
  slug: string;
  threadId?: number;
  title: string;
  boardName?: string;
  at: number;
}

export interface BookmarkEntry extends HistoryEntry {
  unread?: number;
}

export interface HistoryState {
  writes: HistoryEntry[];
  reads: HistoryEntry[];
  bookmarks: BookmarkEntry[];
  positions: Record<string, number>;
}

const MAX_ENTRIES = 300;

export const historyStore = createLocalStore<HistoryState>(
  "oc.history.v1",
  { writes: [], reads: [], bookmarks: [], positions: {} },
  {
    merge(stored, fallback) {
      const value = (stored ?? {}) as Partial<HistoryState>;
      return {
        writes: Array.isArray(value.writes) ? value.writes : fallback.writes,
        reads: Array.isArray(value.reads) ? value.reads : fallback.reads,
        bookmarks: Array.isArray(value.bookmarks) ? value.bookmarks : fallback.bookmarks,
        positions: value.positions && typeof value.positions === "object" ? value.positions : {},
      };
    },
  },
);

function upsert(list: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...list.filter((item) => item.key !== entry.key)];
  return next.slice(0, MAX_ENTRIES);
}

export function recordWrite(entry: Omit<HistoryEntry, "at">): void {
  historyStore.set((prev) => ({ ...prev, writes: upsert(prev.writes, { ...entry, at: Date.now() }) }));
}

export function recordRead(entry: Omit<HistoryEntry, "at">): void {
  historyStore.set((prev) => ({ ...prev, reads: upsert(prev.reads, { ...entry, at: Date.now() }) }));
}

export function toggleBookmark(entry: Omit<HistoryEntry, "at">): boolean {
  let added = false;
  historyStore.set((prev) => {
    const exists = prev.bookmarks.some((item) => item.key === entry.key);
    if (exists) {
      return { ...prev, bookmarks: prev.bookmarks.filter((item) => item.key !== entry.key) };
    }
    added = true;
    return {
      ...prev,
      bookmarks: [{ ...entry, at: Date.now() }, ...prev.bookmarks].slice(0, MAX_ENTRIES),
    };
  });
  return added;
}

export function isBookmarked(key: string): boolean {
  return historyStore.get().bookmarks.some((item) => item.key === key);
}

export function setLastRead(key: string, num: number): void {
  historyStore.set((prev) => {
    if ((prev.positions[key] ?? 0) >= num) {
      return prev;
    }
    return { ...prev, positions: { ...prev.positions, [key]: num } };
  });
}

export function getLastRead(key: string): number {
  return historyStore.get().positions[key] ?? 0;
}

export function clearHistory(): void {
  historyStore.set({ writes: [], reads: [], bookmarks: [], positions: {} });
}