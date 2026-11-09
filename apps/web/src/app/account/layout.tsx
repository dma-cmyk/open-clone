// アカウント系ページの共通シェル（ログイン中はログアウトを表示）。

"use client";

import Link from "next/link";
import { LogoutButton } from "../../features/account/logout-button";
import { useSession } from "../../features/account/session";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  const { state } = useSession();

  return (
    <div className="oc-main" style={{ maxWidth: 820 }}>
      <div className="oc-panel">
        <div className="oc-panel-title">
          <span>アカウント</span>
          {state?.authenticated ? (
            <span className="oc-row" style={{ gap: 8, alignItems: "center" }}>
              <span className="oc-badge oc-badge-gray">{state.account.name}</span>
              <LogoutButton />
            </span>
          ) : null}
        </div>
        <div className="oc-panel-inner">
          <nav className="oc-tabs" aria-label="アカウントメニュー">
            <Link href="/account">プロフィール</Link>
            <Link href="/account/security">セキュリティ</Link>
            <Link href="/account/totp">TOTP 二段階認証</Link>
            <Link href="/account/plugin-tokens">プラグイン作成トークン</Link>
            <Link href="/account/github">GitHub 連携</Link>
            <Link href="/account/login">ログイン</Link>
            <Link href="/account/register">新規登録</Link>
          </nav>
          {children}
        </div>
      </div>
    </div>
  );
}