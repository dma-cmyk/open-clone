import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStore, syncAcrossTabs } from "./storage";

interface Draft {
  ng: string[];
}

/** node 環境で localStorage と storage イベントを模す（別タブ同期の検証用）。 */
function fakeWindow() {
  const data = new Map<string, string>();
  const listeners = new Set<(event: { key: string | null }) => void>();
  const win = {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
    addEventListener: (name: string, handler: (event: { key: string | null }) => void) => {
      if (name === "storage") listeners.add(handler);
    },
    removeEventListener: (name: string, handler: (event: { key: string | null }) => void) => {
      if (name === "storage") listeners.delete(handler);
    },
  };
  return {
    win,
    data,
    emit(key: string | null) {
      for (const listener of listeners) listener({ key });
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncAcrossTabs", () => {
  it("別タブが保存した値を読み直し、購読者へ配る", () => {
    const { win, data, emit, listenerCount } = fakeWindow();
    vi.stubGlobal("window", win);
    const store = createLocalStore<Draft>("oc.test.v1", { ng: [] }, {
      merge: (stored, fallback) => ({ ...fallback, ...(stored as Partial<Draft>) }),
    });
    expect(store.get().ng).toEqual([]);

    const seen: Draft[] = [];
    store.subscribe(() => seen.push(store.get()));
    const stop = syncAcrossTabs(store);
    expect(listenerCount()).toBe(1);

    // 別タブが書き込んだ状態にして storage イベントを送る
    data.set("oc.test.v1", JSON.stringify({ ng: ["別タブ"] }));
    emit("oc.test.v1");
    expect(seen.at(-1)?.ng).toEqual(["別タブ"]);

    // 関係ないキーのイベントでは読み直さない
    emit("other.key");
    expect(seen).toHaveLength(1);

    stop();
    expect(listenerCount()).toBe(0);
  });
});