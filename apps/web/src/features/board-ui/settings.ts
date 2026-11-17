// 個人設定（NG・表示・新着・つぶやき）。open2ch 同様、端末ローカルが正本（DESIGN §6.2）。
// サーバーには保存しない（アカウント同期は将来 WP6 の設定 API で拡張可能）。

import { createLocalStore, syncAcrossTabs } from "./storage";
import type { Post } from "./types";

export type NgMode = "confirm" | "hide" | "ignore";

/** 文字列の一覧で持つ NG の種類。 */
export type NgListKind = "words" | "ids" | "names" | "trips" | "threads";

/** スレ ID 単位の無視。タイトルではなく「そのスレだけ」を隠す。 */
export interface IgnoredThread {
  id: number;
  /** 板スラッグ（スレへのリンクに使う） */
  board: string;
  title: string;
  /** 追加日時（epoch ミリ秒） */
  at: number;
}

export interface NgConfig {
  mode: NgMode;
  words: string[];
  ids: string[];
  names: string[];
  trips: string[];
  /** スレタイ無視（部分一致）。旧方式の保存値をそのまま活かすため残す。 */
  threads: string[];
  /** スレ ID 単位の無視（新方式） */
  ignoredThreads: IgnoredThread[];
  /** 文字列項目の追加日時（`種類:値` をキー）。旧データには無い＝追加日不明。 */
  addedAt: Record<string, number>;
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
    tsubuyaki: boolean;
    floatForm: boolean;
  };
  tsubuyaki: {
    size: number;
    speed: number;
    opacity: number;
    color: string;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  ng: {
    mode: "confirm",
    words: [],
    ids: [],
    names: [],
    trips: [],
    threads: [],
    ignoredThreads: [],
    addedAt: {},
  },
  display: { fontSize: 15, showImages: true, aa: false, reverse: false },
  behavior: { autoScroll: true, sound: false, readAloud: false, tsubuyaki: false, floatForm: false },
  tsubuyaki: { size: 22, speed: 9, opacity: 0.95, color: "#ffffff" },
};

/** 個人設定の localStorage キー（e2e も参照する）。 */
export const SETTINGS_STORAGE_KEY = "oc.settings.v1";

/**
 * 旧名 kome で保存された端末設定を新しい名前に移す（純関数）。
 * 保存済みの利用者設定を失わないための移行で、旧キーは移行後に残さない。
 * - `behavior.kome` → `behavior.tsubuyaki`
 * - トップレベル `kome`（文字サイズ等）→ `tsubuyaki`
 * - NG の特殊指定 `:kome` → `:tsubuyaki`
 */
export function migrateLegacySettings(stored: unknown): unknown {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return stored;
  const source = stored as Record<string, unknown>;
  const next: Record<string, unknown> = { ...source };
  let changed = false;

  const behaviorRaw = source["behavior"];
  if (typeof behaviorRaw === "object" && behaviorRaw !== null && !Array.isArray(behaviorRaw)) {
    const behavior = { ...(behaviorRaw as Record<string, unknown>) };
    if ("kome" in behavior) {
      if (behavior["tsubuyaki"] === undefined) behavior["tsubuyaki"] = behavior["kome"];
      delete behavior["kome"];
      next["behavior"] = behavior;
      changed = true;
    }
  }

  if ("kome" in next) {
    if (next["tsubuyaki"] === undefined) next["tsubuyaki"] = next["kome"];
    delete next["kome"];
    changed = true;
  }

  const ngRaw = source["ng"];
  if (typeof ngRaw === "object" && ngRaw !== null && !Array.isArray(ngRaw)) {
    const ng = { ...(ngRaw as Record<string, unknown>) };
    const words = ng["words"];
    if (Array.isArray(words)) {
      let mapped = false;
      const renamed = words.map((word) => {
        if (typeof word === "string" && word.trim().toLowerCase() === ":kome") {
          mapped = true;
          return ":tsubuyaki";
        }
        return word;
      });
      if (mapped) {
        const seen = new Set<unknown>();
        ng["words"] = renamed.filter((word) => {
          if (seen.has(word)) return false;
          seen.add(word);
          return true;
        });
        next["ng"] = ng;
        changed = true;
      }
    }
  }

  return changed ? next : stored;
}

/** 端末に保存済みの旧設定を新しい名前に書き戻す（ブラウザのみ）。 */
export function migrateSettingsStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    const migrated = migrateLegacySettings(parsed);
    if (migrated !== parsed) {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(migrated));
    }
  } catch {
    // 壊れた JSON は store の merge が既定値で吸収する
  }
}

// モジュール読み込み時（ブラウザ）に旧キーを新しい名前に移して保存し直す。
migrateSettingsStorage();

const NG_MODES: readonly NgMode[] = ["confirm", "hide", "ignore"];

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** `ng.ignoredThreads` の保存値を安全な形へ寄せる（壊れた値・重複 ID は捨てる）。 */
function normalizeIgnoredThreads(raw: unknown): IgnoredThread[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const result: IgnoredThread[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = Number(record["id"]);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    const at = Number(record["at"]);
    result.push({
      id,
      board: typeof record["board"] === "string" ? record["board"] : "",
      title: typeof record["title"] === "string" ? record["title"] : "",
      at: Number.isFinite(at) ? at : 0,
    });
  }
  return result;
}

function normalizeAddedAt(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

/** 保存値を現在のスキーマへ寄せる（旧データの `ng.threads` もそのまま残す）。 */
export function mergeSettings(stored: unknown, fallback: UserSettings): UserSettings {
  const value = (migrateLegacySettings(stored) ?? {}) as Partial<UserSettings>;
  const ng = (typeof value.ng === "object" && value.ng !== null ? value.ng : {}) as Partial<NgConfig>;
  return {
    ng: {
      mode: ng.mode && NG_MODES.includes(ng.mode) ? ng.mode : fallback.ng.mode,
      words: stringList(ng.words),
      ids: stringList(ng.ids),
      names: stringList(ng.names),
      trips: stringList(ng.trips),
      threads: stringList(ng.threads),
      ignoredThreads: normalizeIgnoredThreads(ng.ignoredThreads),
      addedAt: normalizeAddedAt(ng.addedAt),
    },
    display: { ...fallback.display, ...(value.display ?? {}) },
    behavior: { ...fallback.behavior, ...(value.behavior ?? {}) },
    tsubuyaki: { ...fallback.tsubuyaki, ...(value.tsubuyaki ?? {}) },
  };
}

export const settingsStore = createLocalStore<UserSettings>(SETTINGS_STORAGE_KEY, DEFAULT_SETTINGS, {
  merge: mergeSettings,
});

// 同じ端末の別タブで NG を変えたとき、このタブにも反映する。
if (typeof window !== "undefined") {
  syncAcrossTabs(settingsStore);
}

export interface NgVerdict {
  hit: boolean;
  reason?: string;
  /** 解除ボタン用: 一致した NG 項目（保存値そのもの）。 */
  entry?: { kind: NgListKind; value: string };
}

export interface NgThreadVerdict {
  hit: boolean;
  /** "thread" = スレ ID 単位の無視、"title" = スレタイ部分一致 */
  kind?: "thread" | "title";
  /** 表示用の理由（スレタイ NG なら登録語） */
  reason?: string;
}

const SPECIAL: Record<string, (post: Post) => boolean> = {
  ":url": (post) => /https?:\/\//.test(post.body),
  ":image": (post) => (post.attachments?.length ?? 0) > 0 || /https?:\/\/\S+\.(png|jpe?g|gif|webp)/i.test(post.body),
  ":tsubuyaki": (post) => post.kind === "tsubuyaki",
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

/** スレ 1 件の NG 判定。スレ ID の無視を先に見る（似たタイトルの別スレは隠さない）。 */
export function matchThreadNg(thread: { id: number; title: string }, ng: NgConfig): NgThreadVerdict {
  if (ng.ignoredThreads.some((item) => item.id === thread.id)) {
    return { hit: true, kind: "thread", reason: "無視したスレ" };
  }
  const token = matchNgThread(thread.title, ng);
  if (token !== null) return { hit: true, kind: "title", reason: token };
  return { hit: false };
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
      if (special(post)) return { hit: true, reason: token, entry: { kind: "words", value: word } };
      continue;
    }
    if (body.includes(token.toLowerCase())) {
      return { hit: true, reason: token, entry: { kind: "words", value: word } };
    }
  }
  const idHash = post.idHash?.toLowerCase();
  const idEntry = idHash ? ng.ids.find((id) => id.trim().toLowerCase() === idHash) : undefined;
  if (idHash && idEntry !== undefined) {
    return { hit: true, reason: `ID:${post.idHash}`, entry: { kind: "ids", value: idEntry } };
  }
  const tripEntry = post.trip ? ng.trips.find((trip) => trip.trim() === post.trip) : undefined;
  if (post.trip && tripEntry !== undefined) {
    return { hit: true, reason: post.trip, entry: { kind: "trips", value: tripEntry } };
  }
  const name = post.name.toLowerCase();
  for (const ngName of ng.names) {
    const token = ngName.trim().toLowerCase();
    if (token && name.includes(token)) {
      return { hit: true, reason: ngName, entry: { kind: "names", value: ngName } };
    }
  }
  return { hit: false };
}

function ngEntryKey(kind: NgListKind, value: string): string {
  return `${kind}:${value}`;
}

/** NG 項目の追加日時（epoch ミリ秒）。旧データ（日時なし）は null。 */
export function ngEntryAddedAt(ng: NgConfig, kind: NgListKind, value: string): number | null {
  const at = ng.addedAt[ngEntryKey(kind, value)];
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

/** 1 件足した NG 設定を返す（純関数）。既にあれば追加日時だけ補う。 */
export function withNgEntry(ng: NgConfig, kind: NgListKind, value: string, at = Date.now()): NgConfig {
  const token = value.trim();
  if (!token) return ng;
  const key = ngEntryKey(kind, token);
  const list = ng[kind];
  if (list.includes(token)) {
    return ng.addedAt[key] === undefined ? { ...ng, addedAt: { ...ng.addedAt, [key]: at } } : ng;
  }
  return { ...ng, [kind]: [...list, token], addedAt: { ...ng.addedAt, [key]: at } };
}

/** 1 件消した NG 設定を返す（純関数）。追加日時も一緒に消す。 */
export function withoutNgEntry(ng: NgConfig, kind: NgListKind, value: string): NgConfig {
  const addedAt = { ...ng.addedAt };
  delete addedAt[ngEntryKey(kind, value)];
  return { ...ng, [kind]: ng[kind].filter((item) => item !== value), addedAt };
}

/** 種類ごとの全解除（純関数）。 */
export function withoutNgKind(ng: NgConfig, kind: NgListKind): NgConfig {
  const addedAt = { ...ng.addedAt };
  for (const value of ng[kind]) delete addedAt[ngEntryKey(kind, value)];
  return { ...ng, [kind]: [], addedAt };
}

/** スレを ID 単位で無視した設定を返す（純関数・同じ ID は追加日時を更新しない）。 */
export function withIgnoredThread(
  ng: NgConfig,
  thread: { id: number; board: string; title: string },
  at = Date.now(),
): NgConfig {
  if (ng.ignoredThreads.some((item) => item.id === thread.id)) return ng;
  return {
    ...ng,
    ignoredThreads: [...ng.ignoredThreads, { id: thread.id, board: thread.board, title: thread.title, at }],
  };
}

/** スレ ID の無視を解除した設定を返す（純関数）。 */
export function withoutIgnoredThread(ng: NgConfig, id: number): NgConfig {
  return { ...ng, ignoredThreads: ng.ignoredThreads.filter((item) => item.id !== id) };
}

function updateNg(next: (ng: NgConfig) => NgConfig): void {
  settingsStore.set((prev) => {
    const ng = next(prev.ng);
    return ng === prev.ng ? prev : { ...prev, ng };
  });
}

export function addNgEntry(kind: NgListKind, value: string): void {
  updateNg((ng) => withNgEntry(ng, kind, value));
}

export function removeNgEntry(kind: NgListKind, value: string): void {
  updateNg((ng) => withoutNgEntry(ng, kind, value));
}

/** 種類ごとの全解除（設定画面の「すべて解除」）。 */
export function clearNgEntries(kind: NgListKind): void {
  updateNg((ng) => withoutNgKind(ng, kind));
}

/** スレを ID 単位で無視する（似たタイトルの別スレは隠さない）。 */
export function ignoreThread(thread: { id: number; board: string; title: string }): void {
  updateNg((ng) => withIgnoredThread(ng, thread));
}

export function unignoreThread(id: number): void {
  updateNg((ng) => withoutIgnoredThread(ng, id));
}

export function clearIgnoredThreads(): void {
  updateNg((ng) => (ng.ignoredThreads.length === 0 ? ng : { ...ng, ignoredThreads: [] }));
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