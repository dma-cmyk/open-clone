"use client";

// ツアー状態の React 購読フック（`store.ts` の薄いラッパ）。
// 公開 API は `index.ts` から。ここを分けているのは、Qwen 担当の画面から
// `useTourState` だけを使うときに内部実装を辿らなくて済むようにするため。

import { useSyncExternalStore } from "react";
import { subscribeTour, tourServerSnapshot, tourSnapshot, type TourState } from "./store";

export function useTourState(): TourState {
  return useSyncExternalStore(subscribeTour, tourSnapshot, tourServerSnapshot);
}

export {
  canStartTour,
  clearQueuedTour,
  dismissIntro,
  resetTourContext,
  restoreTourUi,
  setTourContext,
  setTourContextPending,
  setTourRestore,
  stopTourIfRouteChanged,
  tourContext,
  hasSeenTour,
  isLastStep,
  isTourContextPending,
  pendingTourStart,
  reserveTourStart,
  shouldShowIntro,
  startTour,
  stopTour,
  subscribeTour,
  tourGoTo,
  tourHelpHref,
  tourNext,
  tourPageKeyForPath,
  tourPrev,
  tourSnapshot,
  visibleStepsFor,
  TOUR_PAGES,
} from "./store";
export type { TourState } from "./store";