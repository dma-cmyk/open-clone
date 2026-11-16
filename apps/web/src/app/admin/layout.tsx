"use client";

// 管理画面の共通レイアウト（認可ゲート・ナビ）。
// 就任フォーム（/admin/invites/accept）と所有者セットアップ（/admin/owner/setup）は未認証で開ける。
// WP5 の /admin/ai/*、WP1 の /admin/reports/* はこのレイアウトの子として表示される。

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SessionState } from "shared";
import { api } from "../../features/account/api";
import { LogoutButton } from "../../features/account/logout-button";
import { TourHost, setTourContext, startTour } from "../../features/site-tour";

const PUBLIC_PATHS = ["/admin/invites/accept", "/admin/owner/setup"];

interface NavItem {
  href: string;
  label: string;
  ownerOnly?: boolean;
  specialAdmin?: boolean;
}

const NAV: NavItem[] = [
  { href: "/admin", label: "ダッシュボード" },
  { href: "/admin/invites", label: "招待管理", ownerOnly: true },
  { href: "/admin/special-admins", label: "特別管理人", ownerOnly: true },
  { href: "/admin/users", label: "ユーザー" },
  { href: "/admin/boards", label: "板一覧" },
  { href: "/admin/suspensions", label: "規制" },
  { href: "/admin/audit", label: "監査ログ" },
  { href: "/admin/settings", label: "サイト設定" },
  { href: "/admin/usage", label: "使用量" },
  { href: "/admin/ai", label: "AI 管理" },
  { href: "/admin/ai/queue", label: "AI 承認キュー" },
  { href: "/admin/reports", label: "通報" },
  { href: "/plugins", label: "プラグイン管理" },
  { href: "/b", label: "全板一覧" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const [state, setState] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);

  // 権限をツアーへ知らせる（ヘッダー等、どの開始経路でも同じ手順になる: レビュー 52 T04/T09）。
  // 早期 return より前に置くこと（フック数がレンダー間で変わるとクラッシュする）。
  const tourRole = state?.authenticated ? state.account.role : null;
  useEffect(() => {
    setTourContext({ siteOwner: tourRole === "owner", siteSpecialAdmin: tourRole === "special_admin" });
  }, [tourRole]);

  useEffect(() => {
    if (isPublic) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    api<SessionState>("GET", "/auth/session")
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setLoading(false);
        if (!next.authenticated) {
          router.replace(`/account/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        router.replace(`/account/login?next=${encodeURIComponent(pathname)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [isPublic, pathname, router]);

  if (isPublic) {
    return (
      <div className="oc-main" style={{ maxWidth: 860 }}>
        {children}
      </div>
    );
  }

  if (loading || !state) {
    return <div className="oc-main oc-loading">管理画面を読み込み中…</div>;
  }

  if (!state.authenticated) {
    return <div className="oc-main oc-loading">ログイン画面へ移動しています…</div>;
  }

  const role = state.account.role;
  if (role !== "owner" && role !== "special_admin") {
    return (
      <div className="oc-main" style={{ maxWidth: 720 }}>
        <div className="oc-error">このページは管理者専用です。</div>
        <p>
          <Link href="/">トップへ戻る</Link>
        </p>
      </div>
    );
  }

  const visibleNav = NAV.filter((item) => (item.ownerOnly ? role === "owner" : true));

  return (
    <div className="oc-main" style={{ maxWidth: 1080 }}>
      <div className="oc-panel">
        <div className="oc-panel-title">
          <span>{role === "owner" ? "サイト所有者 管理画面" : "特別管理人ダッシュボード"}</span>
          <span className="oc-row" style={{ gap: 8, alignItems: "center" }}>
            {role === "special_admin" ? <span className="oc-badge oc-badge-gray">所有者専用領域は非表示</span> : null}
            <span className="oc-badge oc-badge-green">{state.account.name}</span>
            <LogoutButton />
          </span>
        </div>
        <div className="oc-panel-inner">
          {state.specialAdminStopped ? (
            <div className="oc-error oc-mb">
              特別管理人権限はサイト所有者により停止されています。管理操作はすべて拒否されます。
            </div>
          ) : null}
          {state.totpSetupRequired ? (
            <div className="oc-warn-box oc-mb">
              TOTP が未登録です。高リスク操作の前に <Link href="/account/totp">TOTP を登録</Link> してください。
            </div>
          ) : null}
          <div className="oc-row oc-mb" style={{ gap: 6, alignItems: "center" }}>
            {/* 管理画面の使い方（ツアー）と管理者向けヘルプへの導線 */}
            <button
              type="button"
              className="oc-btn oc-btn-sm"
              data-tour="admin-help"
              onClick={() => startTour("admin")}
              title="この管理画面の使い方を順に案内します"
            >
              使い方ツアー
            </button>
            <a className="oc-btn oc-btn-sm" href="/help/admin/#site-admin">
              管理者向けヘルプ
            </a>
            <a className="oc-btn oc-btn-sm" href="/help/admin/#security">
              二段階認証・再認証
            </a>
          </div>
          <nav className="oc-tabs" data-tour="admin-nav" aria-label="管理メニュー">
            {visibleNav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                data-tour={`admin-nav-${item.href.replace(/^\/admin\/?/, "").replaceAll("/", "-") || "dashboard"}`}
                className={pathname === item.href || (item.href !== "/admin" && pathname.startsWith(`${item.href}/`)) ? "active" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          {children}
        </div>
      </div>
      {/* 管理画面はシェルのヘッダを使わないので、ツアー本体もここに置く */}
      <TourHost />
    </div>
  );
}