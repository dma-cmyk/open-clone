// 個人設定（NG・表示・新着・kome）。open2ch 同様、端末ローカルが正本（DESIGN §6.2）。
// サーバーには保存しない（アカウント同期は将来 WP6 の設定 API で拡張可能）。

import { createLocalStore } from "./storage";
import type { Post } from "./types";

export type NgMode = "confirm" | "hide" | "ignore";

export interface NgConfig {
  mode: NgMode;
  words: string[];
  ids: string[];
  names: string[];
  trips: string[];
  /** スレタイ無視（板トップの左スワイプ / 「無視」ボタン） */
  threads: string[];
}

export interface UserSettings {
  ng: NgConfig;
  display: {
    fontSize: number;
    showImages: boolean;
    aa: boolean;
    reverse: boolean;
  };
  behavior: {
    autoScroll: boolean;
    sound: boolean;
    readAloud: boolean;
    kome: boolean;
    floatForm: boolean;
  };
  kome: {
    size: number;
    speed: number;
    opacity: number;
    color: string;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  ng: { mode: "confirm", words: [], ids: [], names: [], trips: [], threads: [] },
  display: { fontSize: 15, showImages: true, aa: false, reverse: false },
  behavior: { autoScroll: true, sound: false, readAloud: false, kome: false, floatForm: false },
  kome: { size: 22, speed: 9, opacity: 0.95, color: "#ffffff" },
};

export const settingsStore = createLocalStore<UserSettings>("oc.settings.v1", DEFAULT_SETTINGS, {
  merge(stored, fallback) {
    const value = (stored ?? {}) as Partial<UserSettings>;
    return {
      ng: { ...fallback.ng, ...(value.ng ?? {}), threads: value.ng?.threads ?? [] },
      display: { ...fallback.display, ...(value.display ?? {}) },
      behavior: { ...fallback.behavior, ...(value.behavior ?? {}) },
      kome: { ...fallback.kome, ...(value.kome ?? {}) },
    };
  },
});

export interface NgVerdict {
  hit: boolean;
  reason?: string;
}

const SPECIAL: Record<string, (post: Post) => boolean> = {
  ":url": (post) => /https?:\/\//.test(post.body),
  ":image": (post) => (post.attachments?.length ?? 0) > 0 || /https?:\/\/\S+\.(png|jpe?g|gif|webp)/i.test(post.body),
  ":kome": (post) => post.kind === "kome",
  ":ai": (post) => Boolean(post.aiAgent),
};

/** スレタイ NG（板一覧で左スワイプ/無視）。部分一致・大小無視。 */
export function matchNgThread(title: string, ng: NgConfig): string | null {
  const lower = title.toLowerCase();
  for (const token of ng.threads) {
    const needle = token.trim().toLowerCase();
    if (needle && lower.includes(needle)) {
      return token;
    }
  }
  return null;
}

/** NG 判定。words は部分一致（大小無視）、ids/trips は完全一致、names は部分一致。 */
export function matchNg(post: Post, ng: NgConfig): NgVerdict {
  if (post.isOp) {
    // スレ主（>>1）は NG 対象外（スレ自体を開いている以上、文脈が失われるため）
    return { hit: false };
  }
  const body = post.body.toLowerCase();
  for (const word of ng.words) {
    const token = word.trim();
    if (!token) continue;
    const special = SPECIAL[token.toLowerCase()];
    if (special) {
      if (special(post)) return { hit: true, reason: token };
      continue;
    }
    if (body.includes(token.toLowerCase())) {
      return { hit: true, reason: token };
    }
  }
  if (post.idHash && ng.ids.some((id) => id.trim().toLowerCase() === post.idHash?.toLowerCase())) {
    return { hit: true, reason: `ID:${post.idHash}` };
  }
  if (post.trip && ng.trips.some((trip) => trip.trim() === post.trip)) {
    return { hit: true, reason: post.trip };
  }
  const name = post.name.toLowerCase();
  for (const ngName of ng.names) {
    const token = ngName.trim().toLowerCase();
    if (token && name.includes(token)) {
      return { hit: true, reason: ngName };
    }
  }
  return { hit: false };
}

export function addNgEntry(kind: keyof Omit<NgConfig, "mode">, value: string): void {
  const token = value.trim();
  if (!token) return;
  settingsStore.set((prev) => {
    const list = prev.ng[kind];
    if (list.includes(token)) return prev;
    return { ...prev, ng: { ...prev.ng, [kind]: [...list, token] } };
  });
}

export function removeNgEntry(kind: keyof Omit<NgConfig, "mode">, value: string): void {
  settingsStore.set((prev) => ({
    ...prev,
    ng: { ...prev.ng, [kind]: prev.ng[kind].filter((item) => item !== value) },
  }));
}

/** 新着音（WebAudio の短いビープ。外部素材を使わない）。 */
export function playNewPostSound(): void {
  if (typeof window === "undefined") return;
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.2);
    oscillator.onended = () => void context.close();
  } catch {
    // 音声が使えない環境では黙って諦める
  }
}

/** 読み上げ（Web Speech API。クライアントのみ）。 */
export function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 200));
    utterance.lang = "ja-JP";
    utterance.rate = 1.15;
    window.speechSynthesis.speak(utterance);
  } catch {
    // 非対応環境は無視
  }
}