// 「ペット」を開く合図（ヘッダーのボタン → 全ページに置いた本体）。
//
// ヘッダーと本体は別の React ツリー（ヘッダーはシェル／Next ページ、本体はルートレイアウト）に
// あるため、小さなストアでつなぐ。開いたら「しまう」も解除する（本体側で保存する）。

const listeners = new Set<() => void>();

export function requestPetOpen(): void {
  for (const listener of listeners) listener();
}

export function subscribePetOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}