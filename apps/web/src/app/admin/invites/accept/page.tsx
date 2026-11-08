"use client";

// 特別管理人 就任フォーム（未認証で利用）。
// キー検証 → アカウント登録 → TOTP 必須登録（QR）→ リカバリーコード 10 個 → 就任完了。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { InviteAcceptResult, InviteInspect, TotpSetupResult } from "shared";
import { api, errorMessage } from "../../../../features/account/api";
import { QrCode } from "../../../../features/account/qr";
import { RecoveryCodes } from "../../../../features/account/recovery-codes";

export default function InviteAcceptPage() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [inspect, setInspect] = useState<InviteInspect | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [totp, setTotp] = useState<TotpSetupResult | null>(null);
  const [code, setCode] = useState("");
  const [result, setResult] = useState<InviteAcceptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("key") ?? "";
    setKey(value);
    if (!value) {
      setError("就任キーが指定されていません。運営者から受け取った URL を開いてください。");
      return;
    }
    api<InviteInspect>("GET", `/admin/invites/inspect?key=${encodeURIComponent(value)}`)
      .then((data) => {
        setInspect(data);
        if (data.accountName) setName(data.accountName);
        if (data.email) setEmail(data.email);
        if (!data.valid) setError(data.reason ?? "この就任キーは無効です。");
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const prepareTotp = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<TotpSetupResult>("POST", "/admin/invites/prepare-totp", { key });
      setTotp(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!totp) {
      setError("先に TOTP の登録（QR 表示）を行ってください。");
      return;
    }
    if (password !== passwordConfirm) {
      setError("パスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      const data = await api<InviteAcceptResult>("POST", "/admin/invites/accept", {
        key,
        name,
        email,
        password,
        totpSecret: totp.secret,
        totpCode: code,
      });
      setResult(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="oc-stack">
        <div className="oc-ok">
          就任が完了しました。特別管理人としてログインしています。TOTP は必須です（次回ログインからコードが必要）。
        </div>
        <section className="oc-card">
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>リカバリーコード（この画面でのみ表示）</h2>
          <RecoveryCodes codes={result.recoveryCodes} />
        </section>
        <div className="oc-row">
          <button type="button" className="oc-btn oc-btn-primary" onClick={() => router.push("/admin")}>
            特別管理人ダッシュボードへ
          </button>
          <Link className="oc-btn" href="/account/totp">
            TOTP 設定を確認
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="oc-stack" style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>特別管理人 就任フォーム</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        運営者から受け取った一回限りの就任キーで、アカウント登録と TOTP 二段階認証の登録を行います。
        就任が完了するまで、あなたは管理人として一切表示されません。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      {inspect?.valid ? (
        <div className="oc-ok oc-small">
          有効な就任キーです（{inspect.kind === "special_admin" ? "特別管理人" : "板スタッフ"} / 期限:{" "}
          {inspect.expiresAt ? new Date(inspect.expiresAt * 1000).toLocaleString("ja-JP") : "-"}）
          {inspect.note ? ` / ${inspect.note}` : ""}
        </div>
      ) : null}

      <form onSubmit={submit} className="oc-stack">
        <div className="oc-field">
          <label className="oc-label" htmlFor="accept-name">
            表示名
          </label>
          <input id="accept-name" className="oc-input" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="accept-email">
            メールアドレス
          </label>
          <input
            id="accept-email"
            className="oc-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="accept-password">
            パスワード（8文字以上）
          </label>
          <input
            id="accept-password"
            className="oc-input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="accept-password2">
            パスワード（確認）
          </label>
          <input
            id="accept-password2"
            className="oc-input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
          />
        </div>

        <section className="oc-card oc-stack">
          <h2 style={{ fontSize: 15, margin: 0 }}>TOTP 二段階認証（必須）</h2>
          {!totp ? (
            <div className="oc-row">
              <button type="button" className="oc-btn" onClick={prepareTotp} disabled={busy || !inspect?.valid}>
                {busy ? "準備中…" : "TOTP の登録を開始（QR 表示）"}
              </button>
              <span className="oc-note">認証アプリで読み取る QR を表示します。</span>
            </div>
          ) : (
            <div className="oc-stack">
              <div className="oc-row" style={{ alignItems: "flex-start", gap: 16 }}>
                <QrCode text={totp.otpauthUri} />
                <div className="oc-stack" style={{ minWidth: 220 }}>
                  <span className="oc-label">手動入力用 secret</span>
                  <code style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: "4px 6px", wordBreak: "break-all", fontSize: 12.5 }}>
                    {totp.secret}
                  </code>
                  <span className="oc-small oc-muted">発行者: OpenClone / 6桁 / 30秒</span>
                </div>
              </div>
              <div className="oc-field" style={{ maxWidth: 200 }}>
                <label className="oc-label" htmlFor="accept-totp">
                  認証アプリの 6 桁コード
                </label>
                <input
                  id="accept-totp"
                  className="oc-input"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                />
              </div>
            </div>
          )}
        </section>

        <button type="submit" className="oc-btn oc-btn-primary" disabled={busy || !inspect?.valid || code.length !== 6}>
          {busy ? "就任処理中…" : "就任する"}
        </button>
      </form>
    </div>
  );
}