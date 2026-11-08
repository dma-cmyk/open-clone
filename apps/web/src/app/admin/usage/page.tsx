"use client";

// 使用量（D1 行数・無料枠予算の可視化）。

import { useEffect, useState } from "react";
import type { AdminOverview } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";

interface UsageResponse {
  d1: { counts: Record<string, number> };
  freeTierBudget: {
    workersRequestsPerDay: number;
    d1RowsReadPerDay: number;
    d1RowsWrittenPerDay: number;
  };
}

const TABLE_LABEL: Record<string, string> = {
  accounts: "アカウント",
  sessions: "セッション",
  audit_log: "監査ログ",
};

export default function UsagePage() {
  const { state } = useSession();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state?.authenticated) return;
    Promise.all([
      api<UsageResponse>("GET", "/meta/usage"),
      api<AdminOverview>("GET", "/admin/overview"),
    ])
      .then(([usageData, overviewData]) => {
        setUsage(usageData);
        setOverview(overviewData);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [state]);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;

  return (
    <div className="oc-stack">
      <h1 style={{ fontSize: 18, margin: 0 }}>使用量・無料枠</h1>
      {error ? <div className="oc-error">{error}</div> : null}

      <div className="oc-grid-2">
        <section className="oc-card">
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>D1 テーブル行数</h2>
          {usage ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>テーブル</th>
                  <th style={{ textAlign: "right", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>行数</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(usage.d1.counts).map(([table, count]) => (
                  <tr key={table}>
                    <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{TABLE_LABEL[table] ?? table}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", textAlign: "right" }}>
                      {count.toLocaleString("ja-JP")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="oc-loading">取得中…</div>
          )}
        </section>

        <section className="oc-card">
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>管理指標</h2>
          {overview ? (
            <ul className="oc-small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              <li>アカウント数: {overview.accounts.toLocaleString("ja-JP")}</li>
              <li>有効セッション: {overview.activeSessions.toLocaleString("ja-JP")}</li>
              <li>有効な規制: {overview.activeSuspensions}</li>
              <li>未使用の招待: {overview.pendingInvites}</li>
              <li>24h の監査イベント: {overview.auditEvents24h}</li>
            </ul>
          ) : (
            <div className="oc-loading">取得中…</div>
          )}
        </section>
      </div>

      {usage ? (
        <section className="oc-card oc-stack">
          <h2 style={{ fontSize: 15, margin: 0 }}>無料枠の目安（1 日あたり）</h2>
          <div className="oc-grid-2">
            <div className="oc-row-between">
              <span className="oc-small">Workers リクエスト</span>
              <strong>{usage.freeTierBudget.workersRequestsPerDay.toLocaleString("ja-JP")}</strong>
            </div>
            <div className="oc-row-between">
              <span className="oc-small">D1 行読み取り</span>
              <strong>{usage.freeTierBudget.d1RowsReadPerDay.toLocaleString("ja-JP")}</strong>
            </div>
            <div className="oc-row-between">
              <span className="oc-small">D1 行書き込み</span>
              <strong>{usage.freeTierBudget.d1RowsWrittenPerDay.toLocaleString("ja-JP")}</strong>
            </div>
          </div>
          <p className="oc-note" style={{ margin: 0 }}>
            添付ファイル本体は Cloudflare に保存しません（R2 不使用）。数値は Worker 側の簡易集計です。
          </p>
        </section>
      ) : null}
    </div>
  );
}