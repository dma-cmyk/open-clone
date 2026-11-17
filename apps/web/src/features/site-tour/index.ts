// サイトツアーの公開 API。
//
// 外から使う場所:
//  - ヘッダー／フッターの「使い方」ボタン … `startTour()`（今いる画面を自動判定）
//  - 管理画面・板の管理画面の「使い方」 … `startTour("admin")` / `startTour("manage")`
//  - ヘルプのツアー一覧 / 「トップページでツアーを始める」 … `reserveTourStart(page)` してから移動する
//    （移動先の `<TourHost />` が準備を待って開始する。`pending-start.ts`）
//  - 表示本体 … `<TourHost />`（SiteHeader と管理画面レイアウトに置く）
//
// 画面キーは `TourPageKey`。URL からの判定は `tourPageKeyForPath(pathname)`。

export { TourHost } from "./tour-host";
export { TourList } from "./tour-list";
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
  useTourState,
  visibleStepsFor,
  TOUR_PAGES,
} from "./use-tour";
export { tourDefinitionOf, resolveSteps, TOUR_DEFINITIONS, TOUR_LIST_DEFINITIONS } from "./steps";
export type { TourDefinition, TourListContext, TourPageKey, TourStep } from "./types";