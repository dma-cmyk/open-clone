// ページタイトル（ブラウザのタブ名）の一元管理。
//
// シェルは 1 枚の HTML をクライアントで切り替えるため、`document.title` を明示的に更新しないと
// 「前のスレ名」がタブに残る。全ページがこの hook を通し、画面ごとに 1 つだけタイトルを主張する。
//
// 注意: `document.title = ...` と書いても、その直後に Next のメタデータ同期
// （サーバー HTML の <title> 要素をクライアントで再適用する処理）が走ると元に戻る。
// 実測（/settings を直接開く）では、こちらの代入が 1 回成功したあと <title> 要素の
// テキストが差し替えられ、「おーぷんクローン」に戻っていた。そのため `<title>` 要素だけを
// 監視し、書き換えられたら自分の値へ戻す（head 全体は監視しない）。

import { useEffect } from "react";

export const SITE_NAME = "おーぷんクローン";

/** layout.tsx の metadata.title.template と同じ書式（`%s ｜ おーぷんクローン`）。 */
export function pageTitle(label: string | null | undefined): string {
  const value = (label ?? "").trim();
  if (!value || value === SITE_NAME) return SITE_NAME;
  return `${value} ｜ ${SITE_NAME}`;
}

/**
 * 最後にタイトルを主張した画面の番号。親（AppShell の既定タイトル）より
 * 子（スレ画面の詳細タイトル）が後に主張するため、番号が大きいほうが勝つ。
 */
let titleOwner = 0;

/**
 * その画面のタイトルを設定する。`null` を渡すと設定しない（データ待ち）。
 * アンマウント時に戻さないのは、次の画面が自分で設定するため（戻すと一瞬だけ前の名前が出る）。
 */
export function usePageTitle(label: string | null | undefined): void {
  const value = label == null ? null : pageTitle(label);
  useEffect(() => {
    if (typeof document === "undefined" || value === null) return;
    titleOwner += 1;
    const owner = titleOwner;

    let textObserver: MutationObserver | null = null;
    let headObserver: MutationObserver | null = null;

    const apply = () => {
      // 後から別の画面が主張したら、その画面のタイトルを尊重して黙る（監視も外す）。
      if (owner !== titleOwner) {
        stop();
        return;
      }
      if (document.title !== value) document.title = value;
    };

    /** `<title>` 要素の文字だけを見る（要素ごと差し替わったら head 側で拾い直す）。 */
    const watchTitleElement = () => {
      const element = document.querySelector("title");
      if (!element) return;
      textObserver?.disconnect();
      textObserver = new MutationObserver(apply);
      textObserver.observe(element, { characterData: true, childList: true, subtree: true });
    };

    const stop = () => {
      textObserver?.disconnect();
      headObserver?.disconnect();
      textObserver = null;
      headObserver = null;
    };

    apply();
    watchTitleElement();
    // 監視するのは <title> の差し替え（head 直下の子要素の増減）だけ。
    headObserver = new MutationObserver(() => {
      if (owner !== titleOwner) {
        stop();
        return;
      }
      apply();
      watchTitleElement();
    });
    headObserver.observe(document.head, { childList: true });

    return stop;
  }, [value]);
}