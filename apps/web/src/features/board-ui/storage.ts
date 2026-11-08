// localStorage 永続ストア。useSyncExternalStore で複数コンポーネントに配信する。
// サーバー側では常に fallback を返し、ハイドレーション後に実値へ切り替わる。

import { useSyncExternalStore } from "react";

export interface LocalStore<T> {
  key: string;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  update(partial: Partial<T>): void;
  subscribe(listener: () => void): () => void;
  use(): T;
  reset(): void;
}

interface StoreOptions<T> {
  /** 保存済み値を現在のスキーマへ寄せる（欠損キーの補完など）。 */
  merge?: (stored: unknown, fallback: T) => T;
}

export function createLocalStore<T extends object>(
  key: string,
  fallback: T,
  options: StoreOptions<T> = {},
): LocalStore<T> {
  const listeners = new Set<() => void>();
  let cache: T | null = null;

  const read = (): T => {
    if (typeof window === "undefined") {
      return fallback;
    }
    if (cache) {
      return cache;
    }
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        cache = fallback;
      } else {
        const parsed = JSON.parse(raw) as unknown;
        cache = options.merge ? options.merge(parsed, fallback) : ({ ...fallback, ...(parsed as object) } as T);
      }
    } catch {
      cache = fallback;
    }
    return cache;
  };

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const write = (value: T) => {
    cache = value;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // 容量超過などは無視（UI は継続できる）
      }
    }
    emit();
  };

  return {
    key,
    get: read,
    set(next) {
      const prev = read();
      write(typeof next === "function" ? (next as (prev: T) => T)(prev) : next);
    },
    update(partial) {
      write({ ...read(), ...partial });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    use() {
      return useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        read,
        () => fallback,
      );
    },
    reset() {
      write(fallback);
    },
  };
}

/** 別タブの更新を取り込む（同一起源の他タブで設定が変わった場合）。 */
export function syncAcrossTabs(store: LocalStore<object>): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const handler = (event: StorageEvent) => {
    if (event.key === store.key) {
      store.set(store.get());
    }
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}