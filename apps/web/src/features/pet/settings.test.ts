// 設定の保存（settings.ts）の単体試験。
// node 環境なので、window の localStorage / sessionStorage を偽物にして保存先の切り替えを確かめる。

import { beforeEach, describe, expect, it } from "vitest";
import {
  PET_AVATAR_KEY,
  PET_CONFIG_KEY,
  PET_UI_KEY,
  clearPetAvatar,
  clearPetConfig,
  defaultPetConfig,
  isPetConfigured,
  normalizePetConfig,
  petAvatarSnapshot,
  petConfigSnapshot,
  petUiSnapshot,
  savePetAvatar,
  savePetConfig,
  savePetUiState,
} from "./settings";

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

const local = new MemoryStorage();
const session = new MemoryStorage();

const globals = globalThis as unknown as { window?: unknown };

beforeEach(() => {
  local.clear();
  session.clear();
  // settings.ts は `window.localStorage` / `window.sessionStorage` を見るだけ。
  // 保存の購読はモジュール内のキャッシュを捨てるため、毎回購読者へ通知する（save/clear が notify する）。
  globals.window = { localStorage: local, sessionStorage: session };
});

describe("設定の保存先", () => {
  it("「覚えておく」がオンなら localStorage、オフなら sessionStorage だけに置く", () => {
    const base = defaultPetConfig();
    savePetConfig({ ...base, model: "m1", apiKey: "k1", remember: true });
    expect(local.getItem(PET_CONFIG_KEY)).not.toBeNull();
    expect(session.getItem(PET_CONFIG_KEY)).toBeNull();

    savePetConfig({ ...base, model: "m2", apiKey: "k2", remember: false });
    // 切り替えたら前の保存先からは消える（古い値が勝たない）。
    expect(local.getItem(PET_CONFIG_KEY)).toBeNull();
    expect(session.getItem(PET_CONFIG_KEY)).not.toBeNull();
    expect(petConfigSnapshot()?.model).toBe("m2");
  });

  it("設定を消すと未設定に戻る", () => {
    const base = defaultPetConfig();
    savePetConfig({ ...base, model: "m", apiKey: "k" });
    clearPetConfig();
    expect(petConfigSnapshot()).toBeNull();
    expect(isPetConfigured(null)).toBe(false);
  });
});

describe("設定の中身", () => {
  it("未設定の判定は モデル・キー・custom の URL", () => {
    const base = defaultPetConfig();
    expect(isPetConfigured(base)).toBe(false);
    expect(isPetConfigured({ ...base, model: "m", apiKey: "k" })).toBe(true);
    expect(isPetConfigured({ ...base, provider: "custom", model: "m", apiKey: "k", baseUrl: "" })).toBe(false);
    expect(isPetConfigured({ ...base, provider: "custom", model: "m", apiKey: "k", baseUrl: "https://x.example/v1" })).toBe(
      true,
    );
  });

  it("壊れた保存値でも既定値で埋める", () => {
    const config = normalizePetConfig({ provider: "unknown", characterId: "unknown", petName: "", model: 1 });
    expect(config.provider).toBe("openai");
    expect(config.characterId).toBe("cat");
    expect(config.petName).toBe("ミケ");
    expect(config.model).toBe("");
    // 名前は文字の先頭 20 文字まで。
    expect(normalizePetConfig({ petName: "あ".repeat(30) }).petName).toHaveLength(20);
  });
});

describe("画面の状態とアバター", () => {
  it("「しまう」と音声入力の案内は端末に残る", () => {
    expect(petUiSnapshot().hidden).toBe(false);
    savePetUiState({ hidden: true });
    expect(petUiSnapshot()).toEqual({ hidden: true, voiceNoticeSeen: false });
    savePetUiState({ voiceNoticeSeen: true });
    expect(petUiSnapshot()).toEqual({ hidden: true, voiceNoticeSeen: true });
    expect(local.getItem(PET_UI_KEY)).not.toBeNull();
  });

  it("アップロード画像は data URL の PNG だけ受け付ける", () => {
    const png = "data:image/png;base64,AAAA";
    savePetAvatar(png);
    expect(petAvatarSnapshot()).toBe(png);
    savePetAvatar("data:image/jpeg;base64,AAAA");
    // jpeg は受け付けない（変換後の PNG だけを保存する）。
    expect(petAvatarSnapshot()).toBe(png);
    savePetAvatar("https://example.com/x.png");
    expect(petAvatarSnapshot()).toBe(png);
    clearPetAvatar();
    expect(petAvatarSnapshot()).toBeNull();
    expect(local.getItem(PET_AVATAR_KEY)).toBeNull();
  });
});