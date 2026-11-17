// 画面をまたぐツアーの開始予約。
//
// ヘルプの一覧から別の画面のツアーを始めるとき、移動先の画面はまだ描画中で
// 権限（`setTourContext`）も未確定なことがある。以前はヘルプ画面が 3 秒ポーリングしていたが、
// 開始待ちを 1 か所（この予約 + `TourHost`）にまとめる。
//
// - 押した時点で `sessionStorage` に「どの画面のツアーをいつ予約したか」を書く
//   （Next の個別ページへはフルページ遷移になるため、メモリだけでは失われる）。
// - 移動先の `TourHost` が予約を受け取り、その画面の準備（権限の読み込み・手順の描画）が
//   できてから開始する。
// - 時間切れ・権限不足なら予約を捨て、呼び出し側（TourHost）がヘルプの該当節へ送る。
// - 予約は対象の画面でだけ有効。別の画面に残っていた予約は捨て、勝手に始めない。
//
// 判定は純粋関数（`planPendingStart`）にして単体テストできる形にしている。

import { TOUR_DEFINITIONS } from "./steps";
import type { TourPageKey } from "./types";

export const PENDING_START_KEY = "oc.tour.pending-start.v1";

/** 移動先の準備を待つ時間。過ぎたら予約を捨ててヘルプへ送る。 */
export const PENDING_START_WAIT_MS = 8_000;

/** これを過ぎた予約は古いものとして黙って捨てる（戻ってきたタブ等で勝手に始めない）。 */
export const PENDING_START_STALE_MS = 60_000;

/**
 * 移動直後の権限判定を待つ猶予。
 * 画面は権限の読み込み開始を effect（`setTourContextPending(true)`）で知らせるため、
 * `TourHost` の最初の判定がそれより先に走ることがある。数フレーム〜1 秒待てば
 * 「読み込み中」に切り替わり、本当に権限が無い場合だけヘルプへ送れる。
 */
export const PENDING_START_PERMISSION_GRACE_MS = 1_500;

export interface PendingTourStart {
  page: TourPageKey;
  /** 予約した時刻（epoch ms）。 */
  at: number;
}

/** `sessionStorage` 相当（テストでは差し替える）。 */
export interface PendingStartStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type PendingStartPlan =
  /** 予約が無い（何もしない）。 */
  | { action: "none" }
  /** 別画面の予約・古すぎる予約（黙って捨てる）。 */
  | { action: "discard" }
  /** この画面の予約。まだ準備中なので待つ。 */
  | { action: "wait" }
  /** 準備ができたので開始する。 */
  | { action: "start" }
  /** 権限不足・時間切れ。予約を捨ててヘルプへ送る。 */
  | { action: "help" };

function isTourPageKey(value: unknown): value is TourPageKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TOUR_DEFINITIONS, value);
}

/** 保存されている予約を読む（壊れていれば null）。 */
export function readPendingStart(storage: PendingStartStorage): PendingTourStart | null {
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_START_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("page" in parsed) || !("at" in parsed)) return null;
    const { page, at } = parsed;
    if (!isTourPageKey(page) || typeof at !== "number" || !Number.isFinite(at)) return null;
    return { page, at };
  } catch {
    return null;
  }
}

/** 予約を書く（ストレージが使えなくても移動自体は続けられる）。 */
export function writePendingStart(storage: PendingStartStorage, page: TourPageKey, now: number): void {
  try {
    storage.setItem(PENDING_START_KEY, JSON.stringify({ page, at: now } satisfies PendingTourStart));
  } catch {
    // 保存できなくても、その画面へ移動すればツアーは始まらないだけで壊れない。
  }
}

export function clearPendingStart(storage: PendingStartStorage): void {
  try {
    storage.removeItem(PENDING_START_KEY);
  } catch {
    // 消せなくても、古い予約は上の期限で弾かれる。
  }
}

/**
 * 予約をどう扱うか決める。
 *
 * @param pending       保存されている予約
 * @param page          いまの画面の種類（ツアーの無い画面は null）
 * @param now           いまの時刻（epoch ms）
 * @param contextReady  画面が権限を読み込み終えたか（K3 の `setTourContextPending`）
 * @param allowed       その画面でツアーを開始してよい権限か（`canStartTour`）
 * @param stepCount     いま案内できる手順の数（`visibleStepsFor().length`）
 */
export function planPendingStart(input: {
  pending: PendingTourStart | null;
  page: TourPageKey | null;
  now: number;
  contextReady: boolean;
  allowed: boolean;
  stepCount: number;
}): PendingStartPlan {
  const { pending, page, now } = input;
  if (!pending) return { action: "none" };
  // 予約した画面と違う・対象の無い画面に残っていた予約は捨てる（勝手に始めない）。
  if (page === null || pending.page !== page) return { action: "discard" };
  const age = Math.max(0, now - pending.at);
  if (age > PENDING_START_STALE_MS) return { action: "discard" };
  if (!input.contextReady) {
    return age >= PENDING_START_WAIT_MS ? { action: "help" } : { action: "wait" };
  }
  if (!input.allowed) {
    return age >= PENDING_START_PERMISSION_GRACE_MS ? { action: "help" } : { action: "wait" };
  }
  if (input.stepCount === 0) {
    // 手順の対象がまだ描画されていないだけかもしれないので、期限までは待つ。
    return age >= PENDING_START_WAIT_MS ? { action: "help" } : { action: "wait" };
  }
  return { action: "start" };
}