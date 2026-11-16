"use client";

// ツアーの表示。対象要素を強調（スポットライト）し、説明と操作を出す。
// 追加ライブラリは使わない（理由は報告書: 必要な機能は「対象の矩形を囲む」「説明を出す」
// 「キーボード操作」だけで、driver.js 等を入れると数十 KB 増えるため。自前で約 8KB）。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

// SSR では useLayoutEffect を使わない（サーバー側の警告を避ける）。
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
import {
  isLastStep,
  shouldShowIntro,
  dismissIntro,
  setTourRestore,
  startTour,
  stopTour,
  stopTourIfRouteChanged,
  subscribeTour,
  tourNext,
  tourPrev,
  tourServerSnapshot,
  tourSnapshot,
} from "./store";
import { subscribeLocation } from "@/app/_shell/router";
import { tourDefinitionOf } from "./steps";

/** 対象要素の矩形（ビューポート座標）。 */
interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PADDING = 6;
const TOOLTIP_MAX_WIDTH = 360;
const MARGIN = 12;

/**
 * 実際に見えている領域の大きさ。
 * スマホ（URL バー・ジェスチャーバーがある環境）では `window.innerHeight` が
 * 見えている高さより大きくなることがあり、それで計算すると下端の説明が画面外へ出る。
 * `visualViewport` があればそちらを優先する。
 */
function visibleViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1024, height: 768 };
  const vv = window.visualViewport;
  return {
    width: Math.round(vv?.width ?? window.innerWidth),
    height: Math.round(vv?.height ?? window.innerHeight),
  };
}

/** セレクタに一致する要素のうち、実際に画面に出ている最初のもの。 */
function firstVisible(selector: string): Element | null {
  for (const element of document.querySelectorAll(selector)) {
    if (element.getClientRects().length > 0) return element;
  }
  return null;
}

/** 描画 1 フレーム待つ（押した結果の再描画を待つ）。 */
function nextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  window.requestAnimationFrame(() => resolve());
  return promise;
}

/**
 * 対象要素の位置を測る（スクロールして画面内に入れてから測る）。
 * スマホで投稿欄が畳まれている場合など、対象がまだ無いときは `reveal` を 1 度だけ押して測り直す。
 * `revealed` は実際に押して開いたか（ツアー終了時に元へ戻すかの判断に使う。T03）。
 */
async function measure(selector: string, reveal?: string): Promise<{ rect: Rect | null; revealed: boolean }> {
  let element = firstVisible(selector);
  let revealed = false;
  if (!element && reveal) {
    const trigger = firstVisible(reveal);
    if (trigger instanceof HTMLElement) {
      trigger.click();
      revealed = true;
      // 押した結果の再描画（投稿欄を開くなど）を待ってから測り直す。
      await nextFrame();
      await nextFrame();
      element = firstVisible(selector);
    }
  }
  if (!element) return { rect: null, revealed };
  (element as HTMLElement).scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return { rect: null, revealed };
  return {
    rect: {
      top: Math.max(0, box.top - PADDING),
      left: Math.max(0, box.left - PADDING),
      width: Math.min(visibleViewport().width, box.width + PADDING * 2),
      height: Math.min(visibleViewport().height, box.height + PADDING * 2),
    },
    revealed,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function TourHost() {
  const state = useSyncExternalStore(subscribeTour, tourSnapshot, tourServerSnapshot);
  const [rect, setRect] = useState<Rect | null>(null);
  const [showIntro, setShowIntro] = useState(false);
  // ヘッダーの中に置くと狭幅でクリップされることがあるため、表示は body 直下へ出す。
  const [mounted, setMounted] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipSize, setTooltipSize] = useState({ width: TOOLTIP_MAX_WIDTH, height: 180 });
  /** いまの手順の対象が見つかったか（見つからなければ次の手順へ送る）。 */
  const measured = useRef<{ id: string; found: boolean } | null>(null);

  // 初回の案内（勝手にツアーは始めない）。
  useEffect(() => {
    setMounted(true);
    setShowIntro(shouldShowIntro());
  }, []);

  // 案内は画面の上に重ねず、ページ先頭の通常の帯として差し込む。重ねると狭幅・広幅とも
  // スレの操作ボタン（実況・つぶやき・ブクマ）や投稿バーを覆ってしまうため。
  const [introSlot, setIntroSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!showIntro) return;
    const slot = document.createElement("div");
    slot.className = "oc-tour-intro-slot";
    document.body.prepend(slot);
    setIntroSlot(slot);
    return () => {
      slot.remove();
      setIntroSlot(null);
    };
  }, [showIntro]);

  // 画面（URL）が変わったら、その画面に合わないツアーは終了する（T08）。
  useEffect(() => subscribeLocation(() => stopTourIfRouteChanged()), []);
  useEffect(() => {
    const handler = () => stopTourIfRouteChanged();
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const step = state.page ? state.steps[state.index] ?? null : null;

  // ツアー開始前のフォーカス位置（終了時に戻す）。
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!state.page) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // ダイアログ内へフォーカスを移す（マウスなしで操作できるように）。
    window.requestAnimationFrame(() => tooltipRef.current?.focus());
    return () => {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (target && document.contains(target)) target.focus();
    };
  }, [state.page]);

  // 実際に reveal を押して開いたときだけ記録し、手順が変わっても記録を失わない。
  // 復元は store 側がツアー終了時に 1 度だけ行う（T03）。
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshRect = useCallback(async () => {
    if (!step) {
      measured.current = null;
      setRect(null);
      return;
    }
    const startedAt = stateRef.current;
    const { rect: next, revealed } = await measure(step.selector, step.reveal);
    // 終了・手順移動後に届いた古い測定は反映しない（終了後に画面を触らない）。
    if (stateRef.current !== startedAt) return;
    if (revealed && step.restore) setTourRestore({ selector: step.restore });
    measured.current = { id: step.id, found: next !== null };
    setRect(next);
  }, [step]);

  useIsomorphicLayoutEffect(() => {
    void refreshRect();
  }, [refreshRect]);

  // 画面に無い要素を指す手順（読み込み前・設定で非表示など）は自動で飛ばす。
  useEffect(() => {
    if (!step) return;
    const current = measured.current;
    if (current && current.id === step.id && !current.found) tourNext();
  }, [step, rect]);

  useEffect(() => {
    if (!step) return;
    const handler = () => void refreshRect();
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [step, refreshRect]);

  // ツールチップの実寸を測って位置を決める（画面外へはみ出さない）。
  useIsomorphicLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    setTooltipSize({ width: box.width, height: box.height });
  }, [step, state.index, rect]);

  // キーボード操作（Esc で終了、←→ で移動）。
  useEffect(() => {
    if (!state.page) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        stopTour();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        tourNext();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        tourPrev();
      }
      if (event.key === "Tab") {
        // ダイアログ内で Tab を循環させる（背景のリンクへ抜けさせない）。
        const root = tooltipRef.current;
        if (!root) return;
        const focusable = Array.from(
          root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
        ).filter((element) => element.getClientRects().length > 0);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        // 開始直後は dialog 自身（tabIndex=-1）にフォーカスがある。そのまま Shift+Tab すると
        // ブラウザは DOM 上の直前（背景）へ抜けるため、dialog 自身も端として扱う（T07）。
        const atRoot = active === root;
        if (event.shiftKey && (atRoot || active === first || !root.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (atRoot || active === last || !root.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.page]);

  const viewport = visibleViewport();
  const position = useMemo(() => {
    const viewportWidth = viewport.width;
    const viewportHeight = viewport.height;
    const width = Math.min(TOOLTIP_MAX_WIDTH, viewportWidth - MARGIN * 2);
    // 実測値が古い・画面より高い場合でも、はみ出さない高さで計算する。
    const height = Math.min(tooltipSize.height, viewportHeight - MARGIN * 2);
    if (!rect) {
      return { left: MARGIN, top: Math.max(MARGIN, viewportHeight - height - MARGIN), width };
    }
    const spaceBelow = viewportHeight - (rect.top + rect.height) - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    // 下に入るなら下、入らなければ上、どちらも狭ければ画面下に固定（スマホ）。
    const placeBelow = spaceBelow >= height || spaceBelow >= spaceAbove;
    const top = placeBelow
      ? clamp(rect.top + rect.height + MARGIN, MARGIN, viewportHeight - height - MARGIN)
      : clamp(rect.top - height - MARGIN, MARGIN, viewportHeight - height - MARGIN);
    const left = clamp(rect.left, MARGIN, viewportWidth - width - MARGIN);
    return { left, top, width };
  }, [rect, tooltipSize.height, viewport.width, viewport.height]);

  if (!mounted) return null;

  if (!state.page || !step) {
    return showIntro && introSlot ? createPortal(
      (
      <div className="oc-tour-intro" role="region" aria-label="はじめての方へ">
        <span className="oc-tour-intro-text">はじめての方へ: 使い方ツアーを見る</span>
        <button
          type="button"
          className="oc-btn oc-btn-primary oc-btn-sm"
          onClick={() => {
            // 未対応の画面・権限不足では案内を消費したまま何も起こさない、を避ける（T06）。
            // 開始できたときだけ記録して閉じ、できなければ実際に使えるヘルプへ送る。
            if (!startTour()) {
              window.location.assign("/help/#tour");
              return;
            }
            dismissIntro();
            setShowIntro(false);
          }}
        >
          ツアー開始
        </button>
        <a className="oc-btn oc-btn-sm" href="/help/">
          ヘルプ
        </a>
        <button
          type="button"
          className="oc-btn oc-btn-sm"
          aria-label="案内を閉じる"
          onClick={() => {
            dismissIntro();
            setShowIntro(false);
          }}
        >
          閉じる
        </button>
        <TourStyles />
      </div>
      ),
      introSlot,
    ) : null;
  }

  const definition = tourDefinitionOf(state.page);
  const last = isLastStep(state);
  // helpPath は基準 URL（`/help/` など）。アンカーは手順側だけを使い、二重にならないようにする。
  const helpHref = `${definition.helpPath.replace(/#.*$/, "")}${step.helpAnchor ?? ""}`;

  return createPortal(
    <>
      <TourStyles />
      {/* 背景を暗くし、対象だけを抜いて見せる */}
      <div className="oc-tour-backdrop" aria-hidden="true" />
      {rect ? (
        <div
          className="oc-tour-spot"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          aria-hidden="true"
        />
      ) : null}
      <div
        ref={tooltipRef}
        className="oc-tour-tooltip"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={`${definition.label}の使い方`}
        aria-live="polite"
        data-tour-target={step.selector}
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          // dvh は環境によって基準が変わるため、実測した innerHeight から px で制限する。
          maxHeight: Math.max(120, viewport.height - MARGIN * 2),
        }}
      >
        <div className="oc-tour-tooltip-head">
          <span className="oc-tour-tooltip-label">{definition.label}の使い方</span>
          <button type="button" className="oc-tour-close" onClick={stopTour} aria-label="ツアーを終了">
            ✕
          </button>
        </div>
        <div className="oc-tour-tooltip-body">
          <h2 className="oc-tour-tooltip-title">{step.title}</h2>
          <p className="oc-tour-tooltip-text">{step.body}</p>
          <a className="oc-tour-tooltip-help" href={helpHref} onClick={stopTour}>
            もっと詳しく（ヘルプ）
          </a>
        </div>
        <div className="oc-tour-tooltip-foot">
          <span className="oc-tour-progress">
            {state.index + 1} / {state.steps.length}
          </span>
          <button type="button" className="oc-btn oc-btn-sm" onClick={tourPrev} disabled={state.index === 0}>
            戻る
          </button>
          {last ? (
            <a className="oc-btn oc-btn-primary oc-btn-sm" href={helpHref} onClick={stopTour}>
              ヘルプで詳しく
            </a>
          ) : (
            <button type="button" className="oc-btn oc-btn-primary oc-btn-sm" onClick={tourNext}>
              次へ
            </button>
          )}
          <button type="button" className="oc-btn oc-btn-sm" onClick={stopTour}>
            終了
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** ツアー専用のスタイル（サイトの緑系に合わせる。外部 CSS を持ち込まない）。 */
function TourStyles() {
  return (
    <style>{`
.oc-tour-intro {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-wrap: wrap;
  box-sizing: border-box;
  width: 100%;
  padding: 6px 10px;
  background: #f2fbf2;
  border-bottom: 1px solid #7bb87b;
  font-size: 12px;
  color: #123d18;
}
.oc-tour-intro-text { font-weight: 700; }
.oc-tour-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0,0,0,.45);
  pointer-events: auto;
}
.oc-tour-spot {
  position: fixed;
  z-index: 201;
  border: 2px solid #228811;
  border-radius: 4px;
  box-shadow: 0 0 0 9999px rgba(0,0,0,.45), 0 0 0 4px rgba(204,255,204,.9);
  background: transparent;
  pointer-events: none;
  transition: top .12s ease, left .12s ease, width .12s ease, height .12s ease;
}
.oc-tour-tooltip {
  position: fixed;
  z-index: 202;
  max-height: calc(100dvh - 24px);
  overflow-y: auto;
  background: #fff;
  border: 1px solid #228811;
  box-shadow: 0 6px 20px rgba(0,0,0,.3);
  font-size: 13px;
  color: #111;
}
.oc-tour-tooltip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  background: #ccffcc;
  border-bottom: 1px solid #7bb87b;
}
.oc-tour-tooltip-label { font-weight: 700; font-size: 12px; color: #123d18; }
.oc-tour-close {
  border: 1px solid #7bb87b;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 3px 6px;
}
.oc-tour-tooltip-body { padding: 8px 10px 4px; }
.oc-tour-tooltip-title { margin: 0 0 4px; font-size: 15px; color: #145022; }
.oc-tour-tooltip-text { margin: 0; line-height: 1.6; }
.oc-tour-tooltip-help {
  display: inline-block;
  margin-top: 6px;
  font-size: 12px;
  color: #0000ee;
  text-decoration: underline;
}
.oc-tour-tooltip-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px 10px;
  border-top: 1px solid #d8e8d8;
}
.oc-tour-progress { margin-right: auto; font-size: 11px; color: #555; }
/* 360px 前後ではツールチップを画面幅に収め、操作を 44px 程度にする */
@media (max-width: 640px) {
  .oc-tour-tooltip-text { font-size: 13px; }
  .oc-tour-tooltip-foot .oc-btn { min-height: 40px; }
  .oc-tour-intro {
    padding: 6px 8px;
    font-size: 11.5px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .oc-tour-spot { transition: none; }
}
`}</style>
  );
}