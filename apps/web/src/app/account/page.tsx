"use client";

// プロフィール（表示名・自己紹介）。

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Profile, TotpStatus } from "shared";
import { api, errorMessage } from "../../features/account/api";
import { useSession } from "../../features/account/session";

interface MeResponse {
  profile: Profile;
  totp: TotpStatus;
}

const ROLE_LABEL: Record<Profile["role"], string> = {
  owner: "サイト所有者",
  special_admin: "特別管理人",
  user: "一般ユーザー",
};

export default function AccountPage() {
  const { state, loading } = useSession();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state?.authenticated) return;
    api<MeResponse>("GET", "/accounts/me")
      .then((data) => {
        setMe(data);
        setName(data.profile.name);
        setBio(data.profile.bio);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [state]);

  if (loading) return <div className="oc-loading">読み込み中…</div>;
  if (!state?.authenticated) {
    return (
      <div className="oc-stack">
        <div className="oc-warn-box">プロフィールを表示するにはログインしてください。</div>
        <div className="oc-row">
          <Link className="oc-btn oc-btn-primary" href="/account/login">
            ログイン
          </Link>
          <Link className="oc-btn" href="/account/register">
            新規登録
          </Link>
        </div>
      </div>
    );
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await api<Profile>("PATCH", "/accounts/me", { name, bio });
      setMe((current) => (current ? { ...current, profile: updated } : current));
      setMessage("プロフィールを更新しました。");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oc-stack">
      <h1 style={{ fontSize: 18, margin: 0 }}>プロフィール</h1>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}
      {me ? (
        <div className="oc-card oc-small">
          <div className="oc-row">
            <span className="oc-badge oc-badge-green">{ROLE_LABEL[me.profile.role]}</span>
            <span className="oc-muted">{me.profile.email}</span>
            <span className="oc-muted">登録日: {new Date(me.profile.createdAt * 1000).toLocaleDateString("ja-JP")}</span>
          </div>
          <div className="oc-row" style={{ marginTop: 6 }}>
            <span>
              TOTP: {me.totp.enabled ? "有効" : me.totp.required ? "未登録（必須）" : "未設定"}
            </span>
            <span>リカバリーコード残り: {me.totp.recoveryRemaining}</span>
            <Link href="/account/totp">設定を開く</Link>
          </div>
        </div>
      ) : null}
      <form onSubmit={save} className="oc-stack" style={{ maxWidth: 520 }}>
        <div className="oc-field">
          <label className="oc-label" htmlFor="profile-name">
            表示名
          </label>
          <input
            id="profile-name"
            className="oc-input"
            maxLength={64}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="profile-bio">
            自己紹介（500文字まで）
          </label>
          <textarea
            id="profile-bio"
            className="oc-textarea"
            maxLength={500}
            value={bio}
            onChange={(event) => setBio(event.target.value)}
          />
        </div>
        <div className="oc-row">
          <button type="submit" className="oc-btn oc-btn-primary" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
          <Link className="oc-btn" href="/account/security">
            パスワード・セッション管理
          </Link>
        </div>
      </form>
    </div>
  );
}