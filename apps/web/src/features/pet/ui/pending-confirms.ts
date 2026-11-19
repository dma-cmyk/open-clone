// 確認カードの「待っている返事」を複数持つ（同じ応答に書く操作が複数あるとき、止めるですべて取り消す）。
//
// 1 枚ずつ順に出るカードでも、止める・画面の破棄が「今出ているカード」と「これから出るカード」の
// すき間で起きると、待ちが宙に浮く。ここで全部まとめて解決する。

import type { PetApproval } from "../contract";

export type PetConfirmResolver = (approval: PetApproval | null) => void;

export interface PendingConfirms {
  add(key: string, resolve: PetConfirmResolver): void;
  /** 決定できたら true（もう待っていなかったら false）。 */
  decide(key: string, approval: PetApproval | null): boolean;
  /** 待っているカードをすべて「取り消し」で解決し、その key を返す。 */
  cancelAll(): string[];
  size(): number;
}

export function createPendingConfirms(): PendingConfirms {
  const waiters = new Map<string, PetConfirmResolver>();

  return {
    add(key, resolve) {
      waiters.set(key, resolve);
    },
    decide(key, approval) {
      const resolve = waiters.get(key);
      if (!resolve) return false;
      waiters.delete(key);
      resolve(approval);
      return true;
    },
    cancelAll() {
      const keys = [...waiters.keys()];
      for (const [key, resolve] of waiters) {
        waiters.delete(key);
        resolve(null);
      }
      return keys;
    },
    size() {
      return waiters.size;
    },
  };
}