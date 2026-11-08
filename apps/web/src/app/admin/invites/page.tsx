"use client";

// 招待（特別管理人就任キー）の発行・一覧・失効。owner 専用。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { InviteIssueResult, InviteSummary } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";
import { useStepUp } from "../../../features/account/step-up";

const KIND_LABEL: Record<string, string> = {
  special_admin: "特別管理人",
  board_staff: "板スタッフ",
};

const STATE_LABEL: Record<InviteSummary["state"], string> = {
  pending: "未使用",
  used: "使用済み",
  expired: "期限切れ",
  revoked: "失効",
};

export default function InvitesPage() {
  const { state } = useSession();
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [kind, setKind] = useState<"special_admin" | "board_staff">("special_admin");
  const [note, setNote] = useState("");
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [boardId, setBoardId] = useState("");
  const [level, setLevel] = useState<"admin" | "deputy" | "moderator">("moderator");
  const [issued, setIssued] = useState<InviteIssueResult | null>(null);
  const [acceptUrl, setAcceptUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ items: InviteSummary[] }>("GET", "/admin/invites");
    setInvites(data.items);
  }, []);

  useEffect(() => {
    if (!state?.authenticated || state.account.role !== "owner") return;
    load().catch((err) => setError(errorMessage(err)));
  }, [state, load]);

  const stepUp = useStepUp(setError);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;
  if (state.account.role !== "owner") {
    return <div className="oc-error">招待キーの発行はサイト所有者のみ可能です。</div>;
  }

  const issue = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setIssued(null);
    await stepUp.run(async () => {
      const result = await api<InviteIssueResult>("POST", "/admin/invites", {
        kind,
        expiresInHours,
        ...(note ? { note } : {}),
        ...(kind === "board_staff" && boardId ? { boardId: Number(boardId), level } : {}),
      });
      setIssued(result);
      setAcceptUrl(`${window.location.origin}${result.acceptPath}`);
      await load();
      setMessage("就任キーを発行しました。生キーはこの画面でのみ表示されます。");
    });
    setBusy(false);
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await api("POST", `/admin/invites/${id}/revoke`);
      await load();
      setMessage("招待を失効しました。");
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("クリップボードにコピーしました。");
    } catch {
      setError("コピーに失敗しました。手動で選択してください。");
    }
  };

  return (
    <div className="oc-stack">
      {stepUp.dialog}
      <h1 style={{ fontSize: 18, margin: 0 }}>招待管理</h1>
      <p className="oc-small oc-muted" style={{ margin: 0 }}>
        一回限りのキーを発行します。本人確認と DM 送付は運営者が手動で行ってください（キーは発行時のみ表示されます）。
      </p>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

      <section className="oc-card oc-stack" style={{ maxWidth: 560 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>新規発行</h2>
        <div className="oc-row">
          <label className="oc-inline">
            <span>種別</span>
            <select className="oc-select" style={{ width: 180 }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="special_admin">特別管理人</option>
              <option value="board_staff">板スタッフ</option>
            </select>
          </label>
          <label className="oc-inline">
            <span>有効時間</span>
            <select
              className="oc-select"
              style={{ width: 120 }}
              value={expiresInHours}
              onChange={(e) => setExpiresInHours(Number(e.target.value))}
            >
              <option value={24}>24 時間</option>
              <option value={72}>72 時間</option>
              <option value={168}>7 日</option>
              <option value={720}>30 日</option>
            </select>
          </label>
        </div>
        {kind === "board_staff" ? (
          <div className="oc-row">
            <label className="oc-inline">
              <span>板 ID</span>
              <input className="oc-input oc-input-sm" style={{ width: 100 }} value={boardId} onChange={(e) => setBoardId(e.target.value)} />
            </label>
            <label className="oc-inline">
              <span>権限</span>
              <select className="oc-select" style={{ width: 120 }} value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
                <option value="admin">板管理人</option>
                <option value="deputy">副管理人</option>
                <option value="moderator">モデレーター</option>
              </select>
            </label>
          </div>
        ) : null}
        <div className="oc-field">
          <label className="oc-label" htmlFor="invite-note">
            メモ（任意・運営者用）
          </label>
          <input
            id="invite-note"
            className="oc-input"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例: 特別管理人（本人確認済み・DM 送付）"
          />
        </div>
        <button type="button" className="oc-btn oc-btn-primary" onClick={issue} disabled={busy}>
          {busy ? "発行中…" : "就任キーを発行"}
        </button>
      </section>

      {issued ? (
        <section className="oc-card oc-stack">
          <h2 style={{ fontSize: 15, margin: 0 }}>発行された就任キー（この画面でのみ表示）</h2>
          <div className="oc-warn-box">
            生キーは再表示できません。安全な方法で本人へ送付してください。有効期限:{" "}
            {new Date(issued.expiresAt * 1000).toLocaleString("ja-JP")}
          </div>
          <div className="oc-field">
            <span className="oc-label">キー</span>
            <code style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: "4px 6px", wordBreak: "break-all" }}>{issued.key}</code>
          </div>
          <div className="oc-field">
            <span className="oc-label">就任 URL</span>
            <code style={{ background: "var(--oc-surface-alt)", border: "1px solid var(--oc-border)", padding: "4px 6px", wordBreak: "break-all" }}>{acceptUrl}</code>
          </div>
          <div className="oc-row">
            <button type="button" className="oc-btn" onClick={() => copy(acceptUrl)}>
              就任 URL をコピー
            </button>
            <Link className="oc-btn" href={issued.acceptPath}>
              就任フォームを開く
            </Link>
          </div>
        </section>
      ) : null}

      <section className="oc-card">
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>発行履歴</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr>
              {["種別", "メモ", "状態", "有効期限", "発行", ""].map((head) => (
                <th key={head} style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <tr key={invite.id}>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{KIND_LABEL[invite.kind]}</td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{invite.note ?? "-"}</td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  <span
                    className={
                      invite.state === "pending"
                        ? "oc-badge oc-badge-yellow"
                        : invite.state === "used"
                          ? "oc-badge oc-badge-green"
                          : "oc-badge oc-badge-gray"
                    }
                  >
                    {STATE_LABEL[invite.state]}
                  </span>
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  {new Date(invite.expiresAt * 1000).toLocaleString("ja-JP")}
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                  {new Date(invite.createdAt * 1000).toLocaleString("ja-JP")}
                </td>
                <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", textAlign: "right" }}>
                  {invite.state === "pending" ? (
                    <button type="button" className="oc-btn oc-btn-sm oc-btn-danger" onClick={() => revoke(invite.id)}>
                      失効
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {invites.length === 0 ? (
              <tr>
                <td colSpan={6} className="oc-empty">
                  招待はまだありません
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}