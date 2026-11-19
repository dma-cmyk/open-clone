"use client";

// 設定・画面の状態の購読（`settings.ts` のストアを React から読む）。
// サーバー側では保存が無いものとして既定値を返し、ハイドレーション後に実値へ切り替える。

import { useSyncExternalStore } from "react";
import type { PetConfig } from "../contract";
import { DEFAULT_PET_UI, petAvatarSnapshot, petConfigSnapshot, petUiSnapshot, subscribePetSettings, type PetUiState } from "../settings";

export function usePetConfig(): PetConfig | null {
  return useSyncExternalStore(subscribePetSettings, petConfigSnapshot, () => null);
}

export function usePetUiState(): PetUiState {
  return useSyncExternalStore(subscribePetSettings, petUiSnapshot, () => DEFAULT_PET_UI);
}

/** 利用者がアップロードした画像（data URL）。無ければ null。 */
export function usePetAvatar(): string | null {
  return useSyncExternalStore(subscribePetSettings, petAvatarSnapshot, () => null);
}