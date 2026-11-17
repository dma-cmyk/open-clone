"use client";

// 運営が発行した再設定 URL を開いたときの画面（設計 50 ②）。
// トークンはクエリ（?token=...）で受け取る。成功で URL は消費され、全セッションが失効する。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { OperatorPasswordResetResult } from "shared";
import { api, errorMessage } from "../../../../features/account/api";
import { TurnstileWidget } from "../../../../features/board-ui/turnstile";

export default function PasswordResetConfirmPage() {
  const [token, setToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [result, setResult] = useState<OperatorPasswordResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("token") ?? "";
    setToken(raw);
  }, []);

  const onToken = useCallback((value: string) => setTurnstileToken(value), []);
  const onInvalidate = useCallback(() => setTurnstileToken(""), []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!token) {
      setError("URL が正しくありません。運営から届いたメールの URL をそのまま開いてください。");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setError("新しいパスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      const data = await api<OperatorPasswordResetResult>(
        "POST",
        "/auth/password-reset/operator",
        { token, newPassword },
        { turnstileToken },
      );
      setResult(data);
    } catch (err) {
      setError(errorMessage(err));
      setTurnstileToken("");
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="oc-stack" style={{ maxWidth: 460 }}>
        <div className="oc-ok">
          {result.accountName} のパスワードを再設定しました。新しいパスワードでログインしてください。
        </div>
        <div className="oc-card oc-small">
          <p style={{ margin: 0 }}>
            この URL は使用済みになりました。安全のため、この操作でログイン中のセッションはすべて終了しました。
            TOTP を設定している場合は、ログイン時に TOTP コードが必要です。
          </p>
        </div>
        <div className="oc-row">
          <Link className="oc-btn oc-btn-primary" href="/account/login">
            ログインする
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="oc-stack" style={{ maxWidth: 460 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>パスワードの再設定</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        運営から届いた再設定 URL から新しいパスワードを設定します。URL は 1 回だけ・24 時間有効です。
      </p>
      {token === null ? <div className="oc-loading">読み込み中…</div> : null}
      {token === "" ? (
        <div className="oc-error">
          URL が正しくありません。運営から届いたメールの URL をそのまま開いてください。
        </div>
      ) : null}
      {error ? <div className="oc-error">{error}</div> : null}
      <form onSubmit={submit} className="oc-stack">
        <div className="oc-field">
          <label className="oc-label" htmlFor="pwconfirm-new">
            新しいパスワード（8文字以上）
          </label>
          <input
            id="pwconfirm-new"
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
          <label className="oc-label" htmlFor="pwconfirm-new2">
            新しいパスワード（確認）
          </label>
          <input
            id="pwconfirm-new2"
            className="oc-input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={newPasswordConfirm}
            onChange={(event) => setNewPasswordConfirm(event.target.value)}
          />
        </div>
        <TurnstileWidget onToken={onToken} onInvalidate={onInvalidate} />
        <button
          type="submit"
          className="oc-btn oc-btn-primary"
          disabled={busy || !token || !turnstileToken}
        >
          {busy ? "再設定中…" : "パスワードを再設定"}
        </button>
      </form>
      <div className="oc-small oc-muted">
        <Link href="/account/login">ログイン画面へ戻る</Link>
      </div>
    </div>
  );
}