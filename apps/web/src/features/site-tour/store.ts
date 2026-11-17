// ツアーの状態と履歴（localStorage）。
// 画面をまたいで使う小さなストア。React へは `useTourState()` で購読する。
//
// レビュー 52（T03/T04/T06/T08）を受けた要点:
// - 開始経路（ヘッダー・フッター・専用ボタン）に関係なく、同じ権限判定・同じ手順を使う。
// - 権限が足りない画面では開始せず、呼び出し側がヘルプへ案内できるよう false を返す。
// - ツアーが開いた UI（スマホの投稿欄など）は、終了時に元へ戻す。
// - 画面（URL）が変わったらツアーを終了する。

import { resolveSteps, tourDefinitionOf, TOUR_DEFINITIONS } from "./steps";
import type { TourPageKey, TourStep } from "./types";

const INTRO_KEY = "oc.tour.intro.v1";
const DONE_KEY_PREFIX = "oc.tour.done.v1.";

/** 画面の権限情報（各画面が setTourContext で知らせる）。 */
export interface TourContext {
  /** 板の管理画面: その板の管理人（admin）以上か。 */
  canManageBoard: boolean;
  /** 板の管理画面を開ける立場か（管理人・副管理人・モデレーター）。 */
  boardStaff: boolean;
  /** 管理画面: サイト所有者か。 */
  siteOwner: boolean;
  /** 管理画面: 特別管理人か。 */
  siteSpecialAdmin: boolean;
  /** ログインしているか（プラグイン作成トークン画面のツアー）。 */
  loggedIn: boolean;
  /** プラグイン詳細: そのプラグインの作者か（作者向けの手順）。 */
  pluginAuthor: boolean;
}

const DEFAULT_CONTEXT: TourContext = {
  canManageBoard: false,
  boardStaff: false,
  siteOwner: false,
  siteSpecialAdmin: false,
  loggedIn: false,
  pluginAuthor: false,
};

let context: TourContext = { ...DEFAULT_CONTEXT };

/** 画面が権限を読み込み中か（読み込み中に押された「使い方」は、読み込み後に開始する）。 */
let contextPending = false;
/** 読み込み中に押された「使い方」の画面種別。 */
let queuedStart: TourPageKey | null = null;

/** 画面が自分の権限をツアーへ知らせる（同じ画面でも開始経路によらず同じ判定にする）。 */
export function setTourContext(partial: Partial<TourContext>): void {
  context = { ...context, ...partial };
  if (!contextPending) flushQueuedTour();
}

/**
 * 画面が権限を読み込み中か知らせる。
 * 読み込み中に「使い方」を押されても権限不足と取り違えないよう、開始要求を保持し、
 * 読み込みが終わった時点で開始する（本当に権限が無ければヘルプへ案内する）。
 */
export function setTourContextPending(pending: boolean): void {
  contextPending = pending;
  if (!pending) flushQueuedTour();
}

/** 保持している開始要求を捨てる（画面を離れたとき）。 */
export function clearQueuedTour(): void {
  queuedStart = null;
}

function flushQueuedTour(): void {
  const page = queuedStart;
  if (!page) return;
  queuedStart = null;
  if (beginTour(page)) return;
  // 読み込みの結果、権限が足りない/未対応だった場合は、押した操作を失わせずヘルプへ送る。
  if (typeof window !== "undefined") window.location.assign("/help/#tour");
}

export function resetTourContext(): void {
  context = { ...DEFAULT_CONTEXT };
}

export function tourContext(): TourContext {
  return context;
}

export interface TourState {
  /** 表示中のツアー。null なら非表示。 */
  page: TourPageKey | null;
  steps: TourStep[];
  index: number;
  /** 開始時の URL（画面が変わったら終了するため）。 */
  pathname: string;
}

/**
 * 非表示状態のオブジェクト。`useSyncExternalStore` のサーバー用スナップショットは
 * 毎回同じ参照を返す必要がある（新しいオブジェクトを返すと React が
 * "getServerSnapshot should be cached" を出して再描画ループになる）。
 */
const EMPTY_STATE: TourState = { page: null, steps: [], index: 0, pathname: "" };

const listeners = new Set<() => void>();
let state: TourState = EMPTY_STATE;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeTour(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function tourSnapshot(): TourState {
  return state;
}

export function tourServerSnapshot(): TourState {
  return EMPTY_STATE;
}

/** 要素が実際に画面に出ているか（display:none・幅0 は飛ばす）。複数一致はどれか 1 つでよい。 */
function isVisible(selector: string): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(document.querySelectorAll(selector)).some((element) => element.getClientRects().length > 0);
}

/**
 * この画面でツアーを開始してよいか（権限）。
 * 一般利用者に管理操作を案内しないため、画面側が知らせた権限で判定する。
 */
export function canStartTour(page: TourPageKey): boolean {
  if (page === "manage") return context.boardStaff;
  if (page === "admin") return context.siteOwner || context.siteSpecialAdmin;
  if (page === "plugins-board") return context.canManageBoard;
  if (page === "plugins-review") return context.siteOwner || context.siteSpecialAdmin;
  if (page === "plugin-tokens") return context.loggedIn;
  return true;
}

/** その画面の手順のうち、いま画面にあり、権限でも説明してよいものだけ。 */
export function visibleStepsFor(page: TourPageKey): TourStep[] {
  return resolveSteps(tourDefinitionOf(page), isVisible, context);
}

/**
 * ツアーを開始する。
 * @returns 開始したら true。読み込み中なら開始要求を保持して true（読み込み後に開始する）。
 *          未対応の画面・権限不足なら false（呼び出し側はヘルプへ案内する）。
 */
export function startTour(page?: TourPageKey): boolean {
  if (typeof window === "undefined") return false;
  const target = page ?? tourPageKeyForPath(window.location.pathname);
  if (!target) return false;
  if (contextPending) {
    // 権限の読み込みが終わるまで待つ。ここで false を返すと呼び出し側が
    // ヘルプへ飛ばしてしまい、読み込み中に押した「使い方」が失われる（K3）。
    queuedStart = target;
    return true;
  }
  return beginTour(target);
}

function beginTour(target: TourPageKey): boolean {
  if (!canStartTour(target)) return false;
  const steps = visibleStepsFor(target);
  if (steps.length === 0) return false;
  state = { page: target, steps, index: 0, pathname: window.location.pathname };
  markTourDone(target);
  emit();
  return true;
}

/** ツアーが開いた UI を戻すための情報（T03）。 */
export interface OpenRestore {
  /** ツアーが開いた要素を閉じるためのセレクタ（例: `.oc-form-collapse`）。 */
  selector: string;
}

let restoreTarget: OpenRestore | null = null;

/** ツアーが UI を開いたことを記録する（Host から呼ぶ）。 */
export function setTourRestore(target: OpenRestore | null): void {
  restoreTarget = target;
}

/** ツアーが開いた UI を元に戻す。 */
export function restoreTourUi(): void {
  const target = restoreTarget;
  restoreTarget = null;
  if (!target || typeof document === "undefined") return;
  const element = Array.from(document.querySelectorAll(target.selector)).find(
    (candidate) => candidate.getClientRects().length > 0,
  );
  if (element instanceof HTMLElement) element.click();
}

export function stopTour(): void {
  if (state.page === null) return;
  restoreTourUi();
  state = EMPTY_STATE;
  emit();
}

/** 画面が変わったときに呼ぶ（残っていれば終了し、開いた UI も戻す）。 */
export function stopTourIfRouteChanged(): void {
  if (state.page === null || typeof window === "undefined") return;
  if (window.location.pathname !== state.pathname) stopTour();
}

export function tourNext(): void {
  if (state.page === null) return;
  if (state.index >= state.steps.length - 1) {
    stopTour();
    return;
  }
  state = { ...state, index: state.index + 1 };
  emit();
}

export function tourPrev(): void {
  if (state.page === null || state.index === 0) return;
  state = { ...state, index: state.index - 1 };
  emit();
}

/** 最後の手順か（「終了」の代わりにヘルプ導線を出す）。 */
export function isLastStep(current: TourState): boolean {
  return current.steps.length > 0 && current.index === current.steps.length - 1;
}

/** URL から画面の種類を判定する。 */
export function tourPageKeyForPath(pathname: string): TourPageKey | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (path === "/boards/new") return "board-new";
  if (path === "/settings") return "settings";
  if (path === "/help/admin") return "help-admin";
  if (path === "/help") return "help";
  if (path === "/plugins") return "plugins";
  if (path === "/plugins/new") return "plugin-new";
  if (path === "/plugins/templates") return "plugin-templates";
  if (path === "/plugins/view") return "plugin-view";
  if (path === "/plugins/board") return "plugins-board";
  if (path === "/plugins/review") return "plugins-review";
  if (path === "/account/plugin-tokens") return "plugin-tokens";
  if (path === "/admin" || path.startsWith("/admin/")) return "admin";
  const manage = path.match(/^\/b\/[^/]+\/manage(?:\/|$)/);
  if (manage) return "manage";
  const thread = path.match(/^\/b\/[^/]+\/t\/\d+$/);
  if (thread) return "thread";
  const board = path.match(/^\/b\/[^/]+$/);
  if (board) return "board";
  return null;
}

/** 初回の案内をまだ見ていないか。 */
export function shouldShowIntro(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INTRO_KEY) === null;
  } catch {
    return false;
  }
}

/** 初回の案内を閉じたことを記録する（二度と出さない）。 */
export function dismissIntro(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INTRO_KEY, "1");
  } catch {
    // 保存できなくても表示に影響しない
  }
}

/** その画面のツアーを見終えたか（ヘッダーの導線の補助表示に使う）。 */
export function hasSeenTour(page: TourPageKey): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${DONE_KEY_PREFIX}${page}`) === "1";
  } catch {
    return false;
  }
}

function markTourDone(page: TourPageKey): void {
  try {
    window.localStorage.setItem(`${DONE_KEY_PREFIX}${page}`, "1");
  } catch {
    // 保存できなくても動作に影響しない
  }
}

/** 定義済みの画面一覧（テスト・デバッグ用）。 */
export const TOUR_PAGES = Object.keys(TOUR_DEFINITIONS) as TourPageKey[];