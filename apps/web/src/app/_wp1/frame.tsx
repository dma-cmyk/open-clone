"use client";

// 検索・ランキング・ヘッドライン共通のページ枠。
// サイトヘッダ/フッタは WP2 のシェルから import する（編集はしない）。

import type { ReactNode } from "react";
import { SiteFooter } from "../_shell/site-footer";
import { SiteHeader } from "../_shell/site-header";

export function Wp1Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="oc-app">
      <SiteHeader />
      <main className="oc-main">
        <div className="oc-panel">
          <div className="oc-panel-title">
            <span>{title}</span>
            {actions ? <span className="oc-row">{actions}</span> : null}
          </div>
          {description ? <div className="oc-panel-inner oc-small oc-muted">{description}</div> : null}
        </div>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}