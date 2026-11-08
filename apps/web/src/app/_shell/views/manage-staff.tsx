"use client";

// 板スタッフ任免（板管理人/副管理人/モデレーター）。API は WP1、権限判定はサーバ。
import { useState } from "react";
import { api } from "@/features/board-ui/api";
import { Button, Notice, useToast } from "@/components/ui";
import type { StaffEntry } from "@/features/board-ui/types";

const LEVELS: { value: StaffEntry["level"]; label: string }[] = [
  { value: "admin", label: "板管理人" },
  { value: "deputy", label: "副管理人" },
  { value: "moderator", label: "モデレーター" },
];

export function ManageStaff({
  slug,
  staff,
  onChange,
}: {
  slug: string;
  staff: StaffEntry[];
  onChange: (next: StaffEntry[]) => void;
}) {
  const toast = useToast();
  const [accountName, setAccountName] = useState("");
  const [level, setLevel] = useState<StaffEntry["level"]>("moderator");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    if (!accountName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.setStaff(slug, accountName.trim(), level);
      onChange(next);
      setAccountName("");
      toast.show("スタッフを登録しました");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "スタッフの登録に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: StaffEntry) => {
    if (!window.confirm(`${entry.name}（${entry.level}）を解任しますか？`)) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.removeStaff(slug, entry.accountId);
      onChange(next);
      toast.show("解任しました");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "解任に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="oc-stack">
      <Notice kind="warn">
        スタッフはアカウント名で指定します。対象者は事前にアカウント登録が必要です。任免は監査ログに記録されます。
      </Notice>
      <div className="oc-row">
        <input
          className="oc-input oc-input-sm"
          style={{ maxWidth: 220 }}
          placeholder="アカウント名"
          value={accountName}
          onChange={(event) => setAccountName(event.target.value)}
        />
        <select
          className="oc-select"
          style={{ width: 150 }}
          value={level}
          onChange={(event) => setLevel(event.target.value as StaffEntry["level"])}
        >
          {LEVELS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <Button size="sm" variant="primary" onClick={add} disabled={busy}>
          登録
        </Button>
      </div>
      <div className="oc-surface">
        {staff.length === 0 ? <div className="oc-muted oc-small">スタッフは未登録です。</div> : null}
        {staff.map((entry) => (
          <div key={entry.accountId} className="oc-history-item">
            <span className="oc-badge oc-badge-green">
              {LEVELS.find((item) => item.value === entry.level)?.label ?? entry.level}
            </span>
            <span>{entry.name}</span>
            <span className="oc-spacer" />
            <Button size="sm" variant="danger" onClick={() => void remove(entry)} disabled={busy}>
              解任
            </Button>
          </div>
        ))}
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}