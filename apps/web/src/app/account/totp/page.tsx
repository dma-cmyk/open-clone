"use client";

// TOTP 二段階認証の登録・解除・リカバリーコード再発行。
// QR はサーバが返す otpauth:// URI をクライアントで画像化する。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { TotpSetupResult, TotpStatus } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { QrCode } from "../../../features/account/qr";
import { RecoveryCodes } from "../../../features/account/recovery-codes";
import { useSession } from "../../../features/account/session";
import { useStepUp } from "../../../features/account/step-up";

export default function TotpPage() {
  const { state, loading } = useSession();
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [setup, setSetup] = useState<TotpSetupResult | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    const data = await api<TotpStatus>("GET", "/auth/totp/status");
    setStatus(data);
  }, []);

  useEffect(() => {
    if (!state?.authenticated) return;
    refreshStatus().catch((err) => setError(errorMessage(err)));
  }, [state, refreshStatus]);

  const regenerate = useStepUp(setError);

  if (loading) return <div className="oc-loading">読み込み中…</div>;
  if (!state?.authenticated) {
    return (
      <div className="oc-warn-box">
        ログインが必要です。<Link href="/account/login">ログイン</Link>
      </div>
    );
  }

  const beginSetup = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setRecoveryCodes(null);
    try {
      const data = await api<TotpSetupResult>("POST", "/auth/totp/setup", {});
      setSetup(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!setup) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ recoveryCodes: string[] }>("POST", "/auth/totp/enable", { code });
      setRecoveryCodes(data.recoveryCodes);
      setSetup(null);
      setCode("");
      setMessage("TOTP を有効化しました。次回ログインからコードが必要です。");
      await refreshStatus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/auth/totp/disable", { code: disableCode });
      setDisableCode("");
      setMessage("TOTP を無効化しました。");
      await refreshStatus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const regenerateCodes = () => {
    setError(null);
    setMessage(null);
    regenerate.run(async () => {
      const data = await api<{ recoveryCodes: string[] }>("POST", "/auth/recovery-codes/regenerate", {});
      setRecoveryCodes(data.recoveryCodes);
      setMessage("リカバリーコードを再発行しました。以前のコードは無効です。");
      await refreshStatus();
    });
  };

  return (
    <div className="oc-stack">
      {regenerate.dialog}
      <h1 style={{ fontSize: 18, margin: 0 }}>TOTP 二段階認証</h1>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

      <div className="oc-card oc-small">
        <div className="oc-row">
          <span>
            状態:{" "}
            {status?.enabled ? (
              <span className="oc-badge oc-badge-green">有効</span>
            ) : status?.required ? (
              <span className="oc-badge oc-badge-red">必須（未登録）</span>
            ) : (
              <span className="oc-badge oc-badge-gray">未設定</span>
            )}
          </span>
          <span className="oc-muted">リカバリーコード残り: {status?.recoveryRemaining ?? 0}</span>
        </div>
        {status?.required ? (
          <p className="oc-note" style={{ margin: "6px 0 0" }}>
            このアカウントでは TOTP が必須です。無効化はサイト所有者によるリセットのみ可能です。
          </p>
        ) : null}
        {status?.lockedUntil ? (
          <p className="oc-error" style={{ marginTop: 6 }}>
            連続失敗によりロック中です。解除予定: {new Date(status.lockedUntil * 1000).toLocaleString("ja-JP")}
          </p>
        ) : null}
      </div>

      {recoveryCodes ? (
        <section className="oc-card">
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>リカバリーコード（新しい 10 個）</h2>
          <RecoveryCodes codes={recoveryCodes} />
        </section>
      ) : null}

      {!status?.enabled ? (
        <section className="oc-card">
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>登録</h2>
          {!setup ? (
            <div className="oc-stack">
              <p className="oc-small" style={{ margin: 0 }}>
                認証アプリ（Google Authenticator / 1Password など）で QR を読み取り、6 桁コードを入力します。
              </p>
              <button type="button" className="oc-btn oc-btn-primary" onClick={beginSetup} disabled={busy}>
                {busy ? "準備中…" : "TOTP の登録を開始"}
              </button>
            </div>
          ) : (
            <div className="oc-stack">
              <div className="oc-row" style={{ alignItems: "flex-start", gap: 16 }}>
                <QrCode text={setup.otpauthUri} />
                <div className="oc-stack" style={{ minWidth: 220 }}>
                  <div className="oc-label">手動入力用 secret</div>
                  <code
                    style={{
                      background: "var(--oc-surface-alt)",
                      border: "1px solid var(--oc-border)",
                      padding: "4px 6px",
                      wordBreak: "break-all",
                      fontSize: 12.5,
                    }}
                  >
                    {setup.secret}
                  </code>
                  <div className="oc-small oc-muted">発行者: OpenClone / 6桁 / 30秒</div>
                </div>
              </div>
              <form onSubmit={enable} className="oc-row" style={{ alignItems: "flex-end" }}>
                <div className="oc-field" style={{ flex: "0 0 180px", marginBottom: 0 }}>
                  <label className="oc-label" htmlFor="totp-enable-code">
                    認証アプリの 6 桁コード
                  </label>
                  <input
                    id="totp-enable-code"
                    className="oc-input"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                  />
                </div>
                <button type="submit" className="oc-btn oc-btn-primary" disabled={busy || code.length !== 6}>
                  {busy ? "確認中…" : "有効化"}
                </button>
                <button type="button" className="oc-btn" onClick={() => setSetup(null)}>
                  キャンセル
                </button>
              </form>
            </div>
          )}
        </section>
      ) : (
        <section className="oc-card oc-stack">
          <h2 style={{ fontSize: 15, margin: 0 }}>リカバリーコード</h2>
          <p className="oc-small" style={{ margin: 0 }}>
            現在の残数: {status?.recoveryRemaining ?? 0}。再発行すると以前のコードはすべて無効になります。
          </p>
          <div className="oc-row">
            <button type="button" className="oc-btn" onClick={regenerateCodes}>
              リカバリーコードを再発行（要 TOTP 再認証）
            </button>
          </div>
          {!status?.required ? (
            <form onSubmit={disable} className="oc-stack" style={{ marginTop: 10 }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>無効化</h2>
              <div className="oc-row" style={{ alignItems: "flex-end" }}>
                <div className="oc-field" style={{ flex: "0 0 180px", marginBottom: 0 }}>
                  <label className="oc-label" htmlFor="totp-disable-code">
                    6 桁コード
                  </label>
                  <input
                    id="totp-disable-code"
                    className="oc-input"
                    inputMode="numeric"
                    maxLength={6}
                    value={disableCode}
                    onChange={(event) => setDisableCode(event.target.value.replace(/\D/g, ""))}
                  />
                </div>
                <button type="submit" className="oc-btn oc-btn-danger" disabled={busy || disableCode.length !== 6}>
                  無効化する
                </button>
              </div>
            </form>
          ) : null}
        </section>
      )}
    </div>
  );
}