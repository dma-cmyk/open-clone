"use client";

// ログイン（TOTP 要求時はコード入力欄を表示）。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api, errorMessage } from "../../../features/account/api";
import { resolveSafeNext } from "../../../features/account/safe-next";
import { TurnstileWidget } from "../../../features/account/turnstile";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [turnstileWaiting, setTurnstileWaiting] = useState(false);
  const [needTurnstile, setNeedTurnstile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState("/account");
  const [githubAvailable, setGithubAvailable] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(resolveSafeNext(params.get("next"), "/account"));
  }, []);

  useEffect(() => {
    api<{ available: boolean }>("GET", "/auth/github/status")
      .then((data) => setGithubAvailable(data.available))
      .catch(() => setGithubAvailable(false));
  }, []);

  const startGithubLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ authorizeUrl: string }>("GET", "/auth/github/start");
      window.location.href = data.authorizeUrl;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const onToken = useCallback((token: string | null) => {
    setTurnstileToken(token);
    if (token) setTurnstileWaiting(false);
  }, []);

  // 一度送るとトークンは API 側で使い切られる。成功以外の応答の後は捨てて取り直し、
  // 新しいトークンが届くまで送信させない（同じ値の再送は siteverify で弾かれる）。
  const resetTurnstile = useCallback(() => {
    setTurnstileToken(null);
    setTurnstileWaiting(true);
    setTurnstileResetKey((value) => value + 1);
  }, []);

  const onTurnstileUnavailable = useCallback(() => setTurnstileWaiting(false), []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(
        "POST",
        "/auth/login",
        { email, password, ...(needTotp || totpCode ? { totpCode } : {}) },
        { turnstileToken },
      );
      // ログイン後の戻り先は Next のクライアント遷移ではシェル画面を描けない
      // （静的エクスポートには /b/**, /boards/new 等の Next ルートが無い）。
      // 明示的なフルページ遷移にし、戻り先は検証済みの `next` だけを使う。
      window.location.assign(next);
    } catch (err) {
      resetTurnstile();
      if (err instanceof ApiRequestError && err.code === "TOTP_REQUIRED") {
        setNeedTotp(true);
        setNeedTurnstile(false);
        setError("TOTP コードを入力してください。");
      } else if (err instanceof ApiRequestError && err.code === "TOTP_INVALID") {
        setNeedTotp(true);
        setNeedTurnstile(false);
        setError(err.message);
      } else if (err instanceof ApiRequestError && err.code === "TURNSTILE_FAILED") {
        setNeedTurnstile(true);
        setError(errorMessage(err));
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oc-stack" style={{ maxWidth: 420 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>ログイン</h1>
      {error ? <div className="oc-error">{error}</div> : null}
      <form onSubmit={submit} className="oc-stack">
        <div className="oc-field">
          <label className="oc-label" htmlFor="login-email">
            メールアドレス
          </label>
          <input
            id="login-email"
            className="oc-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="login-password">
            パスワード
          </label>
          <input
            id="login-password"
            className="oc-input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {needTotp ? (
          <div className="oc-field">
            <label className="oc-label" htmlFor="login-totp">
              TOTP コード（6桁）
            </label>
            <input
              id="login-totp"
              className="oc-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ""))}
            />
          </div>
        ) : null}
        {needTurnstile ? (
          <p className="oc-small" role="status" style={{ margin: 0 }}>
            安全確認のため Bot 確認（Turnstile）が必要です。確認完了後にもう一度ログインしてください。
          </p>
        ) : null}
        <TurnstileWidget
          onToken={onToken}
          onUnavailable={onTurnstileUnavailable}
          resetKey={turnstileResetKey}
        />
        <button type="submit" className="oc-btn oc-btn-primary" disabled={busy || turnstileWaiting}>
          {busy ? "ログイン中…" : turnstileWaiting ? "確認中…" : "ログイン"}
        </button>
      </form>
      {githubAvailable ? (
        <div className="oc-stack">
          <button type="button" className="oc-btn" onClick={startGithubLogin} disabled={busy}>
            GitHub でログイン
          </button>
          <p className="oc-tiny oc-muted" style={{ margin: 0 }}>
            GitHub の確認済みメールでログインします。同じメールのアカウントがあれば自動で紐付きます。
          </p>
        </div>
      ) : null}
      <div className="oc-small oc-muted">
        <Link href="/account/password-reset">パスワードを忘れた場合</Link>。
        アカウントをお持ちでない場合は <Link href="/account/register">新規登録</Link>。
        TOTP 端末を紛失した場合は <Link href="/account/recovery">リカバリーコードで復旧</Link>。
      </div>
    </div>
  );
}