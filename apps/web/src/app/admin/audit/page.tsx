"use client";

// 監査ログビューア。特別管理人は自分の操作のみ表示される（サーバ側で強制）。

import { useCallback, useEffect, useState } from "react";
import type { AuditLogEntry } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";

interface AuditResponse {
  items: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
}

export default function AuditPage() {
  const { state } = useSession();
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditResponse | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (action.trim()) params.set("action", action.trim());
    if (actorId.trim()) params.set("actorId", actorId.trim());
    const result = await api<AuditResponse>("GET", `/admin/audit?${params.toString()}`);
    setData(result);
  }, [action, actorId, page]);

  useEffect(() => {
    if (!state?.authenticated) return;
    load().catch((err) => setError(errorMessage(err)));
  }, [state, load]);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;

  const role = state.account.role;

  return (
    <div className="oc-stack">
      <h1 style={{ fontSize: 18, margin: 0 }}>監査ログ</h1>
      {role === "special_admin" ? (
        <p className="oc-note" style={{ margin: 0 }}>
          特別管理人は自分の操作ログのみ閲覧できます（所有者の操作は表示されません）。
        </p>
      ) : null}
      {error ? <div className="oc-error">{error}</div> : null}

      <form
        className="oc-row"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          load().catch((err) => setError(errorMessage(err)));
        }}
      >
        <input
          className="oc-input"
          style={{ maxWidth: 240 }}
          placeholder="action プレフィックス（例: admin.）"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        {role === "owner" ? (
          <input
            className="oc-input"
            style={{ maxWidth: 240 }}
            placeholder="actorId（ULID）"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          />
        ) : null}
        <button type="submit" className="oc-btn">
          検索
        </button>
        <span className="oc-note">合計 {data?.total ?? 0} 件</span>
      </form>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {["日時", "実行者", "操作", "対象", "詳細"].map((head) => (
              <th key={head} style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data?.items.map((entry) => (
            <tr key={entry.id}>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", whiteSpace: "nowrap" }}>
                {new Date(entry.createdAt * 1000).toLocaleString("ja-JP")}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {entry.actorName ?? entry.actorId ?? entry.actorType}
                <div className="oc-tiny oc-muted">{entry.actorType}</div>
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", fontFamily: "var(--oc-mono)", fontSize: 11.5 }}>
                {entry.action}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", fontSize: 11 }}>{entry.target ?? "-"}</td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {entry.detail ? (
                  <button type="button" className="oc-btn oc-btn-sm" onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
                    {expanded === entry.id ? "閉じる" : "表示"}
                  </button>
                ) : (
                  "-"
                )}
                {expanded === entry.id ? (
                  <pre style={{ margin: "4px 0 0", fontSize: 10.5, whiteSpace: "pre-wrap", maxWidth: 420 }}>
                    {JSON.stringify(entry.detail, null, 2)}
                  </pre>
                ) : null}
              </td>
            </tr>
          ))}
          {data && data.items.length === 0 ? (
            <tr>
              <td colSpan={5} className="oc-empty">
                該当するログがありません
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <div className="oc-row">
        <button type="button" className="oc-btn oc-btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          前へ
        </button>
        <span className="oc-small">{page} ページ</span>
        <button
          type="button"
          className="oc-btn oc-btn-sm"
          disabled={!data || page * data.limit >= data.total}
          onClick={() => setPage((p) => p + 1)}
        >
          次へ
        </button>
      </div>
    </div>
  );
}