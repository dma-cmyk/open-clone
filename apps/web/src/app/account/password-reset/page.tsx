"use client";

// パスワードを忘れたときの再設定（復旧コード。設計 50 ①）。
// メール＋復旧コード＋新しいパスワード。ロボット確認は毎回必須（30 分省略の対象外）。
// 成功してもログインはしない（ログイン画面へ戻す）。復旧コードが無い場合は運営への連絡を案内する。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { PasswordResetResult, PublicSiteInfo } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { TurnstileWidget } from "../../../features/board-ui/turnstile";

export default function PasswordResetPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [siteInfo, setSiteInfo] = useState<PublicSiteInfo | null>(null);
  const [result, setResult] = useState<PasswordResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<PublicSiteInfo>("GET", "/meta/site")
      .then(setSiteInfo)
      .catch(() => setSiteInfo(null));
  }, []);

  const onToken = useCallback((token: string) => setTurnstileToken(token), []);
  const onInvalidate = useCallback(() => setTurnstileToken(""), []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (newPassword !== newPasswordConfirm) {
      setError("新しいパスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      const data = await api<PasswordResetResult>(
        "POST",
        "/auth/password-reset",
        { email, code, newPassword },
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
        <div className="oc-ok">パスワードを再設定しました。新しいパスワードでログインしてください。</div>
        <div className="oc-card oc-small">
          <p style={{ margin: 0 }}>残りの復旧コード: {result.recoveryRemaining}</p>
          <p style={{ margin: "6px 0 0" }}>
            安全のため、この操作でログイン中のセッションはすべて終了しました。
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
      <h1 style={{ fontSize: 18, margin: 0 }}>パスワードを忘れたとき</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        新規登録やアカウントのセキュリティ画面で作成した<b>復旧コード</b>があれば、ここでパスワードを再設定できます
        （メールアドレスと復旧コードが必要です。各コードは 1 回限り）。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      <form onSubmit={submit} className="oc-stack">
        <div className="oc-field">
          <label className="oc-label" htmlFor="pwreset-email">
            メールアドレス
          </label>
          <input
            id="pwreset-email"
            className="oc-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="pwreset-code">
            復旧コード
          </label>
          <input
            id="pwreset-code"
            className="oc-input"
            autoComplete="off"
            placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="pwreset-new">
            新しいパスワード（8文字以上）
          </label>
          <input
            id="pwreset-new"
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
          <label className="oc-label" htmlFor="pwreset-new2">
            新しいパスワード（確認）
          </label>
          <input
            id="pwreset-new2"
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
        <button type="submit" className="oc-btn oc-btn-primary" disabled={busy || !turnstileToken}>
          {busy ? "再設定中…" : "パスワードを再設定"}
        </button>
      </form>

      <section className="oc-card oc-small">
        <h2 style={{ fontSize: 14, margin: "0 0 6px" }}>復旧コードが無い場合</h2>
        <p style={{ margin: 0 }}>
          登録したメールアドレスから運営に連絡してください。運営が本人確認のうえ、
          <b>1 回だけ使える再設定 URL</b> を登録メールアドレスへ送ります。
        </p>
        {siteInfo?.operatorContact ? (
          <p style={{ margin: "6px 0 0" }}>
            運営の連絡先: <a href={`mailto:${siteInfo.operatorContact}`}>{siteInfo.operatorContact}</a>
          </p>
        ) : (
          <p className="oc-muted" style={{ margin: "6px 0 0" }}>
            運営の連絡先はサイト設定で案内されます。分からない場合はサイトの管理者にお問い合わせください。
          </p>
        )}
      </section>

      <div className="oc-small oc-muted">
        <Link href="/account/login">ログイン画面へ戻る</Link>
      </div>
    </div>
  );
}