"use client";

// 確認カード（書き込み・削除などの前に必ず出す）。
//
// - 何を・どこに・どの操作で行うかを、ツールが作った `details` のまま出す（HTML として解釈しない）。
// - `danger` の操作（削除・管理）は警告色にし、ボタンを「実行する（取り消せません）」にする。
// - `turnstile` が要る板では、Bot 確認を通すまで「実行」を押せない。
//   すでにその板の 30 分パスが有効ならウィジェットは出さず、トークンなしで実行する（サーバー側で省略）。
// - 取り消したら呼び出し側が `null` を受け取り、AI には `CANCELED` を返す（ツールは走らない）。

import { useCallback, useState } from "react";
import { TurnstileWidget } from "@/features/account/turnstile";
import { useTurnstilePass } from "@/features/board-ui/turnstile-pass-store";
import type { PetConfirmRequest } from "../contract";

export function PetConfirmCard({
  request,
  boardSlug,
  decision,
  onDecide,
}: {
  request: PetConfirmRequest;
  /** Turnstile の 30 分パスを板ごとに見るための slug（分からなければ null）。 */
  boardSlug: string | null;
  /** すでに決めたカードは結果だけ出す（null は決定待ち）。 */
  decision: "approved" | "canceled" | null;
  onDecide: (approval: "approved" | "canceled", turnstileToken: string | null) => void;
}) {
  const turnstilePass = useTurnstilePass(boardSlug ?? "");
  const needsTurnstile = request.turnstile === true && decision === null && !turnstilePass.passed;
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const acceptToken = useCallback((value: string | null) => {
    setToken(value && value.length > 0 ? value : null);
  }, []);
  const onUnavailable = useCallback(() => {
    setToken(null);
    setUnavailable(true);
  }, []);

  if (decision !== null) {
    return (
      <div className={`oc-pet-confirm oc-pet-confirm-done${request.danger ? " oc-pet-confirm-danger" : ""}`}>
        <div className="oc-pet-confirm-title">{request.title}</div>
        <p className="oc-pet-confirm-result" role="status">
          {decision === "approved" ? "実行しました。" : "取り消しました。"}
        </p>
      </div>
    );
  }

  // トークンが要るのに取れないときは実行させない（読めないまま書き込ませない）。
  const canRun = !needsTurnstile || token !== null;

  return (
    <div
      className={`oc-pet-confirm${request.danger ? " oc-pet-confirm-danger" : ""}`}
      data-testid="pet-confirm-card"
      role="group"
      aria-label={request.title}
    >
      <div className="oc-pet-confirm-title">{request.title}</div>
      <dl className="oc-pet-confirm-fields">
        {request.details.map((detail, index) => (
          <div key={`${detail.label}-${index}`} className="oc-pet-confirm-row">
            <dt>{detail.label}</dt>
            <dd data-testid={`pet-confirm-detail-${index}`}>{detail.value}</dd>
          </div>
        ))}
      </dl>
      {request.turnstile && !turnstilePass.passed ? (
        <div className="oc-pet-confirm-turnstile">
          <p className="oc-tiny oc-muted">この板では書き込みに Bot 確認が必要です。</p>
          <TurnstileWidget onToken={acceptToken} onUnavailable={onUnavailable} resetKey={resetKey} />
          {unavailable ? (
            <p className="oc-tiny oc-error-text" role="alert" data-testid="pet-confirm-turnstile-unavailable">
              ロボット確認を読み込めませんでした。ページを再読み込みしてください。
            </p>
          ) : null}
          <button
            type="button"
            className="oc-btn oc-btn-sm"
            onClick={() => {
              setToken(null);
              setUnavailable(false);
              setResetKey((value) => value + 1);
            }}
          >
            確認をやり直す
          </button>
        </div>
      ) : null}
      <div className="oc-pet-confirm-actions">
        <button
          type="button"
          className="oc-btn"
          data-testid="pet-confirm-cancel"
          onClick={() => onDecide("canceled", null)}
        >
          やめる
        </button>
        <button
          type="button"
          className={request.danger ? "oc-btn oc-btn-danger" : "oc-btn oc-btn-primary"}
          data-testid="pet-confirm-run"
          disabled={!canRun}
          onClick={() => onDecide("approved", needsTurnstile ? token : null)}
        >
          {request.danger ? "実行する（取り消せません）" : "実行"}
        </button>
      </div>
    </div>
  );
}