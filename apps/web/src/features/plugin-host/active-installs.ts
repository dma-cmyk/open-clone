"use client";

// ページ単位で「適用中プラグイン（/plugins/active）」を共有する小さなストア。
//
// スレ画面はレス 1 件ごとに post-actions スロットを置く（最大 1000 件）。
// スロットごとに fetch と 60 秒の再取得タイマーを持つと、同時リクエストと
// 1000 本の setInterval になる。条件（板・スレ）ごとに 1 エントリへまとめ、
// 取得は 1 回・再取得タイマーも 1 本にする。api.ts の loadActiveInstalls にも
// 5 秒のメモ化があるが、ここでは購読者が増減しても結果を保持する。

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { PluginActiveInstall } from "shared";
import { loadActiveInstalls, onActiveInstallsInvalidated } from "./api";

export interface ActiveInstallsParams {
  boardId?: number;
  boardSlug?: string;
  threadId?: number;
}

const REFRESH_MS = 60_000;
const EMPTY: PluginActiveInstall[] = [];

interface Entry {
  params: ActiveInstallsParams;
  items: PluginActiveInstall[];
  version: number;
  fetching: boolean;
  lastFetchAt: number;
  listeners: Set<() => void>;
  timer: number | null;
}

const entries = new Map<string, Entry>();

function keyOf(params: ActiveInstallsParams): string {
  return JSON.stringify([params.boardId ?? null, params.boardSlug ?? null, params.threadId ?? null]);
}

function entryOf(params: ActiveInstallsParams): Entry {
  const key = keyOf(params);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      params,
      items: EMPTY,
      version: 0,
      fetching: false,
      lastFetchAt: 0,
      listeners: new Set(),
      timer: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

function notify(entry: Entry, items: PluginActiveInstall[]): void {
  entry.items = items;
  entry.version += 1;
  for (const listener of entry.listeners) listener();
}

function refresh(entry: Entry): void {
  // 初回マウントが 1000 件同時でも、進行中の取得は 1 本にまとめる。
  if (entry.fetching) return;
  entry.fetching = true;
  loadActiveInstalls(entry.params)
    .then((response) => {
      entry.lastFetchAt = Date.now();
      notify(
        entry,
        response.items.filter((install) => !install.stopped),
      );
    })
    .catch(() => {
      // 未ログイン・API 未実装・ネットワーク失敗時はスロットを空にする（画面は壊さない）。
      entry.lastFetchAt = Date.now();
      if (entry.items.length > 0) notify(entry, EMPTY);
    })
    .finally(() => {
      entry.fetching = false;
    });
}

function subscribe(entry: Entry, listener: () => void): () => void {
  entry.listeners.add(listener);
  // 初回と、前回取得から間が空いたときだけ取り直す。スクロールで後から現れた
  // スロット（遅延起動）が購読しても `/plugins/active` を増やさない。
  if (entry.lastFetchAt === 0 || Date.now() - entry.lastFetchAt > REFRESH_MS) refresh(entry);
  if (entry.timer === null) {
    entry.timer = window.setInterval(() => refresh(entry), REFRESH_MS);
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.timer !== null) {
      window.clearInterval(entry.timer);
      entry.timer = null;
    }
  };
}

// 導入・停止・版の更新直後（invalidateActiveInstalls）に取り直す。
if (typeof window !== "undefined") {
  onActiveInstallsInvalidated(() => {
    for (const entry of entries.values()) refresh(entry);
  });
}

/**
 * このページに適用されるプラグイン（停止済みを除く）。
 * 同じ条件（板・スレ）の全スロットで 1 つの取得結果を共有する。
 */
export function useActiveInstalls(params: ActiveInstallsParams = {}): PluginActiveInstall[] {
  const { boardId, boardSlug, threadId } = params;
  const key = keyOf({ boardId, boardSlug, threadId });
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const subscribeKey = useCallback(
    (listener: () => void) => subscribe(entryOf(paramsRef.current), listener),
    // key が同じなら boardId/boardSlug/threadId も同じ（key はその 3 つで作る）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const version = useSyncExternalStore(
    subscribeKey,
    () => entries.get(key)?.version ?? 0,
    () => 0,
  );

  // ストアの更新（version の増加）で items が差し替わる。再レンダーの契機は version
  // だけなので、依存に含めて読み直す（外すと更新が画面へ届かない）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => entries.get(key)?.items ?? EMPTY, [key, version]);
}

/** テスト用: ページ遷移をまたぐ保持を捨てる。 */
export function resetActiveInstallsStore(): void {
  for (const entry of entries.values()) {
    if (entry.timer !== null) {
      window.clearInterval(entry.timer);
      entry.timer = null;
    }
  }
  entries.clear();
}