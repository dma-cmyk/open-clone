"use client";

// サイトヘッダ。ロゴ・ナビ・検索・ログイン状態。
import { useEffect, useState } from "react";
import { Link } from "./router";
import { api } from "@/features/board-ui/api";
import { PluginSlot } from "@/components/plugin-slot";

interface Account {
  id: string;
  name: string;
  role: string;
}

export function SiteHeader() {
  const [account, setAccount] = useState<Account | null>(null);

  useEffect(() => {
    let alive = true;
    api.getSession().then((session) => {
      if (alive) setAccount(session);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <header className="oc-header">
      <div className="oc-header-inner">
        <Link href="/" className="oc-logo" aria-label="おーぷんクローン トップ">
          {/* 独自生成 SVG（既存サイトの素材は使用しない） */}
          <img src="/logo.svg" alt="" className="oc-logo-mark" width={28} height={28} />
          <span className="oc-logo-text">おーぷんクローン</span>
        </Link>

        <nav className="oc-header-nav" aria-label="サイト内ナビゲーション">
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
          <form className="oc-header-search" action="/search" method="get" role="search">
            <input type="search" name="q" placeholder="検索" aria-label="サイト内検索" maxLength={100} />
            <button type="submit" className="oc-btn oc-btn-sm">
              検索
            </button>
          </form>
          {account ? (
            <a href="/account" className="oc-btn oc-btn-sm" title={`${account.name}（${account.role}）`}>
              {account.name}
            </a>
          ) : (
            <a href="/account/login" className="oc-btn oc-btn-sm">
              ログイン
            </a>
          )}
        </div>
      </div>
      <PluginSlot slot="site-header" />
    </header>
  );
}