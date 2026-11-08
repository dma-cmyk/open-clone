"use client";

// ログイン（TOTP 要求時はコード入力欄を表示）。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, api, errorMessage } from "../../../features/account/api";
import { TurnstileWidget } from "../../../features/account/turnstile";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState("/account");
  const [githubAvailable, setGithubAvailable] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = params.get("next");
    if (target && target.startsWith("/")) setNext(target);
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

  const onToken = useCallback((token: string | null) => setTurnstileToken(token), []);

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
      router.push(next);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "TOTP_REQUIRED") {
        setNeedTotp(true);
        setError("TOTP コードを入力してください。");
      } else if (err instanceof ApiRequestError && err.code === "TOTP_INVALID") {
        setNeedTotp(true);
        setError(err.message);
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
        <TurnstileWidget onToken={onToken} />
        <button type="submit" className="oc-btn oc-btn-primary" disabled={busy}>
          {busy ? "ログイン中…" : "ログイン"}
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
        アカウントをお持ちでない場合は <Link href="/account/register">新規登録</Link>。
        TOTP 端末を紛失した場合は <Link href="/account/recovery">リカバリーコードで復旧</Link>。
      </div>
    </div>
  );
}