"use client";

// サイトヘッダ。ロゴ・ナビ・検索・ログイン状態・使い方（ツアー）とヘルプ。
import { useEffect, useState } from "react";
import { Link } from "./router";
import { api } from "@/features/board-ui/api";
import { PluginSlot } from "@/components/plugin-slot";
import { TourHost, startTour, tourPageKeyForPath } from "@/features/site-tour";

interface Account {
  id: string;
  name: string;
  role: string;
}

export function SiteHeader() {
  const [account, setAccount] = useState<Account | null>(null);
  const [tourAvailable, setTourAvailable] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getSession().then((session) => {
      if (alive) setAccount(session);
    });
    return () => {
      alive = false;
    };
  }, []);

  // ツアーを用意している画面（トップ・板・スレ・板作成・設定・管理・板の管理・ヘルプ）でだけ
  // 「使い方」を出す。未対応の画面ではヘルプだけ出す。
  useEffect(() => {
    setTourAvailable(tourPageKeyForPath(window.location.pathname) !== null);
  }, []);

  return (
    <header className="oc-header">
      <div className="oc-header-inner">
        <Link href="/" className="oc-logo" aria-label="おーぷんクローン トップ">
          {/* 独自生成 SVG（既存サイトの素材は使用しない） */}
          <img src="/logo.svg" alt="" className="oc-logo-mark" width={28} height={28} />
          <span className="oc-logo-text">おーぷんクローン</span>
        </Link>

        <nav className="oc-header-nav" data-tour="site-nav" aria-label="サイト内ナビゲーション">
          <Link href="/">板一覧</Link>
          <Link href="/boards/new">板を作る</Link>
          <Link href="/settings">設定</Link>
          <a href="/plugins" className="oc-hide-sp">
            プラグイン
          </a>
          <a href="/ranking" className="oc-hide-sp">
            ランキング
          </a>
          <a href="/admin" className="oc-hide-sp">
            管理
          </a>
        </nav>

        <div className="oc-header-right">
          <form className="oc-header-search" action="/search" method="get" role="search" data-tour="site-search">
            <input type="search" name="q" placeholder="検索" aria-label="サイト内検索" maxLength={100} />
            <button type="submit" className="oc-btn oc-btn-sm">
              検索
            </button>
          </form>
          {tourAvailable ? (
            <button
              type="button"
              className="oc-btn oc-btn-sm oc-hide-sp oc-tour-action"
              data-tour="site-tour"
              onClick={() => {
                // 未対応の画面・権限が足りない画面では、何も起きない操作にせずヘルプへ案内する。
                if (!startTour()) window.location.assign("/help/#tour");
              }}
              title="いま開いている画面の使い方を順に案内します"
            >
              使い方
            </button>
          ) : null}
          <a href="/help/" className="oc-btn oc-btn-sm oc-tour-action" data-tour="site-help" title="ヘルプ（使い方の一覧）">
            ヘルプ
          </a>
          {account ? (
            <a href="/account" className="oc-btn oc-btn-sm" data-tour="site-account" title={`${account.name}（${account.role}）`}>
              {account.name}
            </a>
          ) : (
            <a href="/account/login" className="oc-btn oc-btn-sm" data-tour="site-account">
              ログイン
            </a>
          )}
        </div>
      </div>
      <PluginSlot slot="site-header" />
      {/* ツアーの表示本体（初回の案内・スポットライト・説明） */}
      <TourHost />
    </header>
  );
}