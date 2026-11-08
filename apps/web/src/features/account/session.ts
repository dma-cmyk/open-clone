"use client";

// セッション取得フック（/v1/auth/session）。
// ログイン/ログアウト直後のクライアント遷移でも表示が古くならないよう、パス変更ごとに再取得する。

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { SessionState } from "shared";
import { api } from "./api";

export interface UseSessionResult {
  state: SessionState | null;
  loading: boolean;
  refresh: () => Promise<SessionState>;
}

export function useSession(): UseSessionResult {
  const pathname = usePathname();
  const [state, setState] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const next = await api<SessionState>("GET", "/auth/session");
    setState(next);
    setLoading(false);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh, pathname]);

  return { state, loading, refresh };
}