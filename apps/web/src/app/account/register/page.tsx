"use client";

// 新規登録。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../../features/account/api";
import { RecoveryCodes } from "../../../features/account/recovery-codes";
import { resolveSafeNext } from "../../../features/account/safe-next";
import { TurnstileWidget } from "../../../features/account/turnstile";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 登録完了後の任意ステップ（復旧コードの作成。設計 50 ①）
  const [registered, setRegistered] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  // ログインと同じ戻り先（同一サイト内のローカルパスのみ受理 / レビュー UX-R3）
  const [next, setNext] = useState("/account");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(resolveSafeNext(params.get("next"), "/account"));
  }, []);

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
      // 登録後の戻り先も同じ理由でフルページ遷移にする（`next` は resolveSafeNext で検証済み）。
      // ただし先に「復旧コードを作るか」を選ばせる（任意。作らなくても登録は完了している）。
      setRegistered(true);
      setTurnstileToken(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const createRecoveryCodes = async () => {
    setCodeError(null);
    setCodeBusy(true);
    try {
      // 登録直後なので、いま入力したパスワードで再認証する（TOTP 未登録でも作れる）。
      const data = await api<{ recoveryCodes: string[] }>("POST", "/auth/recovery-codes/regenerate", {
        password,
      });
      setRecoveryCodes(data.recoveryCodes);
    } catch (err) {
      setCodeError(errorMessage(err));
    } finally {
      setCodeBusy(false);
    }
  };

  const finish = () => {
    window.location.assign(next);
  };

  if (registered) {
    return (
      <div className="oc-stack" style={{ maxWidth: 560 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>復旧コードを作成（推奨）</h1>
        <p className="oc-small oc-muted" style={{ margin: 0 }}>
          復旧コードがあると、パスワードを忘れたときにメールアドレスとコードだけで再設定できます。
          作成は任意です。あとからアカウントの<a href="/account/security">セキュリティ</a>画面でも作成できます。
        </p>
        {codeError ? <div className="oc-error">{codeError}</div> : null}
        {recoveryCodes ? (
          <>
            <RecoveryCodes codes={recoveryCodes} />
            <div className="oc-row">
              <button type="button" className="oc-btn oc-btn-primary" onClick={finish}>
                保存したので続ける
              </button>
            </div>
          </>
        ) : (
          <div className="oc-row">
            <button type="button" className="oc-btn oc-btn-primary" onClick={createRecoveryCodes} disabled={codeBusy}>
              {codeBusy ? "作成中…" : "復旧コードを作成する（推奨）"}
            </button>
            <button type="button" className="oc-btn" onClick={finish} disabled={codeBusy}>
              あとで
            </button>
          </div>
        )}
      </div>
    );
  }

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