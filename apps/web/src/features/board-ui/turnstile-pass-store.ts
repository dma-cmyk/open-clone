"use client";

// 板ごとの「ロボット確認済み（省略可）」状態を、同じ画面の複数の部品で共有する。
// つぶやきで初回確認が成功したとき、レスフォームのウィジェットも消えるようにするため
// （レビュー 82 / R82-04）。値はサーバー（GET /v1/boards/:slug/turnstile）が正。

import { useSyncExternalStore } from "react";

export interface TurnstilePass {
  passed: boolean;
  expiresAt: number | null;
}

const entries = new Map<string, TurnstilePass>();
const listeners = new Set<() => void>();
// useSyncExternalStore のスナップショットは参照が安定している必要がある。
const EMPTY: TurnstilePass = { passed: false, expiresAt: null };

function emit(): void {
  for (const listener of listeners) listener();
}

export function getTurnstilePass(slug: string): TurnstilePass {
  return entries.get(slug) ?? EMPTY;
}

export function setTurnstilePass(slug: string, value: TurnstilePass): void {
  const current = entries.get(slug);
  if (current && current.passed === value.passed && current.expiresAt === value.expiresAt) return;
  entries.set(slug, value);
  emit();
}

export function subscribeTurnstilePass(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その板の確認済み状態（購読）。 */
export function useTurnstilePass(slug: string): TurnstilePass {
  return useSyncExternalStore(
    subscribeTurnstilePass,
    () => getTurnstilePass(slug),
    () => EMPTY,
  );
}
