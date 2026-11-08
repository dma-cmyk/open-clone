// 静的エクスポート用の軽量クライアントルーター（DESIGN §A-2）。
// `output:'export'` では動的セグメントの総当り生成ができないため、シェル HTML + クライアント
// ルーティングで `/b/:slug` や `/b/:slug/t/:id` を解決する。Next Link は使わず pushState で遷移する。

import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type Route =
  | { name: "home" }
  | { name: "board"; slug: string }
  | { name: "thread"; slug: string; threadId: number }
  | { name: "board-new" }
  | { name: "settings" }
  | { name: "manage"; slug: string; tab: string }
  | { name: "unknown"; pathname: string };

const listeners = new Set<() => void>();
let snapshot = "";

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function ensureSnapshot(): void {
  if (snapshot === "" && typeof window !== "undefined") {
    snapshot = window.location.pathname + window.location.search;
  }
}

export function navigate(href: string, options: { replace?: boolean; keepScroll?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  if (/^(https?:)?\/\//.test(href) || href.startsWith("mailto:") || href.startsWith("#")) {
    window.location.href = href;
    return;
  }
  if (options.replace) {
    window.history.replaceState({}, "", href);
  } else {
    window.history.pushState({}, "", href);
  }
  snapshot = window.location.pathname + window.location.search;
  emit();
  if (!options.keepScroll) {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

export function subscribeLocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let listening = false;

/** ブラウザの戻る/進むを購読する（AppShell の mount 時に一度だけ呼ぶ）。 */
export function startRouter(): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  if (listening) {
    return () => undefined;
  }
  listening = true;
  const handler = () => {
    snapshot = window.location.pathname + window.location.search;
    emit();
  };
  window.addEventListener("popstate", handler);
  return () => {
    window.removeEventListener("popstate", handler);
    listening = false;
  };
}

function readLocation(): string {
  ensureSnapshot();
  return snapshot;
}

/** pathname + search。SSR では空文字。 */
export function useLocation(): string {
  return useSyncExternalStore(subscribeLocation, readLocation, () => "");
}

export function usePathname(): string {
  const location = useLocation();
  if (!location) {
    return typeof window === "undefined" ? "" : window.location.pathname;
  }
  return location.split("?")[0] ?? "/";
}

export function useSearchParams(): URLSearchParams {
  const location = useLocation();
  const search = location.includes("?") ? location.slice(location.indexOf("?")) : "";
  return new URLSearchParams(typeof window === "undefined" ? "" : search || window.location.search);
}

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "") {
    return { name: "home" };
  }
  const manage = path.match(/^\/b\/([^/]+)\/manage(?:\/([^/]+))?$/);
  if (manage?.[1]) {
    return { name: "manage", slug: decodeURIComponent(manage[1]), tab: manage[2] ?? "basic" };
  }
  const thread = path.match(/^\/b\/([^/]+)\/t\/(\d+)$/);
  if (thread?.[1] && thread[2]) {
    return { name: "thread", slug: decodeURIComponent(thread[1]), threadId: Number(thread[2]) };
  }
  const board = path.match(/^\/b\/([^/]+)$/);
  if (board?.[1]) {
    return { name: "board", slug: decodeURIComponent(board[1]) };
  }
  // open2ch 風 URL: /test/read.cgi/<board>/<key>/... も同じシェルで受ける
  const compat = path.match(/^\/test\/read\.cgi\/([^/]+)\/(\d+)(?:\/([^/]+))?$/);
  if (compat?.[1] && compat[2]) {
    return { name: "thread", slug: decodeURIComponent(compat[1]), threadId: Number(compat[2]) };
  }
  if (path === "/boards/new") {
    return { name: "board-new" };
  }
  if (path === "/settings") {
    return { name: "settings" };
  }
  return { name: "unknown", pathname: path };
}

export function useRoute(): Route {
  const pathname = usePathname();
  return parseRoute(pathname);
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  replace?: boolean;
}

/** 同一オリジン内の遷移を pushState で行うアンカー。別ルート（WP3/WP6 の画面等）は通常遷移。 */
export function Link({ href, replace, onClick, children, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (!href.startsWith("/") || href.startsWith("//")) {
      return;
    }
    event.preventDefault();
    navigate(href, { replace });
  };
  return createElement("a", { href, onClick: handleClick, ...rest }, children);
}