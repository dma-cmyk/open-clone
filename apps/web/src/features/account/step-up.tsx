"use client";

// 高リスク操作の TOTP 再認証 UI。
// STEP_UP_REQUIRED を受けた操作を保留し、コード検証後に同じ操作を再実行する。

import { useCallback, useState } from "react";
import { ApiRequestError, api, errorMessage } from "./api";

export interface StepUpGate {
  /** 操作を実行し、STEP_UP_REQUIRED ならダイアログを開いて保留する */
  run: (action: () => Promise<void>) => Promise<void>;
  dialog: React.ReactNode;
}

export function useStepUp(onError?: (message: string) => void): StepUpGate {
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === "STEP_UP_REQUIRED") {
          setMessage("この操作には TOTP コード（またはリカバリーコード）による再認証が必要です。");
          setPending(() => action);
          return;
        }
        onError?.(errorMessage(error));
      }
    },
    [onError],
  );

  const close = () => {
    setPending(null);
    setCode("");
    setMessage(null);
  };

  const verify = async () => {
    if (!pending) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", "/auth/step-up", { code: code.trim() });
      const action = pending;
      setPending(null);
      setCode("");
      await action();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const dialog = pending ? (
    <div className="oc-modal-backdrop" role="dialog" aria-modal="true" aria-label="TOTP 再認証">
      <div className="oc-modal" style={{ width: "min(420px, 96vw)" }}>
        <div className="oc-modal-head">
          <span>TOTP 再認証</span>
          <button type="button" className="oc-btn oc-btn-sm" onClick={close}>
            閉じる
          </button>
        </div>
        <div className="oc-modal-body oc-stack">
          <p className="oc-small" style={{ margin: 0 }}>
            高リスク操作のため、認証アプリの 6 桁コード（またはリカバリーコード）を入力してください。
          </p>
          {message ? <div className="oc-error">{message}</div> : null}
          <input
            className="oc-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="oc-modal-foot">
          <button type="button" className="oc-btn" onClick={close}>
            キャンセル
          </button>
          <button type="button" className="oc-btn oc-btn-primary" disabled={busy || code.trim().length < 6} onClick={verify}>
            {busy ? "検証中…" : "認証して実行"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { run, dialog };
}