"use client";

// Turnstile ウィジェット（登録・ログインの異常検知時に使用）。
// NEXT_PUBLIC_TURNSTILE_SITE_KEY 未設定なら何も描画しない（ローカル開発）。
// グローバル宣言は WP2 と衝突するため行わず、window の型付きアクセサ経由で扱う。
//
// トークンは API 側の siteverify で 1 回使うと無効になる（本物と同じ）。送信が
// 成功以外で終わったら `resetKey` を進めてウィジェットを取り直し、新しいトークンを
// 受け取るまで呼び出し側は送信させない（同じ値の再送で 400 TURNSTILE_FAILED にしない）。

import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
    },
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

function getTurnstile(): TurnstileApi | undefined {
  // Turnstile は @types を提供しないサードパーティの window グローバル
  return (window as Window & { turnstile?: TurnstileApi }).turnstile;
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** スクリプトを読み込み、完了時にコールバックする（Promise 不要）。 */
function loadScript(onReady: () => void, onError: () => void): void {
  if (getTurnstile()) {
    onReady();
    return;
  }
  const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    if (existing.dataset.turnstileState === "error") {
      existing.remove();
    } else if (existing.dataset.turnstileState === "loaded") {
      onError();
      return;
    } else {
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener("error", onError, { once: true });
      return;
    }
  }
  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = SCRIPT_SRC;
  script.async = true;
  script.defer = true;
  script.dataset.turnstileState = "loading";
  script.addEventListener(
    "load",
    () => {
      script.dataset.turnstileState = "loaded";
      onReady();
    },
    { once: true },
  );
  script.addEventListener(
    "error",
    () => {
      script.dataset.turnstileState = "error";
      script.remove();
      onError();
    },
    { once: true },
  );
  document.head.appendChild(script);
}

export function TurnstileWidget({
  onToken,
  onUnavailable,
  resetKey = 0,
}: {
  /** トークン取得・失効の通知。呼び出し側で安定させる（useCallback）前提。 */
  onToken: (token: string | null) => void;
  /**
   * ウィジェットを用意できない（サイトキー未設定・スクリプト読み込み失敗）ときに呼ぶ。
   * 呼び出し側は「新しいトークン待ち」で送信ボタンを閉じたままにしない。
   */
  onUnavailable?: () => void;
  /** 増やすとウィジェットをリセットして新しいトークンを取り直す（トークンは 1 回限り）。 */
  resetKey?: number;
}) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const renderedKeyRef = useRef<number | null>(null);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    if (!siteKey) {
      unavailableRef.current?.();
      return;
    }
    if (!containerRef.current) return;
    let cancelled = false;

    loadScript(
      () => {
        const api = getTurnstile();
        if (cancelled || !containerRef.current || !api) return;
        if (widgetIdRef.current) {
          // React の再マウントや resetKey 変更で同じコンテナに 2 個目を積まない
          // （実ウィジェットの reset はウィジェットを生かしたまま新しいトークンを発行する）。
          if (renderedKeyRef.current !== resetKey) {
            renderedKeyRef.current = resetKey;
            api.reset(widgetIdRef.current);
          }
          return;
        }
        renderedKeyRef.current = resetKey;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          theme: "light",
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          // チャレンジ自体が失敗したときは新しいトークンが来ない。送信を閉じたままにしない。
          "error-callback": () => {
            onToken(null);
            unavailableRef.current?.();
          },
        });
      },
      () => {
        onToken(null);
        if (!cancelled) unavailableRef.current?.();
      },
    );

    return () => {
      cancelled = true;
    };
  }, [siteKey, onToken, resetKey]);

  useEffect(
    () => () => {
      const api = getTurnstile();
      if (widgetIdRef.current && api) {
        api.remove(widgetIdRef.current);
        widgetIdRef.current = null;
        renderedKeyRef.current = null;
      }
    },
    [],
  );

  if (!siteKey) return null;
  return <div ref={containerRef} className="oc-mb" />;
}