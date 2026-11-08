"use client";

// セキュリティ（パスワード変更・セッション一覧/失効）。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SessionInfoView } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";

export default function SecurityPage() {
  const { state, loading } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [sessions, setSessions] = useState<SessionInfoView[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    const data = await api<{ items: SessionInfoView[] }>("GET", "/accounts/me/sessions");
    setSessions(data.items);
  }, []);

  useEffect(() => {
    if (!state?.authenticated) return;
    loadSessions().catch((err) => setError(errorMessage(err)));
  }, [state, loadSessions]);

  if (loading) return <div className="oc-loading">読み込み中…</div>;
  if (!state?.authenticated) {
    return (
      <div className="oc-warn-box">
        ログインが必要です。<Link href="/account/login">ログイン</Link>
      </div>
    );
  }

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword !== newPasswordConfirm) {
      setError("新しいパスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ revokedSessions: number }>("POST", "/accounts/me/password", {
        currentPassword,
        newPassword,
      });
      setMessage(`パスワードを変更しました（他の ${result.revokedSessions} セッションを失効）。`);
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      await loadSessions();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await api("DELETE", `/accounts/me/sessions/${encodeURIComponent(id)}`);
      await loadSessions();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const revokeOthers = async () => {
    setError(null);
    try {
      const result = await api<{ revoked: number }>("POST", "/accounts/me/sessions/revoke-others");
      setMessage(`他の ${result.revoked} セッションを失効しました。`);
      await loadSessions();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="oc-stack">
      <h1 style={{ fontSize: 18, margin: 0 }}>セキュリティ</h1>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

      <section className="oc-card">
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>パスワード変更</h2>
        <form onSubmit={changePassword} className="oc-stack" style={{ maxWidth: 420 }}>
          <div className="oc-field">
            <label className="oc-label" htmlFor="cur-pass">
              現在のパスワード
            </label>
            <input
              id="cur-pass"
              className="oc-input"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="oc-field">
            <label className="oc-label" htmlFor="new-pass">
              新しいパスワード（8文字以上）
            </label>
            <input
              id="new-pass"
              className="oc-input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <div className="oc-field">
            <label className="oc-label" htmlFor="new-pass2">
              新しいパスワード（確認）
            </label>
            <input
              id="new-pass2"
              className="oc-input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={newPasswordConfirm}
              onChange={(event) => setNewPasswordConfirm(event.target.value)}
            />
          </div>
          <button type="submit" className="oc-btn oc-btn-primary" disabled={busy}>
            {busy ? "変更中…" : "パスワードを変更"}
          </button>
        </form>
      </section>

      <section className="oc-card">
        <div className="oc-row-between">
          <h2 style={{ fontSize: 15, margin: 0 }}>ログイン中のセッション</h2>
          <button type="button" className="oc-btn oc-btn-sm" onClick={revokeOthers}>
            他のセッションをすべて失効
          </button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>端末</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>最終使用</th>
              <th style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>期限</th>
              <th style={{ borderBottom: "1px solid var(--oc-border)", padding: 4 }} />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  {session.current ? <span className="oc-badge oc-badge-green">この端末</span> : null}{" "}
                  <span className="oc-muted">{session.ua ?? "不明な端末"}</span>
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  {new Date(session.lastUsedAt * 1000).toLocaleString("ja-JP")}
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  {new Date(session.expiresAt * 1000).toLocaleDateString("ja-JP")}
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", textAlign: "right" }}>
                  <button type="button" className="oc-btn oc-btn-sm oc-btn-danger" onClick={() => revoke(session.id)}>
                    失効
                  </button>
                </td>
              </tr>
            ))}
            {sessions.length === 0 ? (
              <tr>
                <td colSpan={4} className="oc-empty">
                  セッションがありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <div className="oc-row">
        <Link className="oc-btn" href="/account/totp">
          TOTP 二段階認証の設定
        </Link>
        <Link className="oc-btn" href="/account">
          プロフィールへ戻る
        </Link>
      </div>
    </div>
  );
}