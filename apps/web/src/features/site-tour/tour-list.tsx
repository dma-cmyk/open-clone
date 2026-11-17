"use client";

// ヘルプ `#tour` のツアー一覧。
//
// - 行は `TOUR_DEFINITIONS`（`TOUR_LIST_DEFINITIONS`）から作る。画面を足してもここは直さない。
// - 押すと対象の画面へ移動し、移動先の `TourHost` が準備を待って開始する
//   （予約は `reserveTourStart`。画面をまたぐ開始の仕組みは `pending-start.ts` に集約）。
// - 管理系の行（管理画面・板の管理）は、権限が分かってから出す。
// - 板・スレの開く先は API で自動選択する（無ければ行を無効にして理由を出す）。

import { useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "@/app/_shell/router";
import { ANONYMOUS_TOUR_LIST_CONTEXT, loadTourListContext } from "./list-context";
import { reserveTourStart, startTour, tourHelpHref, tourPageKeyForPath } from "./store";
import { TOUR_LIST_DEFINITIONS } from "./steps";
import type { TourListContext, TourPageKey } from "./types";

/** 開く先の解決結果（undefined = まだ調べ中）。 */
type EntryHref = string | null;

function TourListStyles() {
  return (
    <style>{`
.oc-tour-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.oc-tour-list-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid #cfe2cf;
  border-radius: 6px;
  background: #fbfffb;
}
.oc-tour-list-main { flex: 1 1 220px; min-width: 0; }
.oc-tour-list-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.oc-tour-list-name { font-weight: 700; color: #145022; }
.oc-tour-list-count { font-size: 11px; color: #555; }
.oc-tour-list-summary { margin: 2px 0 0; font-size: 12px; color: #333; line-height: 1.5; }
.oc-tour-list-action { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.oc-tour-list-reason { font-size: 11px; color: #8a3b12; max-width: 240px; text-align: right; }
.oc-tour-list-loading { font-size: 12px; color: #555; }
@media (max-width: 640px) {
  .oc-tour-list-item { flex-direction: column; }
  /* 縦並びでは flex-basis が高さになる。行の高さを内容に合わせる。 */
  .oc-tour-list-main { flex: 0 0 auto; width: 100%; }
  .oc-tour-list-action { width: 100%; align-items: stretch; }
  .oc-tour-list-action .oc-btn { min-height: 40px; }
  .oc-tour-list-reason { text-align: left; max-width: none; }
}
`}</style>
  );
}

export function TourList() {
  // 取得前は「未ログイン相当」で始める（管理系の行は取得後に出す）。
  const [context, setContext] = useState<TourListContext>(ANONYMOUS_TOUR_LIST_CONTEXT);
  const [hrefs, setHrefs] = useState<Partial<Record<TourPageKey, EntryHref>>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    loadTourListContext()
      .then((next) => {
        if (!cancelled) setContext(next);
      })
      .catch(() => {
        // 取得できなくても一覧は出す（管理系は出さない）。
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);

  const rows = useMemo(
    () => TOUR_LIST_DEFINITIONS.filter(({ definition }) => definition.listVisible?.(context) ?? true),
    [context],
  );

  // 開く先を解決する（板・スレは API で選ぶため非同期）。1 行 1 回だけ調べる。
  const resolvingRef = useRef(new Set<TourPageKey>());
  useEffect(() => {
    for (const { page, definition } of rows) {
      const entry = definition.entry;
      if (!entry) continue;
      if (page in hrefs || resolvingRef.current.has(page)) continue;
      resolvingRef.current.add(page);
      void Promise.resolve()
        .then(() => entry(context))
        .then((href) => {
          if (mountedRef.current) setHrefs((prev) => ({ ...prev, [page]: href }));
        })
        .catch(() => {
          if (mountedRef.current) setHrefs((prev) => ({ ...prev, [page]: null }));
        })
        .finally(() => {
          resolvingRef.current.delete(page);
        });
    }
  }, [rows, context, hrefs]);

  const startFromList = (page: TourPageKey, href: string): void => {
    // いまの画面のツアーなら移動せずに始める（同じ URL へは遷移しない）。
    if (tourPageKeyForPath(window.location.pathname) === page) {
      if (!startTour(page)) window.location.assign(tourHelpHref(page));
      return;
    }
    // 予約 → 移動。移動先の TourHost が準備（権限の読み込み・手順の描画）を待って開始する。
    reserveTourStart(page);
    navigate(href);
  };

  return (
    <div className="oc-stack" style={{ gap: 8 }}>
      <ul className="oc-tour-list" data-tour="tour-list" aria-label="ツアーの一覧">
        {rows.map(({ page, definition }) => {
          const href = hrefs[page];
          const resolved = href !== undefined;
          const disabled = !resolved || href === null;
          return (
            <li key={page} className="oc-tour-list-item" data-tour-page={page}>
              <div className="oc-tour-list-main">
                <div className="oc-tour-list-head">
                  <span className="oc-tour-list-name">{definition.label}</span>
                  <span className="oc-tour-list-count">{definition.steps.length} 手順</span>
                </div>
                <p className="oc-tour-list-summary">{definition.summary}</p>
              </div>
              <div className="oc-tour-list-action">
                <button
                  type="button"
                  className="oc-btn oc-btn-primary oc-btn-sm"
                  disabled={disabled}
                  aria-describedby={href === null ? `oc-tour-list-reason-${page}` : undefined}
                  onClick={() => {
                    if (href) startFromList(page, href);
                  }}
                >
                  {resolved ? "このツアーを始める" : "開く先を確認中…"}
                </button>
                {href === null ? (
                  <span id={`oc-tour-list-reason-${page}`} className="oc-tour-list-reason">
                    いま案内できる画面が見つかりませんでした（板やスレがまだ無いときは開けません）。
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <TourListStyles />
    </div>
  );
}