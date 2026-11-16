"use client";

// フッターの「使い方ツアー」リンク。今いる画面のツアーを開始する。
// （フッターはサーバーコンポーネント的に使われるため、クリック処理だけ切り出す）

import { startTour } from "./store";

export function TourFooterLinks() {
  return (
    <button
      type="button"
      className="oc-footer-tour"
      onClick={() => {
        // 未対応の画面・権限が足りない画面ではヘルプへ（何も起きない操作にしない）
        if (!startTour()) window.location.assign("/help/#tour");
      }}
      title="いま開いている画面の使い方を順に案内します"
    >
      使い方ツアー
    </button>
  );
}