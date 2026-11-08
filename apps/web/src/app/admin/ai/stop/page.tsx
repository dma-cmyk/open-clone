"use client";

// 緊急停止・解除（/admin/ai/stop）。
// 全体 / 板 / agent の 3 スコープ。停止は即時（AiGate DO）、解除はサイト管理者のみで監査される。
// agent 個別の解除は作成者も可能（サーバー側で判定）。

import { useCallback, useEffect, useState } from "react";
import type { AiAgent, AiStatus, BoardSummary } from "shared";
import { Notice, Spinner } from "../../../../components/ui";
import { aiFetch, errorMessage, formatTime, PageTitle } from "../_components";

export default function AiStopPage() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [globalReason, setGlobalReason] = useState("異常検知のため全 AI を停止");
  const [boardId, setBoardId] = useState<number | "">("");
  const [boardReason, setBoardReason] = useState("板単位の異常検知");
  const [agentId, setAgentId] = useState("");
  const [agentReason, setAgentReason] = useState("管理者による停止");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextStatus, agentList, boardList] = await Promise.all([
        aiFetch<AiStatus>("GET", "/ai/status"),
        aiFetch<{ items: AiAgent[] }>("GET", "/ai/agents"),
        aiFetch<{ items: BoardSummary[] }>("GET", "/boards?limit=100").catch(() => ({ items: [] })),
      ]);
      setStatus(nextStatus);
      setAgents(agentList.items);
      setBoards(boardList.items);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (scope: "global" | "board" | "agent", reason: string, target: { boardId?: number; agentId?: string }) => {
    if (!window.confirm("AI 操作を停止します。よろしいですか？")) return;
    await run(`stop:${scope}:${target.boardId ?? target.agentId ?? "all"}`, async () => {
      await aiFetch("POST", "/ai/stop", { scope, reason, ...target });
      setNotice(`${scope} スコープで停止しました。以降の AI 呼び出しは即時拒否されます。`);
      await load();
    });
  };

  const resume = async (scope: "global" | "board" | "agent", target: { boardId?: number; agentId?: string }) => {
    await run(`resume:${scope}:${target.boardId ?? target.agentId ?? "all"}`, async () => {
      await aiFetch("POST", "/ai/resume", { scope, ...target });
      setNotice(`${scope} スコープの停止を解除しました（監査ログに記録）。`);
      await load();
    });
  };

  if (!status && !error) return <Spinner label="停止状態を取得中…" />;

  const suspendedAgents = agents.filter((agent) => agent.status === "suspended");

  return (
    <div className="oc-stack">
      <PageTitle>緊急停止・解除</PageTitle>
      <p className="oc-note" style={{ margin: 0 }}>
        停止フラグは Durable Object（SQLite-backed）に保存され、全 isolate に数秒以内に反映されます。停止中は
        認証済み AI の全 REST/MCP 呼び出しが拒否され、監査ログに result=stopped で残ります。解除も監査されます。
      </p>
      {error ? <Notice kind="error" onRetry={() => void load()}>{error}</Notice> : null}
      {notice ? <Notice kind="ok">{notice}</Notice> : null}

      {status ? (
        <div className={status.stop.globalStopped ? "oc-error" : "oc-ok"}>
          <div className="oc-row-between">
            <strong>全体: {status.stop.globalStopped ? "停止中" : "稼働中"}</strong>
            <span className="oc-small">
              {status.stop.globalStopped
                ? `${status.stop.reason ?? "理由未記録"} / ${formatTime(status.stop.stoppedAt)}`
                : "全 agent が稼働可能"}
            </span>
          </div>
          <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            {status.stop.globalStopped ? (
              <button
                type="button"
                className="oc-btn oc-btn-primary oc-btn-sm"
                disabled={busy === "resume:global:all"}
                onClick={() => void resume("global", {})}
              >
                全体停止を解除
              </button>
            ) : (
              <>
                <input
                  className="oc-input"
                  style={{ maxWidth: 360 }}
                  value={globalReason}
                  onChange={(event) => setGlobalReason(event.target.value)}
                  maxLength={500}
                />
                <button
                  type="button"
                  className="oc-btn oc-btn-danger oc-btn-sm"
                  disabled={busy === "stop:global:all"}
                  onClick={() => void stop("global", globalReason.trim() || "管理者による停止", {})}
                >
                  全 AI を停止
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      <section className="oc-card">
        <strong>板単位</strong>
        <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
          <select className="oc-select" value={boardId} onChange={(event) => setBoardId(Number(event.target.value))}>
            <option value="">板を選択</option>
            {boards.map((board) => (
              <option key={board.id} value={board.id}>
                #{board.id} {board.name} (/{board.slug})
              </option>
            ))}
          </select>
          <input
            className="oc-input"
            style={{ maxWidth: 300 }}
            value={boardReason}
            onChange={(event) => setBoardReason(event.target.value)}
            maxLength={500}
          />
          <button
            type="button"
            className="oc-btn oc-btn-danger oc-btn-sm"
            disabled={boardId === "" || busy === `stop:board:${boardId}`}
            onClick={() => void stop("board", boardReason.trim() || "板単位の停止", { boardId: Number(boardId) })}
          >
            この板の AI を停止
          </button>
        </div>
        {status && status.stop.boards.length > 0 ? (
          <div className="oc-stack" style={{ marginTop: 8 }}>
            {status.stop.boards.map((board) => (
              <div key={board.boardId} className="oc-surface oc-row-between" style={{ padding: 8 }}>
                <span className="oc-small">
                  板 #{board.boardId}: {board.reason} / {formatTime(board.stoppedAt)}
                </span>
                <button
                  type="button"
                  className="oc-btn oc-btn-sm"
                  disabled={busy === `resume:board:${board.boardId}`}
                  onClick={() => void resume("board", { boardId: board.boardId })}
                >
                  解除
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="oc-empty">停止中の板はありません。</div>
        )}
      </section>

      <section className="oc-card">
        <strong>agent 単位</strong>
        <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
          <select className="oc-select" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">agent を選択</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}（{agent.status}）
              </option>
            ))}
          </select>
          <input
            className="oc-input"
            style={{ maxWidth: 300 }}
            value={agentReason}
            onChange={(event) => setAgentReason(event.target.value)}
            maxLength={500}
          />
          <button
            type="button"
            className="oc-btn oc-btn-danger oc-btn-sm"
            disabled={!agentId || busy === `stop:agent:${agentId}`}
            onClick={() => void stop("agent", agentReason.trim() || "管理者による停止", { agentId })}
          >
            この agent を停止
          </button>
        </div>
        {suspendedAgents.length > 0 ? (
          <div className="oc-stack" style={{ marginTop: 8 }}>
            {suspendedAgents.map((agent) => (
              <div key={agent.id} className="oc-surface oc-row-between" style={{ padding: 8 }}>
                <span className="oc-small">
                  {agent.name}: {agent.suspendedReason ?? "理由未記録"}
                </span>
                <button
                  type="button"
                  className="oc-btn oc-btn-sm"
                  disabled={busy === `resume:agent:${agent.id}`}
                  onClick={() => void resume("agent", { agentId: agent.id })}
                >
                  再開
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="oc-empty">停止中の agent はありません。</div>
        )}
      </section>
    </div>
  );
}