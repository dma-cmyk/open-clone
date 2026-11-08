"use client";

// アプリシェル。静的エクスポート + クライアントルーティングのディスパッチャ。
// 本番は Vercel の rewrite で全パスが index.html（このシェル）に落ち、pathname から画面を決める。
import { useEffect, useState } from "react";
// WP3 のプラグインホスト（sandbox ランナー）をスロットへ登録する。
import "@/features/plugin-host/register";
import { SiteHeader } from "./site-header";
import { SiteFooter } from "./site-footer";
import { BoardSidebar } from "./board-sidebar";
import { startRouter, useRoute } from "./router";
import { HomeView } from "./views/home-view";
import { BoardView } from "./views/board-view";
import { ThreadView } from "./views/thread-view";
import { BoardNewView } from "./views/board-new-view";
import { SettingsView } from "./views/settings-view";
import { ManageView } from "./views/manage-view";
import { NotFoundView } from "./views/not-found-view";

export function AppShell() {
  useEffect(() => startRouter(), []);
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
      <SiteHeader />
      <div className="oc-layout">
        <BoardSidebar />
        <main className="oc-main">{content}</main>
      </div>
      <SiteFooter />
    </div>
  );
}