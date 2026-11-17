"use client";

// 全ユーザー一覧とサイト停止（規制）。

import { useCallback, useEffect, useState } from "react";
import type { AdminUser, PasswordResetIssueResult, PasswordResetTokenSummary } from "shared";
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
  // パスワード再設定 URL（所有者のみ。設計 50 ②）
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [issued, setIssued] = useState<PasswordResetIssueResult | null>(null);
  const [pendingResets, setPendingResets] = useState<PasswordResetTokenSummary[]>([]);
  const [copied, setCopied] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const stepUp = useStepUp(setError);
  const isOwner = state?.authenticated === true && state.account.role === "owner";

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

  const loadPendingResets = async (accountId: string) => {
    const data = await api<{ items: PasswordResetTokenSummary[] }>(
      "GET",
      `/admin/password-resets?accountId=${encodeURIComponent(accountId)}`,
    );
    setPendingResets(data.items);
  };

  const openResetPanel = async (user: AdminUser) => {
    setResetTarget(user);
    setIssued(null);
    setCopied(false);
    setError(null);
    try {
      await loadPendingResets(user.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const issueResetUrl = async () => {
    if (!resetTarget) return;
    setError(null);
    setMessage(null);
    setResetBusy(true);
    await stepUp.run(async () => {
      const data = await api<PasswordResetIssueResult>("POST", "/admin/password-resets", {
        accountId: resetTarget.id,
      });
      setIssued(data);
      setCopied(false);
      await loadPendingResets(resetTarget.id);
    });
    setResetBusy(false);
  };

  const revokeResetUrl = async (id: string) => {
    if (!resetTarget) return;
    setError(null);
    try {
      await api("POST", `/admin/password-resets/${encodeURIComponent(id)}/revoke`);
      if (issued?.id === id) setIssued(null);
      await loadPendingResets(resetTarget.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const copyResetUrl = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
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

      {isOwner && resetTarget ? (
        <section className="oc-card oc-stack">
          <div className="oc-row-between">
            <h2 style={{ fontSize: 15, margin: 0 }}>
              {resetTarget.name}（{resetTarget.email ?? "メール未登録"}）のパスワード再設定 URL
            </h2>
            <button
              type="button"
              className="oc-btn oc-btn-sm"
              onClick={() => {
                setResetTarget(null);
                setIssued(null);
                setPendingResets([]);
              }}
            >
              閉じる
            </button>
          </div>
          <p className="oc-small" style={{ margin: 0 }}>
            1 回だけ使える URL（24 時間有効）を発行します。発行後、この画面から
            <b>メールを作成</b>（メールソフトが開きます）して登録メールアドレスへ送ってください。
            サイトからは自動送信しません。メールが届く＝そのアドレスの持ち主、という本人確認になります。
          </p>
          {issued ? (
            <div className="oc-stack">
              <div className="oc-warn-box">
                URL は<strong>この画面でのみ表示</strong>されます。発行済みで未使用の古い URL は失効しました。
                有効期限: {new Date(issued.expiresAt * 1000).toLocaleString("ja-JP")}
              </div>
              <input className="oc-input" readOnly value={issued.url} onFocus={(event) => event.target.select()} />
              <div className="oc-row">
                <button type="button" className="oc-btn" onClick={copyResetUrl}>
                  {copied ? "コピーしました" : "URL をコピー"}
                </button>
                <a className="oc-btn" href={issued.mailtoUrl}>
                  メールを作成（{issued.email}）
                </a>
              </div>
            </div>
          ) : (
            <div className="oc-row">
              <button
                type="button"
                className="oc-btn oc-btn-primary"
                onClick={issueResetUrl}
                disabled={resetBusy || !resetTarget.email}
              >
                {resetBusy ? "発行中…" : "再設定 URL を発行する（要 TOTP 再認証）"}
              </button>
              {!resetTarget.email ? <span className="oc-note">登録メールアドレスが無いため発行できません。</span> : null}
            </div>
          )}
          <div className="oc-small">
            <b>未使用の URL:</b>{" "}
            {pendingResets.length === 0 ? "なし" : `${pendingResets.length} 件`}
            {pendingResets.map((token) => (
              <div key={token.id} className="oc-row" style={{ gap: 8 }}>
                <span className="oc-muted">
                  発行 {new Date(token.createdAt * 1000).toLocaleString("ja-JP")} / 期限{" "}
                  {new Date(token.expiresAt * 1000).toLocaleString("ja-JP")}
                </span>
                <button type="button" className="oc-btn oc-btn-sm" onClick={() => revokeResetUrl(token.id)}>
                  失効
                </button>
              </div>
            ))}
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
                  {isOwner && user.role === "user" ? (
                    <button
                      type="button"
                      className="oc-btn oc-btn-sm"
                      onClick={() => {
                        void openResetPanel(user);
                      }}
                    >
                      再設定 URL
                    </button>
                  ) : null}{" "}
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