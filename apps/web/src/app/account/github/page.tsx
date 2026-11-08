"use client";

// GitHub 連携ページ（パネル本体は WP4 提供コンポーネント）。
// 未ログインで ?code=&state= が付いた場合は GitHub ログインのコールバックとして処理し、
// ログイン済みの場合はパネルが連携コールバックを処理する。

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { GithubLinkPanel } from "@/components/github-link-panel";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";

export default function GithubLinkPage() {
  const router = useRouter();
  const { state, loading } = useSession();
  const [processing, setProcessing] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const oauthState = params.get("state");
    if (!code || !oauthState) return;
    if (state?.authenticated) return; // 連携パネルが処理する
    setProcessing(true);
    api("POST", "/auth/github/callback", { code, state: oauthState })
      .then(() => {
        window.history.replaceState({}, "", "/account/github");
        router.replace("/account");
      })
      .catch((err) => {
        setLoginError(errorMessage(err));
        setProcessing(false);
      });
  }, [loading, state, router]);

  if (processing) {
    return <div className="oc-loading">GitHub でログインしています…</div>;
  }

  return (
    <div className="oc-stack">
      <h1 style={{ fontSize: 18, margin: 0 }}>GitHub 連携</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        自分の GitHub アカウントを連携すると、Gist / リポジトリへの保存やプラグイン配布ができます（任意）。
        連携トークンは暗号化して保存され、この掲示板以外では使用されません。
      </p>
      {loginError ? <div className="oc-error">{loginError}</div> : null}
      <GithubLinkPanel />
    </div>
  );
}