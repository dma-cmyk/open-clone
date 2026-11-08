"use client";

// ログアウトボタン（セッション Cookie を失効させてトップへ戻る）。

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";

export function LogoutButton({ className = "oc-btn oc-btn-sm" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    try {
      await api("POST", "/auth/logout", {});
    } finally {
      // API が失敗しても Cookie は消えている可能性があるため、必ずトップへ戻して再取得させる。
      router.push("/");
      router.refresh();
    }
  };

  return (
    <button type="button" className={className} onClick={logout} disabled={busy}>
      {busy ? "ログアウト中…" : "ログアウト"}
    </button>
  );
}