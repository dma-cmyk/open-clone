"use client";

// サイト設定（所有者は編集、特別管理人は参照のみ）。

import { useEffect, useState } from "react";
import type { SiteSettings } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";
import { useStepUp } from "../../../features/account/step-up";

export default function SiteSettingsPage() {
  const { state } = useSession();
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp(setError);

  const isOwner = state?.authenticated === true && state.account.role === "owner";

  useEffect(() => {
    if (!state?.authenticated) return;
    api<SiteSettings>("GET", "/admin/site-config")
      .then(setSettings)
      .catch((err) => setError(errorMessage(err)));
  }, [state]);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;
  if (!settings) return <div className="oc-loading">設定を取得中…</div>;

  const update = <K extends keyof SiteSettings>(key: K, value: SiteSettings[K]) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  };

  const save = async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    await stepUp.run(async () => {
      const next = await api<SiteSettings>("PUT", "/admin/site-config", settings);
      setSettings(next);
      setMessage("サイト設定を保存しました。");
    });
    setBusy(false);
  };

  return (
    <div className="oc-stack">
      {stepUp.dialog}
      <h1 style={{ fontSize: 18, margin: 0 }}>サイト設定</h1>
      {!isOwner ? (
        <div className="oc-warn-box">
          サイト設定の最終決定はサイト所有者のみ可能です。特別管理人は参照のみできます。
        </div>
      ) : null}
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

      <section className="oc-card oc-stack" style={{ maxWidth: 620 }}>
        <div className="oc-field">
          <label className="oc-label" htmlFor="setting-name">
            サイト名
          </label>
          <input
            id="setting-name"
            className="oc-input"
            disabled={!isOwner}
            value={settings["site.name"]}
            onChange={(e) => update("site.name", e.target.value)}
          />
        </div>
        <div className="oc-field">
          <label className="oc-label" htmlFor="setting-desc">
            説明
          </label>
          <textarea
            id="setting-desc"
            className="oc-textarea"
            disabled={!isOwner}
            value={settings["site.description"]}
            onChange={(e) => update("site.description", e.target.value)}
          />
        </div>
        <label className="oc-check">
          <input
            type="checkbox"
            disabled={!isOwner}
            checked={settings["registration.open"]}
            onChange={(e) => update("registration.open", e.target.checked)}
          />
          新規登録を許可する
        </label>
        <label className="oc-check">
          <input
            type="checkbox"
            disabled={!isOwner}
            checked={settings["security.special_admin_totp_required"]}
            onChange={(e) => update("security.special_admin_totp_required", e.target.checked)}
          />
          特別管理人に TOTP を必須にする
        </label>
        <div className="oc-field" style={{ maxWidth: 320 }}>
          <label className="oc-label" htmlFor="setting-turnstile">
            Turnstile 要求
          </label>
          <select
            id="setting-turnstile"
            className="oc-select"
            disabled={!isOwner}
            value={settings["security.require_turnstile"]}
            onChange={(e) => update("security.require_turnstile", e.target.value as SiteSettings["security.require_turnstile"])}
          >
            <option value="auto">自動（失敗・連続登録時に要求）</option>
            <option value="always">常に要求</option>
            <option value="off">要求しない</option>
          </select>
        </div>
        <div className="oc-field" style={{ maxWidth: 320 }}>
          <label className="oc-label" htmlFor="setting-maxfail">
            ログイン失敗の上限（回/5分）
          </label>
          <input
            id="setting-maxfail"
            className="oc-input"
            type="number"
            min={3}
            max={50}
            disabled={!isOwner}
            value={settings["security.login_max_failures"]}
            onChange={(e) => update("security.login_max_failures", Number(e.target.value))}
          />
        </div>
        <div className="oc-field" style={{ maxWidth: 420 }}>
          <label className="oc-label" htmlFor="setting-plugin-ai-url">
            プラグイン AI 接続先（OpenAI 互換 API のベース URL。空欄で無効）
          </label>
          <input
            id="setting-plugin-ai-url"
            className="oc-input"
            disabled={!isOwner}
            placeholder="https://api.openai.com/v1"
            value={settings["plugin.ai.baseUrl"]}
            onChange={(e) => update("plugin.ai.baseUrl", e.target.value)}
          />
          <p className="oc-small">API キーはこの画面ではなく Worker secret `PLUGIN_AI_API_KEY` に設定します。</p>
        </div>
        <div className="oc-field" style={{ maxWidth: 320 }}>
          <label className="oc-label" htmlFor="setting-plugin-ai-model">
            プラグイン AI モデル
          </label>
          <input
            id="setting-plugin-ai-model"
            className="oc-input"
            disabled={!isOwner}
            value={settings["plugin.ai.model"]}
            onChange={(e) => update("plugin.ai.model", e.target.value)}
          />
        </div>
        {isOwner ? (
          <button type="button" className="oc-btn oc-btn-primary" onClick={save} disabled={busy}>
            {busy ? "保存中…" : "保存（要 TOTP 再認証）"}
          </button>
        ) : null}
      </section>
      <p className="oc-note">
        サーバ秘密情報（Wrangler secrets）・インフラ設定はこの UI からは参照も変更もできません。
      </p>
    </div>
  );
}