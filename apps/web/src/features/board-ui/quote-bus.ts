// レス番号クリック → 投稿欄へ `>>n` を挿入するためのイベントバス。
// スレッド内の複数フォーム（通常/浮き窓）が同じイベントを購読する。

const EVENT = "oc:quote";

export function quotePost(num: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<number>(EVENT, { detail: num }));
}

export function onQuote(handler: (num: number) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<number>).detail;
    if (typeof detail === "number") {
      handler(detail);
    }
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}