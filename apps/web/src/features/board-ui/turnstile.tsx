"use client";

// Cloudflare Turnstile ウィジェット（Bot 対策 / CONTRACTS §4.2）。
// ローカル・CI は公式テストキー。本番は NEXT_PUBLIC_TURNSTILE_SITE_KEY を設定する。

import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

// グローバル宣言は他の同名宣言と衝突するため行わない。外部スクリプトが生やす API を
// 構造的に読む（型はこのファイル内の TurnstileApi に限定）。
function turnstileApi(): TurnstileApi | undefined {
  const globals = window as unknown as { turnstile?: TurnstileApi };
  return globals.turnstile;
}

export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA";

const SCRIPT_ID = "cf-turnstile-script";
let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (turnstileApi()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  // lib ES2022 には Promise.withResolvers が無いため executor 形式を使う。
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Turnstile の読み込みに失敗しました")));
      return;
    }
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile の読み込みに失敗しました"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function TurnstileWidget({
  onToken,
  resetKey = 0,
  compact = false,
}: {
  onToken: (token: string) => void;
  resetKey?: number;
  compact?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!TURNSTILE_SITE_KEY) {
      setFailed(true);
      return;
    }
    loadScript()
      .then(() => {
        const api = turnstileApi();
        if (!alive || !container.current || !api) return;
        if (widgetId.current) {
          api.reset(widgetId.current);
          return;
        }
        widgetId.current = api.render(container.current, {
          sitekey: TURNSTILE_SITE_KEY,
          size: compact ? "compact" : "normal",
          theme: "light",
          language: "ja",
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(""),
          "error-callback": () => setFailed(true),
        });
      })
      .catch(() => {
        if (alive) setFailed(true);
      });

    return () => {
      alive = false;
    };
    // onToken は呼び出し側で安定させる（useCallback）前提。
  }, [compact, onToken, resetKey]);

  useEffect(
    () => () => {
      const api = turnstileApi();
      if (widgetId.current && api) {
        api.remove(widgetId.current);
        widgetId.current = null;
      }
    },
    [],
  );

  return (
    <div className="oc-turnstile">
      <div ref={container} />
      {failed ? (
        <p className="oc-note" role="status">
          Bot 確認を読み込めませんでした（ネットワークまたは Turnstile 設定を確認してください）。
        </p>
      ) : null}
    </div>
  );
}