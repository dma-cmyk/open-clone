"use client";

// 画面に近づいた要素だけを起動する IntersectionObserver。
//
// スレ画面はレス 1 件ごとに post-actions スロットを置く（最大 1000 件）。
// 要素ごとに observer を作ると 1000 個になるため、モジュールで 1 つだけ共有する。

type NearCallback = () => void;

let observer: IntersectionObserver | null = null;
const callbacks = new WeakMap<Element, NearCallback>();

function sharedObserver(): IntersectionObserver | null {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return null;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = callbacks.get(entry.target);
        if (!callback) continue;
        // 一度起動したら監視をやめる（スロットはマウント後も残る）。
        callbacks.delete(entry.target);
        observer?.unobserve(entry.target);
        callback();
      }
    },
    // 画面端から 400px 手前で起動する（スクロールして来たときに空の枠を見せない）。
    { rootMargin: "400px 0px" },
  );
  return observer;
}

/** 要素が画面（+400px）に近づいたら 1 回だけ callback を呼ぶ。解除関数を返す。 */
export function observeNearViewport(element: Element, callback: NearCallback): () => void {
  const io = sharedObserver();
  if (!io) {
    // IntersectionObserver が無い環境では遅延しない（表示されないより良い）。
    callback();
    return () => {};
  }
  callbacks.set(element, callback);
  io.observe(element);
  return () => {
    callbacks.delete(element);
    io.unobserve(element);
  };
}