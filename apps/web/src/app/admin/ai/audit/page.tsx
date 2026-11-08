"use client";

// AI 監査ログビューア（/admin/ai/audit）。
// すべての AI action は結果（ok/queued/denied/rate_limited/stopped/error）に関わらず 1 行残る。
// 本文の平文は保存せず、params_digest（照合用）と 400 文字以内の要約のみ表示する。

import { useCallback, useEffect, useState } from "react";
import type { AiAuditEntry } from "shared";
import { Notice, Spinner } from "../../../../components/ui";
import { aiFetch, errorMessage, formatTime, PageTitle, ResultBadge, RiskBadge } from "../_components";

const RESULTS = ["all", "ok", "queued", "denied", "rate_limited", "stopped", "error"] as const;

export default function AiAuditPage() {
  const [agentId, setAgentId] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState<(typeof RESULTS)[number]>("all");
  const [items, setItems] = useState<AiAuditEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursorValue: string | null, append: boolean) => {
      setError(null);
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (agentId.trim()) params.set("agentId", agentId.trim());
        if (action.trim()) params.set("action", action.trim());
        if (result !== "all") params.set("result", result);
        if (nextCursorValue) params.set("cursor", nextCursorValue);
        const page = await aiFetch<{ items: AiAuditEntry[]; nextCursor: string | null }>(
          "GET",
          `/ai/audit?${params.toString()}`,
        );
        setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [action, agentId, result],
  );

  useEffect(() => {
    setCursor(null);
    setItems(null);
    load(null, false).catch(() => undefined);
  }, [load]);

  return (
    <div className="oc-stack">
      <PageTitle>AI 監査ログ</PageTitle>
      <p className="oc-note" style={{ margin: 0 }}>
        agent / 人間 / system の操作を時系列で表示します。拒否（denied）・レート制限・停止中の拒否も記録されます。
        パラメータ本文は digest と要約のみで、投稿本文そのものは保存しません。
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}

      <form
        className="oc-row"
        style={{ flexWrap: "wrap" }}
        onSubmit={(event) => {
          event.preventDefault();
          setItems(null);
          load(null, false).catch(() => undefined);
        }}
      >
        <input
          className="oc-input"
          style={{ maxWidth: 240 }}
          placeholder="agentId（ULID）"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        />
        <input
          className="oc-input"
          style={{ maxWidth: 240 }}
          placeholder="action（完全一致 例: post.create）"
          value={action}
          onChange={(event) => setAction(event.target.value)}
        />
        <select className="oc-select" value={result} onChange={(event) => setResult(event.target.value as (typeof RESULTS)[number])}>
          {RESULTS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button type="submit" className="oc-btn oc-btn-sm">
          検索
        </button>
      </form>

      {!items ? (
        <Spinner label="監査ログを取得中…" />
      ) : items.length === 0 ? (
        <div className="oc-empty">該当する監査ログはありません。</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                {["時刻", "主体", "action", "risk", "mode", "板", "結果", "要約"].map((head) => (
                  <th key={head} style={{ textAlign: "left", borderBottom: "1px solid #bbb", padding: 4 }}>
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)} style={{ cursor: "pointer" }}>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" }}>{formatTime(entry.createdAt)}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
                    {entry.actorType}
                    <span className="oc-tiny oc-muted"> {entry.agentId ?? entry.actorId ?? "-"}</span>
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{entry.action}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
                    <RiskBadge risk={entry.risk} />
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{entry.mode}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{entry.boardId ?? "-"}</td>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
                    <ResultBadge result={entry.result} />
                  </td>
                  <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0", maxWidth: 320 }}>
                    <span className="oc-small">{entry.paramsSummary ?? ""}</span>
                    {expanded === entry.id ? (
                      <div className="oc-tiny" style={{ marginTop: 4, wordBreak: "break-all" }}>
                        id: {entry.id}
                        {entry.queueId ? ` / queue: ${entry.queueId}` : ""}
                        {entry.paramsDigest ? ` / digest: ${entry.paramsDigest}` : ""}
                        {entry.errorCode ? ` / error: ${entry.errorCode}` : ""}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor ? (
        <button
          type="button"
          className="oc-btn"
          onClick={() => {
            setCursor(nextCursor);
            load(nextCursor, true).catch(() => undefined);
          }}
        >
          さらに読み込む
        </button>
      ) : null}
      {cursor ? <span className="oc-tiny oc-muted">cursor: {cursor}</span> : null}
    </div>
  );
}