"use client";

// 特別管理人の権限停止・復旧・TOTP リセットと再招待（owner 専用）。

import { useCallback, useEffect, useState } from "react";
import type { InviteIssueResult, SpecialAdmin, SpecialAdminTotpResetResult } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";
import { useStepUp } from "../../../features/account/step-up";

export default function SpecialAdminsPage() {
  const { state } = useSession();
  const [admins, setAdmins] = useState<SpecialAdmin[]>([]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [reinvite, setReinvite] = useState<Record<string, boolean>>({});
  const [invite, setInvite] = useState<InviteIssueResult | null>(null);
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stepUp = useStepUp(setError);

  const load = useCallback(async () => {
    const data = await api<{ items: SpecialAdmin[] }>("GET", "/admin/special-admins");
    setAdmins(data.items);
  }, []);

  useEffect(() => {
    if (!state?.authenticated || state.account.role !== "owner") return;
    load().catch((err) => setError(errorMessage(err)));
  }, [state, load]);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;
  if (state.account.role !== "owner") {
    return <div className="oc-error">このページはサイト所有者専用です。</div>;
  }

  const stop = async (id: string) => {
    setError(null);
    setMessage(null);
    await stepUp.run(async () => {
      await api("POST", `/admin/special-admins/${id}/stop`, { reason: reason[id] ?? "" });
      setMessage("特別管理人権限を停止し、セッションを失効しました。");
      await load();
    });
  };

  const restore = async (id: string) => {
    setError(null);
    setMessage(null);
    await stepUp.run(async () => {
      await api("POST", `/admin/special-admins/${id}/restore`);
      setMessage("特別管理人権限を復旧しました。");
      await load();
    });
  };

  const resetTotp = async (id: string) => {
    setError(null);
    setMessage(null);
    setInvite(null);
    await stepUp.run(async () => {
      const result = await api<SpecialAdminTotpResetResult>("POST", `/admin/special-admins/${id}/totp-reset`, {
        reinvite: reinvite[id] === true,
      });
      setMessage(`TOTP をリセットしました（失効セッション: ${result.sessionsRevoked}）。`);
      setInvite(result.invite);
      setInviteFor(id);
      await load();
    });
  };

  return (
    <div className="oc-stack">
      {stepUp.dialog}
      <h1 style={{ fontSize: 18, margin: 0 }}>特別管理人</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        特別管理人の権限停止・復旧・TOTP リセットはサイト所有者のみ実行できます。所有者の最終権限は常に維持されます。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

      {invite ? (
        <section className="oc-card oc-stack">
          <h2 style={{ fontSize: 15, margin: 0 }}>再招待キー（{inviteFor?.slice(0, 10)}…）</h2>
          <div className="oc-warn-box">生キーはこの画面でのみ表示されます。本人へ安全な方法で送付してください。</div>
          <code style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: "4px 6px", wordBreak: "break-all" }}>
            {invite.key}
          </code>
          <code style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: "4px 6px", wordBreak: "break-all" }}>
            {typeof window !== "undefined" ? `${window.location.origin}${invite.acceptPath}` : invite.acceptPath}
          </code>
        </section>
      ) : null}

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {["表示名", "メール", "状態", "TOTP", "リカバリー", "登録日", "操作"].map((head) => (
              <th key={head} style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {admins.map((admin) => (
            <tr key={admin.id}>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{admin.name}</td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{admin.email ?? "-"}</td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {admin.stoppedAt ? <span className="oc-badge oc-badge-red">停止中</span> : <span className="oc-badge oc-badge-green">稼働中</span>}
                {admin.stopReason ? <div className="oc-tiny oc-muted">{admin.stopReason}</div> : null}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{admin.totpEnabled ? "有効" : "未登録"}</td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{admin.recoveryRemaining}</td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {new Date(admin.createdAt * 1000).toLocaleDateString("ja-JP")}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                <div className="oc-stack" style={{ gap: 4 }}>
                  {admin.stoppedAt ? (
                    <button type="button" className="oc-btn oc-btn-sm" onClick={() => restore(admin.id)}>
                      復旧
                    </button>
                  ) : (
                    <div className="oc-row" style={{ gap: 4, flexWrap: "nowrap" }}>
                      <input
                        className="oc-input oc-input-sm"
                        style={{ width: 140 }}
                        placeholder="停止理由"
                        value={reason[admin.id] ?? ""}
                        onChange={(e) => setReason((current) => ({ ...current, [admin.id]: e.target.value }))}
                      />
                      <button
                        type="button"
                        className="oc-btn oc-btn-sm oc-btn-danger"
                        disabled={!(reason[admin.id] ?? "").trim()}
                        onClick={() => stop(admin.id)}
                      >
                        停止
                      </button>
                    </div>
                  )}
                  <div className="oc-row" style={{ gap: 4, flexWrap: "nowrap" }}>
                    <label className="oc-check oc-tiny">
                      <input
                        type="checkbox"
                        checked={reinvite[admin.id] === true}
                        onChange={(e) => setReinvite((current) => ({ ...current, [admin.id]: e.target.checked }))}
                      />
                      再招待キーも発行
                    </label>
                    <button type="button" className="oc-btn oc-btn-sm" onClick={() => resetTotp(admin.id)}>
                      TOTP リセット
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          ))}
          {admins.length === 0 ? (
            <tr>
              <td colSpan={7} className="oc-empty">
                特別管理人はまだ就任していません
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}