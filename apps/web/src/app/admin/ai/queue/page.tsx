"use client";

// AI 承認キュー（/admin/ai/queue）。
// high リスクは常にここで人間が原文根拠を確認して承認する（AI の要約だけを根拠にしない）。
// 一括承認は API 側で禁止（1 件ずつ）。却下には理由が必要。

import { useCallback, useEffect, useState } from "react";
import type { AiQueueItem } from "shared";
import { Notice, Spinner } from "../../../../components/ui";
import { aiFetch, errorMessage, formatTime, PageTitle, QueueStatusBadge, RiskBadge } from "../_components";

const STATUSES = ["pending", "executed", "rejected", "failed", "expired", "all"] as const;
type QueueFilter = (typeof STATUSES)[number];

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function AiQueuePage() {
  const [filter, setFilter] = useState<QueueFilter>("pending");
  const [items, setItems] = useState<AiQueueItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(
    async (nextFilter: QueueFilter, nextCursorValue: string | null, append: boolean) => {
      setError(null);
      try {
        const params = new URLSearchParams({ status: nextFilter, limit: "30" });
        if (nextCursorValue) params.set("cursor", nextCursorValue);
        const page = await aiFetch<{ items: AiQueueItem[]; nextCursor: string | null }>(
          "GET",
          `/ai/queue?${params.toString()}`,
        );
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [],
  );

  useEffect(() => {
    setCursor(null);
    setItems(null);
    load(filter, null, false).catch(() => undefined);
  }, [filter, load]);

  const decide = async (item: AiQueueItem, decision: "approve" | "reject") => {
    const note = (notes[item.id] ?? "").trim();
    if (decision === "reject" && !note) {
      setError("却下には理由（note）が必要です。");
      return;
    }
    if (decision === "approve") {
      if (!window.confirm(`「${item.summary}」を承認して実行します。\naction: ${item.action}\nこの操作は監査ログに記録されます。`)) {
        return;
      }
    }
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      const decided = await aiFetch<AiQueueItem>("POST", `/ai/queue/${item.id}/decide`, {
        decision,
        ...(note ? { note } : {}),
      });
      setNotice(
        decision === "approve"
          ? decided.status === "executed"
            ? "承認して実行しました。"
            : `承認しましたが実行に失敗しました: ${decided.error ?? decided.status}`
          : "却下しました。",
      );
      setItems((prev) => prev?.map((row) => (row.id === decided.id ? decided : row)) ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="oc-stack">
      <PageTitle>AI 承認キュー</PageTitle>
      <p className="oc-note" style={{ margin: 0 }}>
        高リスク操作（削除・アク禁・板ルール変更・プラグイン審査など）は自動実行されません。根拠（投稿原文・通報内容）を
        確認してから承認してください。承認時にもう一度政策・停止状態・担当範囲が再評価されます。
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {notice ? <Notice kind="ok">{notice}</Notice> : null}

      <div className="oc-row" style={{ flexWrap: "wrap" }}>
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className={`oc-chip ${filter === status ? "oc-chip-active" : ""}`}
            onClick={() => setFilter(status)}
          >
            {status}
          </button>
        ))}
        <button
          type="button"
          className="oc-btn oc-btn-sm"
          onClick={() => {
            setItems(null);
            load(filter, null, false).catch(() => undefined);
          }}
        >
          再読込
        </button>
      </div>

      {!items ? (
        <Spinner label="承認キューを取得中…" />
      ) : items.length === 0 ? (
        <div className="oc-empty">該当する項目はありません。</div>
      ) : (
        <div className="oc-stack">
          {items.map((item) => (
            <div key={item.id} className="oc-card">
              <div className="oc-row-between">
                <strong>{item.summary || item.action}</strong>
                <div className="oc-row" style={{ gap: 4 }}>
                  <RiskBadge risk={item.risk} />
                  <QueueStatusBadge status={item.status} />
                </div>
              </div>
              <div className="oc-small oc-muted">
                {item.agentName ?? item.agentId ?? "(agent 不明)"} / action: {item.action} / 板:{" "}
                {item.boardId ?? "-"} / 要求 {formatTime(item.requestedAt)} / 期限 {formatTime(item.expiresAt)}
                {item.decidedBy ? ` / 判断 ${item.decidedBy} ${formatTime(item.decidedAt)}` : ""}
              </div>

              {item.evidence ? (
                <details open={item.status === "pending"}>
                  <summary className="oc-small">根拠（原文・通報・コード抜粋）</summary>
                  <pre
                    className="oc-small"
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 280, overflow: "auto", margin: "4px 0" }}
                  >
                    {stringify(item.evidence)}
                  </pre>
                </details>
              ) : (
                <div className="oc-small oc-muted">根拠データはありません。</div>
              )}

              <details>
                <summary className="oc-small">実行パラメータ</summary>
                <pre
                  className="oc-small"
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflow: "auto", margin: "4px 0" }}
                >
                  {stringify(item.params)}
                </pre>
              </details>

              {item.note ? <div className="oc-small">note: {item.note}</div> : null}
              {item.error ? <div className="oc-small oc-error">実行エラー: {item.error}</div> : null}
              {item.result ? (
                <details>
                  <summary className="oc-small">実行結果</summary>
                  <pre className="oc-small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflow: "auto" }}>
                    {stringify(item.result)}
                  </pre>
                </details>
              ) : null}
              {item.idempotencyKey ? <div className="oc-tiny oc-muted">idempotency: {item.idempotencyKey}</div> : null}

              {item.status === "pending" ? (
                <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
                  <input
                    className="oc-input"
                    style={{ maxWidth: 360 }}
                    placeholder="却下理由（却下時は必須）/ 承認メモ"
                    value={notes[item.id] ?? ""}
                    onChange={(event) => setNotes((prev) => ({ ...prev, [item.id]: event.target.value }))}
                    maxLength={2000}
                  />
                  <button
                    type="button"
                    className="oc-btn oc-btn-primary oc-btn-sm"
                    disabled={busy === item.id}
                    onClick={() => void decide(item, "approve")}
                  >
                    承認して実行
                  </button>
                  <button
                    type="button"
                    className="oc-btn oc-btn-danger oc-btn-sm"
                    disabled={busy === item.id}
                    onClick={() => void decide(item, "reject")}
                  >
                    却下
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {nextCursor ? (
        <button
          type="button"
          className="oc-btn"
          onClick={() => {
            setCursor(nextCursor);
            load(filter, nextCursor, true).catch(() => undefined);
          }}
        >
          さらに読み込む
        </button>
      ) : null}
      {cursor ? <span className="oc-tiny oc-muted">cursor: {cursor}</span> : null}
    </div>
  );
}