"use client";

// 新規登録。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { api, errorMessage } from "../../../features/account/api";
import { TurnstileWidget } from "../../../features/account/turnstile";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onToken = useCallback((token: string | null) => setTurnstileToken(token), []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== passwordConfirm) {
      setError("パスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      await api("POST", "/auth/register", { name, email, password }, { turnstileToken });
      router.push("/account");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oc-stack" style={{ maxWidth: 460 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>新規登録</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        匿名で投稿できますが、アカウントを作成すると板の作成・プラグイン・GitHub 連携などが利用できます。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      <form onSubmit={submit} className="oc-stack">
        <div className="oc-field">
          <label className="oc-label" htmlFor="reg-name">
            表示名
          </label>
          <input
            id="reg-name"
            className="oc-input"
            required
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="reg-email">
            メールアドレス
          </label>
          <input
            id="reg-email"
            className="oc-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="reg-password">
            パスワード（8文字以上）
          </label>
          <input
            id="reg-password"
            className="oc-input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="reg-password2">
            パスワード（確認）
          </label>
          <input
            id="reg-password2"
            className="oc-input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={passwordConfirm}
            onChange={(event) => setPasswordConfirm(event.target.value)}
          />
        </div>
        <TurnstileWidget onToken={onToken} />
        <button type="submit" className="oc-btn oc-btn-primary" disabled={busy}>
          {busy ? "登録中…" : "登録する"}
        </button>
      </form>
      <div className="oc-small oc-muted">
        既にアカウントをお持ちの場合は <Link href="/account/login">ログイン</Link>。
      </div>
    </div>
  );
}