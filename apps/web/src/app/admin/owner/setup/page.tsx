"use client";

// サイト所有者の初期ブートストラップ（一度だけ・TOTP 必須）。
// デプロイ時に secret で設定した OWNER_BOOTSTRAP_KEY を入力する。

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buildOtpAuthUri, generateTotpSecret } from "shared";
import { ApiRequestError, api, errorMessage } from "../../../../features/account/api";
import { QrCode } from "../../../../features/account/qr";
import { RecoveryCodes } from "../../../../features/account/recovery-codes";

interface BootstrapResult {
  account: { id: string; role: string };
  recoveryCodes: string[];
}

export default function OwnerSetupPage() {
  const router = useRouter();
  const [closed, setClosed] = useState(false);
  const [bootstrapKey, setBootstrapKey] = useState("");
  const [name, setName] = useState("サイト所有者");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [code, setCode] = useState("");
  const [result, setResult] = useState<BootstrapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generateSecret = () => {
    const next = generateTotpSecret();
    setSecret(next);
    setOtpauthUri(
      buildOtpAuthUri(next, { accountName: email || "owner", issuer: "OpenClone", period: 30, digits: 6 }),
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!secret) {
      setError("先に TOTP の secret を生成し、認証アプリに登録してください。");
      return;
    }
    if (password !== passwordConfirm) {
      setError("パスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      const data = await api<BootstrapResult>("POST", "/admin/owner/setup", {
        bootstrapKey,
        name,
        email,
        password,
        totpSecret: secret,
        totpCode: code,
      });
      setResult(data);
    } catch (err) {
      // セットアップ済みかどうかは未認証で公開していない（L-3）。正しいキーでの
      // 2 回目以降は 409 OWNER_SETUP_CLOSED が返るため、それで判定する。
      if (err instanceof ApiRequestError && err.code === "OWNER_SETUP_CLOSED") {
        setClosed(true);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  if (closed && !result) {
    return (
      <div className="oc-stack" style={{ maxWidth: 560 }}>
        <div className="oc-warn-box">サイト所有者は既に設定済みです。セットアップは一度だけ実行できます。</div>
        <div className="oc-row">
          <Link className="oc-btn oc-btn-primary" href="/account/login">
            ログイン
          </Link>
          <Link className="oc-btn" href="/">
            トップへ
          </Link>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div className="oc-stack" style={{ maxWidth: 720 }}>
        <div className="oc-ok">サイト所有者のセットアップが完了しました。TOTP は必須です。</div>
        <section className="oc-card">
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>リカバリーコード（この画面でのみ表示）</h2>
          <RecoveryCodes codes={result.recoveryCodes} />
        </section>
        <div className="oc-row">
          <button type="button" className="oc-btn oc-btn-primary" onClick={() => router.push("/admin")}>
            管理画面へ
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="oc-stack" style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>サイト所有者セットアップ</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        デプロイ時に設定した <code>OWNER_BOOTSTRAP_KEY</code> を入力して、最初の所有者アカウントを作成します。
        TOTP 二段階認証が必須です。この操作は一度だけ実行できます。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      <form onSubmit={submit} className="oc-stack">
        <div className="oc-field">
          <label className="oc-label" htmlFor="owner-key">
            セットアップキー
          </label>
          <input
            id="owner-key"
            className="oc-input"
            type="password"
            autoComplete="off"
            required
            value={bootstrapKey}
            onChange={(e) => setBootstrapKey(e.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="owner-name">
            表示名
          </label>
          <input id="owner-name" className="oc-input" required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="owner-email">
            メールアドレス
          </label>
          <input
            id="owner-email"
            className="oc-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="owner-password">
            パスワード（8文字以上）
          </label>
          <input
            id="owner-password"
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
          <label className="oc-label" htmlFor="owner-password2">
            パスワード（確認）
          </label>
          <input
            id="owner-password2"
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
          {!secret ? (
            <button type="button" className="oc-btn" onClick={generateSecret}>
              TOTP の secret を生成（QR 表示）
            </button>
          ) : (
            <div className="oc-stack">
              <div className="oc-row" style={{ alignItems: "flex-start", gap: 16 }}>
                <QrCode text={otpauthUri} />
                <div className="oc-stack" style={{ minWidth: 220 }}>
                  <span className="oc-label">手動入力用 secret</span>
                  <code style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: "4px 6px", wordBreak: "break-all", fontSize: 12.5 }}>
                    {secret}
                  </code>
                  <span className="oc-small oc-muted">発行者: OpenClone / 6桁 / 30秒</span>
                </div>
              </div>
              <div className="oc-field" style={{ maxWidth: 200 }}>
                <label className="oc-label" htmlFor="owner-totp">
                  認証アプリの 6 桁コード
                </label>
                <input
                  id="owner-totp"
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

        <button type="submit" className="oc-btn oc-btn-primary" disabled={busy || code.length !== 6}>
          {busy ? "セットアップ中…" : "所有者アカウントを作成"}
        </button>
      </form>
    </div>
  );
}