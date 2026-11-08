"use client";

// 管理ダッシュボード（所有者 / 特別管理人で内容を出し分け）。

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AdminOverview } from "shared";
import { api, errorMessage } from "../../features/account/api";
import { useSession } from "../../features/account/session";

interface Card {
  href: string;
  title: string;
  description: string;
  ownerOnly?: boolean;
}

const CARDS: Card[] = [
  { href: "/admin/users", title: "ユーザー一覧・規制", description: "全アカウントの検索、停止・解除" },
  { href: "/admin/boards", title: "板一覧", description: "全板の横断確認と板管理への導線" },
  { href: "/admin/suspensions", title: "規制一覧", description: "サイト/板スコープの停止の管理" },
  { href: "/plugins", title: "プラグイン管理", description: "公開審査・停止・差し戻し" },
  { href: "/admin/ai", title: "AI 管理状況", description: "AI 管理者の稼働状況と緊急停止" },
  { href: "/admin/ai/queue", title: "AI 承認キュー", description: "高リスク操作の承認・却下" },
  { href: "/admin/reports", title: "通報処理", description: "全体の通報トリアージ" },
  { href: "/admin/audit", title: "操作ログ", description: "自分の操作履歴（監査ログ）" },
  { href: "/admin/invites", title: "招待管理", description: "特別管理人就任キーの発行・失効", ownerOnly: true },
  { href: "/admin/special-admins", title: "特別管理人", description: "権限停止・復旧・TOTP リセット", ownerOnly: true },
  { href: "/admin/settings", title: "サイト設定", description: "登録可否・Turnstile 等の全体設定" },
  { href: "/admin/usage", title: "使用量", description: "D1 行数・セッション・無料枠の確認" },
];

export default function AdminDashboardPage() {
  const { state } = useSession();
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state?.authenticated) return;
    api<AdminOverview>("GET", "/admin/overview")
      .then(setOverview)
      .catch((err) => setError(errorMessage(err)));
  }, [state]);

  const role = state?.authenticated ? state.account.role : null;
  const cards = CARDS.filter((card) => (card.ownerOnly ? role === "owner" : true));

  return (
    <div className="oc-stack">
      <h1 style={{ fontSize: 18, margin: 0 }}>
        {role === "special_admin" ? "特別管理人ダッシュボード" : "管理ダッシュボード"}
      </h1>
      {error ? <div className="oc-error">{error}</div> : null}
      {role === "special_admin" ? (
        <div className="oc-warn-box">
          全板横断の管理・規制・プラグイン管理・AI の承認/停止を実行できます。サイト設定の最終決定、特別管理人の任免、
          サーバ秘密情報・インフラ設定にはアクセスできません（サーバ側で拒否）。
        </div>
      ) : null}

      {overview ? (
        <div className="oc-grid-2">
          {[
            ["アカウント", overview.accounts],
            ["有効セッション", overview.activeSessions],
            ["特別管理人", overview.specialAdmins],
            ["停止中の特別管理人", overview.stoppedSpecialAdmins],
            ["有効な規制", overview.activeSuspensions],
            ["未使用の招待", overview.pendingInvites],
            ["24h の監査イベント", overview.auditEvents24h],
            ["所有者設定", overview.ownerExists ? 1 : 0],
          ].map(([label, value]) => (
            <div key={String(label)} className="oc-card oc-row-between">
              <span className="oc-small oc-muted">{label}</span>
              <strong style={{ fontSize: 18 }}>{value}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="oc-loading">概要を取得中…</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8 }}>
        {cards.map((card) => (
          <Link key={card.href} href={card.href} className="oc-card" style={{ color: "inherit" }}>
            <div style={{ fontWeight: 700, color: "var(--oc-link)" }}>{card.title}</div>
            <div className="oc-small oc-muted">{card.description}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}