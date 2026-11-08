"use client";

// 規制（サイト/板スコープの停止）の作成・一覧・解除。

import { useCallback, useEffect, useState } from "react";
import type { Suspension, SuspensionScope } from "shared";
import { api, errorMessage } from "../../../features/account/api";
import { useSession } from "../../../features/account/session";
import { useStepUp } from "../../../features/account/step-up";

interface SuspensionList {
  items: Suspension[];
  total: number;
}

export default function SuspensionsPage() {
  const { state } = useSession();
  const [list, setList] = useState<SuspensionList | null>(null);
  const [activeOnly, setActiveOnly] = useState(true);
  const [accountId, setAccountId] = useState("");
  const [email, setEmail] = useState("");
  const [deviceHash, setDeviceHash] = useState("");
  const [scope, setScope] = useState<SuspensionScope>("site");
  const [boardId, setBoardId] = useState("");
  const [reason, setReason] = useState("");
  const [durationHours, setDurationHours] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stepUp = useStepUp(setError);

  const load = useCallback(async () => {
    const data = await api<SuspensionList>("GET", `/admin/suspensions?active=${activeOnly ? "1" : "0"}`);
    setList(data);
  }, [activeOnly]);

  useEffect(() => {
    if (!state?.authenticated) return;
    load().catch((err) => setError(errorMessage(err)));
  }, [state, load]);

  if (!state?.authenticated) return <div className="oc-loading">読み込み中…</div>;

  const create = async () => {
    setError(null);
    setMessage(null);
    await stepUp.run(async () => {
      await api("POST", "/admin/suspensions", {
        ...(accountId ? { accountId } : {}),
        ...(email ? { email } : {}),
        ...(deviceHash ? { deviceHash } : {}),
        scope,
        ...(scope === "board" ? { boardId: Number(boardId) } : {}),
        reason,
        ...(durationHours ? { durationHours: Number(durationHours) } : {}),
      });
      setMessage("規制を作成しました。");
      setAccountId("");
      setEmail("");
      setDeviceHash("");
      setReason("");
      setBoardId("");
      setDurationHours("");
      await load();
    });
  };

  const lift = async (id: string) => {
    setError(null);
    await stepUp.run(async () => {
      await api("POST", `/admin/suspensions/${id}/lift`);
      setMessage("規制を解除しました。");
      await load();
    });
  };

  return (
    <div className="oc-stack">
      {stepUp.dialog}
      <h1 style={{ fontSize: 18, margin: 0 }}>規制（停止・アクセス禁止）</h1>
      {error ? <div className="oc-error">{error}</div> : null}
      {message ? <div className="oc-ok">{message}</div> : null}

      <section className="oc-card oc-stack" style={{ maxWidth: 720 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>新規規制</h2>
        <p className="oc-note" style={{ margin: 0 }}>
          accountId・メール・端末ハッシュのいずれか 1 つ以上を指定してください。サイトスコープはアカウント停止（セッション失効）です。
          所有者は停止できません。
        </p>
        <div className="oc-row">
          <input className="oc-input" style={{ maxWidth: 260 }} placeholder="accountId (ULID)" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
          <input className="oc-input" style={{ maxWidth: 220 }} placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="oc-input" style={{ maxWidth: 220 }} placeholder="device_hash" value={deviceHash} onChange={(e) => setDeviceHash(e.target.value)} />
        </div>
        <div className="oc-row">
          <select className="oc-select" style={{ width: 140 }} value={scope} onChange={(e) => setScope(e.target.value as SuspensionScope)}>
            <option value="site">サイト全体</option>
            <option value="board">板単位</option>
          </select>
          {scope === "board" ? (
            <input
              className="oc-input oc-input-sm"
              style={{ width: 100 }}
              placeholder="板 ID"
              value={boardId}
              onChange={(e) => setBoardId(e.target.value)}
            />
          ) : null}
          <input
            className="oc-input"
            style={{ maxWidth: 300 }}
            placeholder="理由（必須）"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <select className="oc-select" style={{ width: 130 }} value={durationHours} onChange={(e) => setDurationHours(e.target.value)}>
            <option value="">無期限</option>
            <option value="1">1 時間</option>
            <option value="24">24 時間</option>
            <option value="168">7 日</option>
            <option value="720">30 日</option>
          </select>
          <button
            type="button"
            className="oc-btn oc-btn-primary"
            disabled={!reason.trim() || (!accountId && !email && !deviceHash) || (scope === "board" && !boardId)}
            onClick={create}
          >
            規制を作成（要 TOTP 再認証）
          </button>
        </div>
      </section>

      <div className="oc-row">
        <label className="oc-check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          有効なもののみ
        </label>
        <span className="oc-note">合計 {list?.total ?? 0} 件</span>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {["対象", "スコープ", "理由", "期限", "状態", "作成", ""].map((head) => (
              <th key={head} style={{ textAlign: "left", borderBottom: "1px solid var(--oc-border)", padding: 4 }}>
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list?.items.map((item) => (
            <tr key={item.id}>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", fontSize: 11.5 }}>
                {item.accountId ?? item.email ?? item.deviceHash ?? "-"}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {item.scope === "site" ? "サイト" : `板 #${item.boardId ?? "?"}`}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>{item.reason}</td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {item.expiresAt ? new Date(item.expiresAt * 1000).toLocaleString("ja-JP") : "無期限"}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {item.active ? <span className="oc-badge oc-badge-red">有効</span> : <span className="oc-badge oc-badge-gray">解除済み</span>}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)" }}>
                {new Date(item.createdAt * 1000).toLocaleString("ja-JP")}
              </td>
              <td style={{ padding: 4, borderBottom: "1px solid var(--oc-border)", textAlign: "right" }}>
                {item.active ? (
                  <button type="button" className="oc-btn oc-btn-sm" onClick={() => lift(item.id)}>
                    解除
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {list && list.items.length === 0 ? (
            <tr>
              <td colSpan={7} className="oc-empty">
                規制はありません
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}