"use client";

// アプリシェル。静的エクスポート + クライアントルーティングのディスパッチャ。
// 本番は Vercel の rewrite で全パスが index.html（このシェル）に落ち、pathname から画面を決める。
import { useEffect, useState } from "react";
// WP3 のプラグインホスト（sandbox ランナー）をスロットへ登録する。
import "@/features/plugin-host/register";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";
import { BoardSidebar } from "./board-sidebar";
import { setShellActive, startRouter, useRoute, type Route } from "./router";
import { SITE_NAME, usePageTitle } from "@/lib/title";
import { HomeView } from "./views/home-view";
import { BoardView } from "./views/board-view";
import { ThreadView } from "./views/thread-view";
import { BoardNewView } from "./views/board-new-view";
import { SettingsView } from "./views/settings-view";
import { ManageView } from "./views/manage-view";
import { NotFoundView } from "./views/not-found-view";

/**
 * ルートごとの既定タイトル。データを待たずに切り替えるための保険で、
 * 詳細（スレタイ・板名）を持つ画面は自分で上書きする（スレ画面など）。
 * 画面より先に render して effect の順序を前にする（後から来る詳細タイトルが勝つ）。
 */
function RouteTitle({ route }: { route: Route }) {
  const label = (() => {
    switch (route.name) {
      case "home":
        return SITE_NAME;
      case "board":
        return `${route.slug} 板`;
      case "thread":
        return `スレッド ${route.threadId}`;
      case "board-new":
        return "板を作る";
      case "settings":
        return "設定";
      case "manage":
        return `${route.slug} 板の管理`;
      default:
        return "ページが見つかりません";
    }
  })();
  usePageTitle(label);
  return null;
}

export function AppShell() {
  useEffect(() => startRouter(), []);
  // シェルが描画中であることをルーターへ伝える（Next の個別ページ上では false のまま）。
  // pushState してよいかの判断に使う。アンマウントで false に戻す。
  useEffect(() => {
    setShellActive(true);
    return () => setShellActive(false);
  }, []);
  // 静的エクスポートでは index.html が常に「/」として生成される。SSR とハイドレーション初回は
  // ホームを描き、マウント後に実際の pathname へ切り替える（直リンク時の不一致を防ぐ）。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const route = useRoute();
  const effectiveRoute = mounted ? route : ({ name: "home" } as const);

  let content: React.ReactNode;
  switch (effectiveRoute.name) {
    case "home":
      content = <HomeView />;
      break;
    case "board":
      content = <BoardView slug={effectiveRoute.slug} />;
      break;
    case "thread":
      content = <ThreadView slug={effectiveRoute.slug} threadId={effectiveRoute.threadId} />;
      break;
    case "board-new":
      content = <BoardNewView />;
      break;
    case "settings":
      content = <SettingsView />;
      break;
    case "manage":
      content = <ManageView slug={effectiveRoute.slug} tab={effectiveRoute.tab} />;
      break;
    default:
      content = <NotFoundView pathname={effectiveRoute.pathname} />;
  }

  return (
    <div className="oc-app" id="top">
      {/* 画面より先に評価して、遷移直後に前のページのタイトルが残らないようにする */}
      <RouteTitle route={effectiveRoute} />
      <SiteHeader />
      <div className="oc-layout">
        <BoardSidebar />
        <main className="oc-main">{content}</main>
      </div>
      <SiteFooter />
    </div>
  );
}