"use client";

// 全ユーザー一覧とサイト停止（規制）。

import { useCallback, useEffect, useState } from "react";
import type { AdminUser } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";
import { useStepUp } from "../../../features/account/step-up";

interface UsersResponse {
  items: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

const ROLE_LABEL: Record<AdminUser["role"], string> = {
  owner: "所有者",
  special_admin: "特別管理人",
  user: "ユーザー",
};

export default function UsersPage() {
  const { state } = useSession();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [users, setUsers] = useState<UsersResponse | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState("");
  const [durationHours, setDurationHours] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stepUp = useStepUp(setError);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (query.trim()) params.set("q", query.trim());
    if (roleFilter) params.set("role", roleFilter);
    const data = await api<UsersResponse>("GET", `/admin/users?${params.toString()}`);
    setUsers(data);
  }, [page, query, roleFilter]);

  useEffect(() => {
    if (!state?.authenticated) return;
    load().catch((err) => setError(errorMessage(err)));
  }, [state, load]);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;

  const suspend = async () => {
    if (!selected) return;
    setError(null);
    setMessage(null);
    await stepUp.run(async () => {
      await api("POST", "/admin/suspensions", {
        accountId: selected.id,
        scope: "site",
        reason,
        ...(durationHours ? { durationHours: Number(durationHours) } : {}),
      });
      setMessage(`${selected.name} を停止しました（既存セッションも失効）。`);
      setSelected(null);
      setReason("");
      setDurationHours("");
      await load();
    });
  };

  return (
    <div className="oc-stack">
      {stepUp.dialog}
      <h1 style={{ fontSize: 18, margin: 0 }}>ユーザー一覧</h1>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

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
          style={{ maxWidth: 260 }}
          placeholder="表示名・メールで検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="oc-select" style={{ width: 140 }} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="">全ロール</option>
          <option value="user">ユーザー</option>
          <option value="special_admin">特別管理人</option>
          <option value="owner">所有者</option>
        </select>
        <button type="submit" className="oc-btn">
          検索
        </button>
        <span className="oc-note">合計 {users?.total ?? 0} 件</span>
      </form>

      {selected ? (
        <section className="oc-card oc-stack">
          <h2 style={{ fontSize: 15, margin: 0 }}>
            {selected.name}（{selected.email}）をサイト全体で停止
          </h2>
          <div className="oc-row">
            <input
              className="oc-input"
              style={{ maxWidth: 320 }}
              placeholder="理由（必須）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <select className="oc-select" style={{ width: 160 }} value={durationHours} onChange={(e) => setDurationHours(e.target.value)}>
              <option value="">無期限</option>
              <option value="24">24 時間</option>
              <option value="168">7 日</option>
              <option value="720">30 日</option>
            </select>
            <button type="button" className="oc-btn oc-btn-danger" disabled={!reason.trim()} onClick={suspend}>
              停止する（要 TOTP 再認証）
            </button>
            <button type="button" className="oc-btn" onClick={() => setSelected(null)}>
              キャンセル
            </button>
          </div>
        </section>
      ) : null}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr>
              {["ID", "表示名", "メール", "ロール", "状態", "規制", "登録日", ""].map((head) => (
                <th key={head} style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4, whiteSpace: "nowrap" }}>
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users?.items.map((user) => (
              <tr key={user.id}>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", fontFamily: "var(--oc-mono)", fontSize: 11 }}>
                  {user.id.slice(0, 10)}…
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{user.name}</td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{user.email ?? "-"}</td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{ROLE_LABEL[user.role]}</td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  {user.status === "active" ? (
                    <span className="oc-badge oc-badge-green">有効</span>
                  ) : (
                    <span className="oc-badge oc-badge-red">停止</span>
                  )}
                  {user.specialAdminStopped ? <span className="oc-badge oc-badge-yellow">管理人停止</span> : null}
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{user.activeSuspensions}</td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  {new Date(user.createdAt * 1000).toLocaleDateString("ja-JP")}
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", textAlign: "right" }}>
                  {user.role === "owner" || user.status === "suspended" ? null : (
                    <button
                      type="button"
                      className="oc-btn oc-btn-sm"
                      onClick={() => {
                        setSelected(user);
                        setMessage(null);
                      }}
                    >
                      停止
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {users && users.items.length === 0 ? (
              <tr>
                <td colSpan={8} className="oc-empty">
                  該当するユーザーがいません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="oc-row">
        <button type="button" className="oc-btn oc-btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          前へ
        </button>
        <span className="oc-small">{page} ページ</span>
        <button
          type="button"
          className="oc-btn oc-btn-sm"
          disabled={!users || page * users.limit >= users.total}
          onClick={() => setPage((p) => p + 1)}
        >
          次へ
        </button>
      </div>
    </div>
  );
}