// AI ペットの設定の保存（ブラウザにだけ。サーバーには送らない）。
//
// - 設定（事業者・モデル・API キー・名前・見た目）は「この端末に覚えておく」（remember）が
//   オンなら localStorage、オフなら sessionStorage（タブを閉じるまで）。
// - アバター画像（利用者がアップロードした 256×256 PNG）と「しまった」状態、音声入力の案内済みは
//   秘密ではないので常に localStorage（この端末）。API キーだけが remember の対象。
// - 保存の中身は必ず読み直しで検証する（古い形・壊れた JSON で画面が落ちないように）。
//
// 画面は `usePetConfig()` / `usePetUiState()` で購読する（同じタブ内の変更が即座に反映される）。

import { PET_PROVIDER_IDS, petProviderPreset, type PetProviderId } from "shared";
import { DEFAULT_PET_CHARACTER_ID, PET_CHARACTERS } from "./characters";
import type { PetConfig } from "./contract";

export const PET_CONFIG_KEY = "oc.pet.config.v1";
export const PET_UI_KEY = "oc.pet.ui.v1";
export const PET_AVATAR_KEY = "oc.pet.avatar.v1";
/** アップロード画像の保存形式（data URL の PNG だけを受け付ける）。 */
export const PET_AVATAR_MAX_CHARS = 2 * 1024 * 1024;

export interface PetUiState {
  /** 「しまう」を押した（右下のボタンを出さない。ヘッダーの「ペット」で戻せる）。 */
  hidden: boolean;
  /** 音声入力の初回案内を出し終えた。 */
  voiceNoticeSeen: boolean;
}

export const DEFAULT_PET_UI: PetUiState = { hidden: false, voiceNoticeSeen: false };

const DEFAULT_PROVIDER: PetProviderId = "openai";

/** 選択中のキャラクターの既定の名前（存在しない id なら既定のキャラ）。 */
export function defaultPetName(characterId: string): string {
  const character = PET_CHARACTERS.find((item) => item.id === characterId);
  return (character ?? PET_CHARACTERS[0])?.defaultName ?? "ペット";
}

/** 保存が無いときの設定。API キー・モデルは空（＝未設定として最初の設定を出す）。 */
export function defaultPetConfig(): PetConfig {
  return {
    provider: DEFAULT_PROVIDER,
    baseUrl: "",
    model: "",
    apiKey: "",
    remember: true,
    petName: defaultPetName(DEFAULT_PET_CHARACTER_ID),
    characterId: DEFAULT_PET_CHARACTER_ID,
  };
}

/** 会話を始められる設定か（事業者・モデル・キーがそろっている）。 */
export function isPetConfigured(config: PetConfig | null): config is PetConfig {
  if (!config) return false;
  if (config.model.trim().length === 0 || config.apiKey.trim().length === 0) return false;
  if (config.provider === "custom" && config.baseUrl.trim().length === 0) return false;
  return true;
}

// ─── 保存領域への読み書き（触れない環境でも落とさない） ───

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readRaw(key: string): string | null {
  for (const store of [sessionStore(), localStore()]) {
    if (!store) continue;
    try {
      const value = store.getItem(key);
      if (value !== null) return value;
    } catch {
      /* 読めない保存領域は無視する */
    }
  }
  return null;
}

function writeRaw(key: string, value: string): void {
  // 設定は remember の保存先だけに置く（両方に残すと、切り替えたときに古い値が勝つ）。
  for (const store of [localStore(), sessionStore()]) {
    if (!store) continue;
    try {
      store.removeItem(key);
    } catch {
      /* 消せない保存領域は無視する */
    }
  }
  const target = rememberTarget();
  if (!target) return;
  try {
    target.setItem(key, value);
  } catch {
    /* 容量不足などで書けなくても、その場の画面は動かす */
  }
}

function removeRaw(key: string): void {
  for (const store of [localStore(), sessionStore()]) {
    if (!store) continue;
    try {
      store.removeItem(key);
    } catch {
      /* 無視 */
    }
  }
}

/** 設定の保存先（remember の値で決める）。 */
function rememberTarget(): Storage | null {
  return desiredRemember ? localStore() ?? sessionStore() : sessionStore() ?? localStore();
}

/**
 * 次に保存するときに使う「この端末に覚えておく」の値。
 * 保存済みの設定（remember）を読み直すたびに更新する。
 */
let desiredRemember = true;

function normalizeCharacterId(value: unknown): string {
  if (value === "custom") return "custom";
  if (typeof value === "string" && PET_CHARACTERS.some((character) => character.id === value)) return value;
  return DEFAULT_PET_CHARACTER_ID;
}

function normalizeProvider(value: unknown): PetProviderId {
  return PET_PROVIDER_IDS.includes(value as PetProviderId) ? (value as PetProviderId) : DEFAULT_PROVIDER;
}

/** 保存された JSON を PetConfig に直す（形が違えば既定値で埋める）。 */
export function normalizePetConfig(raw: unknown): PetConfig {
  const base = defaultPetConfig();
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Record<string, unknown>;
  const characterId = normalizeCharacterId(record.characterId);
  const petName = typeof record.petName === "string" ? record.petName.slice(0, 20) : "";
  return {
    provider: normalizeProvider(record.provider),
    baseUrl: typeof record.baseUrl === "string" ? record.baseUrl.slice(0, 300) : "",
    model: typeof record.model === "string" ? record.model.slice(0, 200) : "",
    apiKey: typeof record.apiKey === "string" ? record.apiKey.slice(0, 512) : "",
    remember: record.remember !== false,
    petName: petName.length > 0 ? petName : defaultPetName(characterId),
    characterId,
  };
}

function readStoredConfig(): PetConfig | null {
  const raw = readRaw(PET_CONFIG_KEY);
  if (raw === null) return null;
  try {
    const config = normalizePetConfig(JSON.parse(raw));
    desiredRemember = config.remember;
    return config;
  } catch {
    return null;
  }
}

// ─── 購読（useSyncExternalStore 用。スナップショットの参照を安定させる） ───

const listeners = new Set<() => void>();
let configState: PetConfig | null | undefined;
let uiState: PetUiState | undefined;
let avatarState: string | null | undefined;

function notify(): void {
  configState = undefined;
  uiState = undefined;
  avatarState = undefined;
  for (const listener of listeners) listener();
}

export function subscribePetSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function configSnapshot(): PetConfig | null {
  if (configState === undefined) configState = readStoredConfig();
  return configState;
}

function readStoredUi(): PetUiState {
  const raw = readRaw(PET_UI_KEY);
  if (raw === null) return DEFAULT_PET_UI;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { hidden: parsed.hidden === true, voiceNoticeSeen: parsed.voiceNoticeSeen === true };
  } catch {
    return DEFAULT_PET_UI;
  }
}

function uiSnapshot(): PetUiState {
  if (uiState === undefined) uiState = readStoredUi();
  return uiState;
}

function readStoredAvatar(): string | null {
  const raw = localStore()?.getItem(PET_AVATAR_KEY) ?? null;
  if (raw === null) return null;
  return isPetAvatarDataUrl(raw) ? raw : null;
}

function avatarSnapshot(): string | null {
  if (avatarState === undefined) avatarState = readStoredAvatar();
  return avatarState;
}

// ─── 設定 ───

/** 設定を保存する（remember に従って保存先を選ぶ。もう一方からは消す）。 */
export function savePetConfig(config: PetConfig): PetConfig {
  const normalized = normalizePetConfig(config);
  desiredRemember = normalized.remember;
  writeRaw(PET_CONFIG_KEY, JSON.stringify(normalized));
  notify();
  return normalized;
}

/** 設定を消す（「最初の設定」に戻る。会話の履歴には触れない）。 */
export function clearPetConfig(): void {
  removeRaw(PET_CONFIG_KEY);
  notify();
}

/** アバター画像（data URL）を保存する。data URL 以外は捨てる。 */
export function savePetAvatar(dataUrl: string): void {
  if (!isPetAvatarDataUrl(dataUrl) || dataUrl.length > PET_AVATAR_MAX_CHARS) return;
  try {
    localStore()?.setItem(PET_AVATAR_KEY, dataUrl);
  } catch {
    return;
  }
  notify();
}

export function clearPetAvatar(): void {
  try {
    localStore()?.removeItem(PET_AVATAR_KEY);
  } catch {
    /* 無視 */
  }
  notify();
}

export function isPetAvatarDataUrl(value: string): boolean {
  return /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value);
}

// ─── 画面の状態（しまう・音声入力の案内） ───

export function savePetUiState(partial: Partial<PetUiState>): PetUiState {
  const next = { ...uiSnapshot(), ...partial };
  try {
    localStore()?.setItem(PET_UI_KEY, JSON.stringify(next));
  } catch {
    /* 保存できなくてもその場の状態は返す */
  }
  notify();
  return next;
}

// ─── React 用の読み取り（サーバーでは既定値。購読は subscribePetSettings） ───

export { configSnapshot as petConfigSnapshot, uiSnapshot as petUiSnapshot, avatarSnapshot as petAvatarSnapshot };

/** 設定のプレースホルダー用: 事業者のモデル名の例。 */
export function modelPlaceholder(provider: PetProviderId): string {
  switch (provider) {
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-3-5-haiku-latest";
    case "gemini":
      return "gemini-2.0-flash";
    case "openrouter":
      return "openai/gpt-4o-mini";
    case "deepseek":
      return "deepseek-chat";
    default:
      return "model-name";
  }
}

/** 事業者のところに出す補足（接続先の確認に使う）。 */
export function providerHint(provider: PetProviderId): string {
  const preset = petProviderPreset(provider);
  if (provider === "custom") return "OpenAI と同じ形の API（/chat/completions）を持つ https の URL。";
  return `接続先: ${preset.baseUrl ?? ""}`;
}