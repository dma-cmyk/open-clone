"use client";

// Turnstile ウィジェット（登録・ログインの異常検知時に使用）。
// NEXT_PUBLIC_TURNSTILE_SITE_KEY 未設定なら何も描画しない（ローカル開発）。
// グローバル宣言は WP2 と衝突するため行わず、window の型付きアクセサ経由で扱う。

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
    existing.addEventListener("load", onReady, { once: true });
    existing.addEventListener("error", onError, { once: true });
    return;
  }
  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.src = SCRIPT_SRC;
  script.async = true;
  script.defer = true;
  script.addEventListener("load", onReady, { once: true });
  script.addEventListener("error", onError, { once: true });
  document.head.appendChild(script);
}

export function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let widgetId: string | null = null;
    let cancelled = false;

    loadScript(
      () => {
        const api = getTurnstile();
        if (cancelled || !containerRef.current || !api) return;
        widgetId = api.render(containerRef.current, {
          sitekey: siteKey,
          theme: "light",
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      },
      () => onToken(null),
    );

    return () => {
      cancelled = true;
      const api = getTurnstile();
      if (widgetId && api) api.remove(widgetId);
    };
  }, [siteKey, onToken]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="oc-mb" />;
}