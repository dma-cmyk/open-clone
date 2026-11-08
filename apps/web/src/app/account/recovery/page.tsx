"use client";

// リカバリーコードによる TOTP 復旧（コードは単回使用）。

import Link from "next/link";
import { useState } from "react";
import type { RecoveryResult } from "shared";
import { api, errorMessage } from "../../../features/account/api";

export default function RecoveryPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api<RecoveryResult>("POST", "/auth/recovery", { email, password, code });
      setResult(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="oc-stack" style={{ maxWidth: 480 }}>
        <div className="oc-ok">リカバリーに成功しました。TOTP はリセットされました。</div>
        <div className="oc-card oc-small">
          <p style={{ margin: 0 }}>残りのリカバリーコード: {result.recoveryRemaining}</p>
          <p style={{ margin: "6px 0 0" }}>管理機能を利用するには、TOTP を再登録してください。</p>
        </div>
        <div className="oc-row">
          <Link className="oc-btn oc-btn-primary" href="/account/totp">
            TOTP を再登録する
          </Link>
          <Link className="oc-btn" href="/account">
            プロフィールへ
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="oc-stack" style={{ maxWidth: 440 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>リカバリーコードで復旧</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        認証アプリを紛失した場合、登録時に発行したリカバリーコードで TOTP をリセットできます（各コードは 1 回限り）。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      <form onSubmit={submit} className="oc-stack">
        <div className="oc-field">
          <label className="oc-label" htmlFor="rec-email">
            メールアドレス
          </label>
          <input
            id="rec-email"
            className="oc-input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="rec-password">
            パスワード
          </label>
          <input
            id="rec-password"
            className="oc-input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="rec-code">
            リカバリーコード
          </label>
          <input
            id="rec-code"
            className="oc-input"
            autoComplete="off"
            placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <button type="submit" className="oc-btn oc-btn-primary" disabled={busy}>
          {busy ? "確認中…" : "復旧する"}
        </button>
      </form>
      <div className="oc-small oc-muted">
        コードが残っていない場合は、サイト所有者に TOTP リセットと再招待を依頼してください。
      </div>
    </div>
  );
}