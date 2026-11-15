// 静的エクスポート用の軽量クライアントルーター（DESIGN §A-2）。
// `output:'export'` では動的セグメントの総当り生成ができないため、シェル HTML + クライアント
// ルーティングで `/b/:slug` や `/b/:slug/t/:id` を解決する。Next Link は使わず pushState で遷移する。
//
// 画面は 2 種類に分かれる:
//  1. シェル（このファイルが解決する /, /b/**, /boards/new, /settings, /b/**\/manage）
//  2. Next の個別ページ（/search, /plugins/**, /ranking, /headline, /account/**, /admin/**）
// 2 系の画面ではシェルの React ツリーが存在しない。そこで pushState だけすると URL は変わるのに
// 描画が変わらない（＝前の画面が残る）。そのため「シェルが描画中 かつ 遷移先もシェル」のときだけ
// pushState し、それ以外はブラウザ標準のフルページ遷移に任せる。判断は Link / navigate の両方で共通。
//
// 反対方向（Next ページ → シェル）も同じ関数で守られる: シェル内の SiteHeader を Next ページが
// 再利用しているため、`Link` が「シェル未描画」を検知して通常の <a> として動く必要がある。

import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type Route =
  | { name: "home" }
  | { name: "board"; slug: string }
  | { name: "thread"; slug: string; threadId: number }
  | { name: "board-new" }
  | { name: "settings" }
  | { name: "manage"; slug: string; tab: string }
  | { name: "unknown"; pathname: string };

/** シェルが描画中か（AppShell の mount で true）。SSR では false。 */
let shellActive = false;

/** AppShell が呼ぶ。アンマウントで false に戻す。 */
export function setShellActive(active: boolean): void {
  shellActive = active;
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** href を「同一オリジンの pathname + search」に正規化する（別オリジン・mailto 等は null）。 */
function sameOriginPath(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  try {
    const url = new URL(href, "http://shell.invalid");
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * この href をシェル内の pushState で処理してよいか。
 * シェル未描画（Next の個別ページ上）や、遷移先が Next の個別ページなら false。
 */
export function canHandleInShell(href: string): boolean {
  if (typeof window === "undefined" || !shellActive) return false;
  const path = sameOriginPath(href);
  if (path === null) return false;
  return isShellPath(path.split("?")[0] ?? "/");
}

/** シェルが担当するパスか（/search や /plugins など Next の個別ページは false）。 */
export function isShellPath(pathname: string): boolean {
  return parseRoute(pathname).name !== "unknown";
}

export function navigate(href: string, options: { replace?: boolean; keepScroll?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  if (!canHandleInShell(href)) {
    // 別オリジン・別方式（Next の個別ページ）・シェル未描画はブラウザに任せる。
    if (options.replace) {
      window.location.replace(href);
    } else {
      window.location.assign(href);
    }
    return;
  }
  if (options.replace) {
    window.history.replaceState({}, "", href);
  } else {
    window.history.pushState({}, "", href);
  }
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
  const handler = () => emit();
  window.addEventListener("popstate", handler);
  return () => {
    window.removeEventListener("popstate", handler);
    listening = false;
  };
}

function readLocation(): string {
  return typeof window === "undefined" ? "" : window.location.pathname + window.location.search;
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

/** 同一オリジン内の遷移を pushState で行うアンカー。シェル外（Next ページ）や対象外パスは通常遷移。 */
export function Link({ href, replace, onClick, children, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (rest.target && rest.target !== "_self") {
      return;
    }
    if (!canHandleInShell(href)) {
      // シェル外のページや Next の個別ページへはブラウザ標準の遷移（フルページ読み込み）に委ねる。
      return;
    }
    event.preventDefault();
    navigate(href, { replace });
  };
  return createElement("a", { href, onClick: handleClick, ...rest }, children);
}