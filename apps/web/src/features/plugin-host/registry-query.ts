// プラグイン一覧（`/plugins`）のタブ決定と「最後の取得だけを反映する」ガード。
//
// 背景（報告書40 §10）: `/plugins/?tab=mine` を直接開くと一覧が 0 件になる。
//  1) `useQueryParam` は初回レンダーで null を返すため、いったん「公開プラグイン」で取得が走り、
//     effect でタブが mine に変わり 2 回目の取得が走る（1 ページ表示で 2 リクエスト）。
//  2) 先に投げた公開一覧の応答が後から届くと、mine の結果を上書きしてしまう（順序の競合）。
// 対策はこの 2 つ: URL から初期タブを同期的に決めて余計な取得を無くし、
// 取得ごとの世代番号で「最後に開始した取得」以外の応答を捨てる。

export type RegistryTab = "public" | "mine" | "installed";

/** `?tab=` から初期タブを決める（未知の値・未指定は公開一覧）。 */
export function initialRegistryTab(search: string): RegistryTab {
  const value = new URLSearchParams(search).get("tab");
  return value === "mine" || value === "installed" ? value : "public";
}

export interface LatestOnly {
  /** 取得を開始する。返した世代番号を結果の適用時に `isCurrent` へ渡す。 */
  begin(): number;
  /** その世代が最新かどうか（false なら結果を捨てる）。 */
  isCurrent(token: number): boolean;
}

/** 世代番号で「最後に開始した取得」だけを最新とみなす。 */
export function createLatestOnly(): LatestOnly {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
  };
}