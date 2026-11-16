// サイトツアーの公開 API。
//
// 外から使う場所:
//  - ヘッダー／フッターの「使い方」ボタン … `startTour()`（今いる画面を自動判定）
//  - 管理画面・板の管理画面の「使い方」 … `startTour("admin")` / `startTour("manage")`
//  - ヘルプ画面の「トップページでツアーを始める」 … トップへ移ってから `startTour("home")`
//  - 表示本体 … `<TourHost />`（SiteHeader と管理画面レイアウトに置く）
//
// 画面キーは `TourPageKey`。URL からの判定は `tourPageKeyForPath(pathname)`。

export { TourHost } from "./tour-host";
export {
  canStartTour,
  dismissIntro,
  resetTourContext,
  restoreTourUi,
  setTourContext,
  setTourRestore,
  stopTourIfRouteChanged,
  tourContext,
  hasSeenTour,
  isLastStep,
  shouldShowIntro,
  startTour,
  stopTour,
  subscribeTour,
  tourNext,
  tourPageKeyForPath,
  tourPrev,
  tourSnapshot,
  useTourState,
  visibleStepsFor,
  TOUR_PAGES,
} from "./use-tour";
export { tourDefinitionOf, resolveSteps, TOUR_DEFINITIONS } from "./steps";
export type { TourDefinition, TourPageKey, TourStep } from "./types";