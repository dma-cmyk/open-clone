"use client";

// 板管理画面の AI 設定パネル。
// WP2 の `b/[slug]/manage/ai` から `<AiBoardPanel slug={slug} boardId={board.id} canManage={canManage} />` として import する。
// 板管理人（board admin）が自分の板に外部 AI 管理者を接続・制限・停止できる。サイト管理者向けの全サイト機能は /admin/ai。
//
// セキュリティ方針（DESIGN §10.5）:
// - 権限判定はすべてサーバー側（この UI の表示制御は利便性のみ）。
// - 承認は人間セッション必須。キューに積まれた AI の要約ではなく、原文の evidence をそのまま表示する。
// - Webhook secret / API key は発行時に一度だけ表示し、再表示しない。

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AiAgent,
  AiAgentWithKey,
  AiPolicy,
  AiQueueItem,
  AiStatus,
  PolicyMode,
  RiskCap,
  Webhook,
  WebhookEventType,
  WebhookWithSecret,
} from "shared";
import { WEBHOOK_EVENT_TYPES } from "shared";
import { Button, Notice, Spinner } from "./ui";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "/api/v1").replace(/\/$/, "");

interface Envelope {
  ok?: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

async function call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "include",
  });
  let json: Envelope | null = null;
  try {
    json = (await response.json()) as Envelope;
  } catch {
    json = null;
  }
  if (!json || typeof json.ok !== "boolean") {
    throw new Error(`API 応答が不正です (HTTP ${response.status})`);
  }
  if (!json.ok) {
    throw new Error(json.message ?? json.code ?? "エラーが発生しました");
  }
  return json.data as T;
}



interface ActionCatalogItem {
  name: string;
  risk: "low" | "medium" | "high" | "never";
  description: string;
  humanOnly: boolean;
  approvalScope: string | null;
}

interface AgentDraft {
  riskCap: RiskCap;
  rateLimitPerMin: number;
  dailyLimit: number;
  displayName: string;
}

export interface AiBoardPanelProps {
  /** 板 slug（必須）。boardId 未指定時は `/v1/boards/:slug` から解決する。 */
  slug: string;
  /** 板 ID（任意。親画面が既に持っている場合は渡すと解決リクエストを省略できる） */
  boardId?: number;
  /** 板管理人以上か（false/未指定でも API 側で最終判定される。false のときは作成 UI を隠す） */
  canManage?: boolean;
}

function riskBadgeClass(risk: string): string {
  if (risk === "high" || risk === "never") return "oc-badge oc-badge-red";
  if (risk === "medium") return "oc-badge oc-badge-yellow";
  return "oc-badge oc-badge-gray";
}

function statusBadge(agent: AiAgent) {
  if (agent.status === "active") return <span className="oc-badge oc-badge-green">稼働中</span>;
  if (agent.status === "suspended") return <span className="oc-badge oc-badge-red">停止中</span>;
  return <span className="oc-badge oc-badge-gray">失効</span>;
}

function boardRelevant(agent: AiAgent, boardId: number): boolean {
  if (agent.boardId === boardId) return true;
  if (agent.allowedBoards === "*") return false; // 全板担当はサイト管理者のみ
  return agent.allowedBoards.includes(boardId);
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString("ja-JP");
}

export function AiBoardPanel({ slug, boardId: boardIdProp, canManage = true }: AiBoardPanelProps) {
  const [boardId, setBoardId] = useState<number | null>(boardIdProp ?? null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [policies, setPolicies] = useState<AiPolicy[] | null>(null);
  const [queue, setQueue] = useState<AiQueueItem[] | null>(null);
  const [catalog, setCatalog] = useState<ActionCatalogItem[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  // 一度だけ表示する秘密（API キー / Webhook secret）
  const [secret, setSecret] = useState<{ title: string; value: string; warning: string } | null>(null);

  // 作成フォーム
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("AI運営");
  const [description, setDescription] = useState("");
  const [riskCap, setRiskCap] = useState<RiskCap>("medium");
  const [rateLimit, setRateLimit] = useState(30);
  const [dailyLimit, setDailyLimit] = useState(2000);

  // 個別操作
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const [suspendReason, setSuspendReason] = useState<Record<string, string>>({});
  const [queueNotes, setQueueNotes] = useState<Record<string, string>>({});
  const [stopReason, setStopReason] = useState("メンテナンスのため一時停止");

  // 政策フォーム
  const [policyAction, setPolicyAction] = useState("");
  const [policyMode, setPolicyMode] = useState<PolicyMode>("queue");

  // Webhook フォーム
  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState<WebhookEventType[]>(["queue.pending", "agent.suspended", "anomaly.detected"]);

  const resolveBoard = useCallback(async (): Promise<number | null> => {
    if (boardIdProp) return boardIdProp;
    const detail = await call<{ board: { id: number } }>("GET", `/boards/${encodeURIComponent(slug)}`);
    return detail.board.id;
  }, [boardIdProp, slug]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const id = boardId ?? (await resolveBoard());
      if (id === null) throw new Error("板 ID を解決できませんでした");
      setBoardId(id);

      const [nextStatus, agentList, policyList, queuePage, actionList, hookList] = await Promise.all([
        call<AiStatus>("GET", "/ai/status"),
        call<{ items: AiAgent[] }>("GET", "/ai/agents"),
        call<{ items: AiPolicy[] }>("GET", `/ai/policies?scope=board&scopeId=${id}`),
        call<{ items: AiQueueItem[] }>("GET", "/ai/queue?status=pending&limit=50"),
        call<{ items: ActionCatalogItem[] }>("GET", "/ai/actions"),
        call<{ items: Webhook[] }>("GET", "/ai/webhooks"),
      ]);

      setStatus(nextStatus);
      setAgents(agentList.items.filter((agent) => boardRelevant(agent, id)));
      setPolicies(policyList.items);
      setQueue(queuePage.items.filter((item) => item.boardId === null || item.boardId === id));
      setCatalog(actionList.items.filter((item) => item.risk !== "never" && !item.humanOnly && item.risk !== "low"));
      setWebhooks(hookList.items.filter((hook) => hook.ownerType === "board" && hook.ownerId === String(id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "AI 設定の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [boardId, resolveBoard]);

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, boardIdProp]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const boardStopped = useMemo(
    () => Boolean(boardId && status?.stop.boards.some((board) => board.boardId === boardId)),
    [boardId, status],
  );
  const globalStopped = status?.stop.globalStopped ?? false;

  const createAgent = async () => {
    if (!boardId) return;
    await run("create", async () => {
      const created = await call<AiAgentWithKey>("POST", "/ai/agents", {
        name: name.trim(),
        description: description.trim() || undefined,
        ownerType: "board",
        boardId,
        allowedBoards: [boardId],
        riskCap,
        rateLimitPerMin: rateLimit,
        dailyLimit,
        displayName: displayName.trim() || "AI運営",
      });
      setSecret({ title: `API キー（${created.name}）`, value: created.apiKey, warning: created.keyWarning });
      setName("");
      setDescription("");
      setNotice("AI 管理者を登録しました。接続先に API キーを設定してください。");
      await load();
    });
  };

  const saveAgent = async (agent: AiAgent) => {
    const draft = drafts[agent.id];
    if (!draft) return;
    await run(`save:${agent.id}`, async () => {
      await call<AiAgent>("PATCH", `/ai/agents/${agent.id}`, draft);
      setNotice(`${agent.name} の設定を更新しました。`);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
      await load();
    });
  };

  const rotateKey = async (agent: AiAgent) => {
    await run(`rotate:${agent.id}`, async () => {
      const rotated = await call<AiAgentWithKey>("POST", `/ai/agents/${agent.id}/rotate-key`);
      setSecret({ title: `新しい API キー（${agent.name}）`, value: rotated.apiKey, warning: rotated.keyWarning });
      await load();
    });
  };

  const suspendAgent = async (agent: AiAgent) => {
    const reason = (suspendReason[agent.id] ?? "").trim() || "板管理人による停止";
    await run(`suspend:${agent.id}`, async () => {
      await call<AiAgent>("POST", `/ai/agents/${agent.id}/suspend`, { reason });
      setNotice(`${agent.name} を停止しました。`);
      await load();
    });
  };

  const resumeAgent = async (agent: AiAgent) => {
    await run(`resume:${agent.id}`, async () => {
      await call<AiAgent>("POST", `/ai/agents/${agent.id}/resume`);
      setNotice(`${agent.name} を再開しました。`);
      await load();
    });
  };

  const revokeAgent = async (agent: AiAgent) => {
    if (!window.confirm(`${agent.name} を失効（削除）します。よろしいですか？`)) return;
    await run(`revoke:${agent.id}`, async () => {
      await call("DELETE", `/ai/agents/${agent.id}`);
      setNotice(`${agent.name} を失効しました。`);
      await load();
    });
  };

  const stopBoard = async () => {
    if (!boardId) return;
    if (!window.confirm("この板の AI 操作をすべて停止します。よろしいですか？")) return;
    await run("stop", async () => {
      await call<AiStatus["stop"]>("POST", "/ai/stop", { scope: "board", boardId, reason: stopReason.trim() || "板管理人による停止" });
      setNotice("この板の AI を停止しました。");
      await load();
    });
  };

  const resumeBoard = async () => {
    if (!boardId) return;
    await run("resume", async () => {
      await call<AiStatus["stop"]>("POST", "/ai/resume", { scope: "board", boardId });
      setNotice("この板の AI 停止を解除しました。");
      await load();
    });
  };

  const decide = async (item: AiQueueItem, decision: "approve" | "reject") => {
    const note = (queueNotes[item.id] ?? "").trim();
    if (decision === "reject" && !note) {
      setError("却下には理由（note）が必要です。");
      return;
    }
    if (decision === "approve" && !window.confirm(`「${item.summary}」を承認して実行します。よろしいですか？`)) return;
    await run(`decide:${item.id}`, async () => {
      await call<AiQueueItem>("POST", `/ai/queue/${item.id}/decide`, {
        decision,
        ...(note ? { note } : {}),
      });
      setNotice(decision === "approve" ? "承認して実行しました。" : "却下しました。");
      await load();
    });
  };

  const savePolicy = async () => {
    if (!boardId || !policyAction) return;
    await run("policy", async () => {
      await call<AiPolicy>("PUT", "/ai/policies", {
        scope: "board",
        scopeId: String(boardId),
        action: policyAction,
        mode: policyMode,
      });
      setNotice(`政策を保存しました（${policyAction} → ${policyMode}）。`);
      await load();
    });
  };

  const deletePolicy = async (policy: AiPolicy) => {
    await run(`policy-del:${policy.id}`, async () => {
      await call("DELETE", `/ai/policies/${policy.id}`);
      setNotice("政策を削除しました（リスク既定に戻ります）。");
      await load();
    });
  };

  const createWebhook = async () => {
    if (!boardId) return;
    await run("hook-create", async () => {
      const created = await call<WebhookWithSecret>("POST", "/ai/webhooks", {
        ownerType: "board",
        ownerId: String(boardId),
        url: hookUrl.trim(),
        events: hookEvents,
      });
      setSecret({ title: "Webhook 署名シークレット", value: created.secret, warning: created.secretWarning });
      setHookUrl("");
      setNotice("Webhook を登録しました。配信先で署名を検証してください。");
      await load();
    });
  };

  const toggleWebhook = async (hook: Webhook) => {
    await run(`hook-toggle:${hook.id}`, async () => {
      await call<Webhook>("PATCH", `/ai/webhooks/${hook.id}`, { active: !hook.active });
      await load();
    });
  };

  const deleteWebhook = async (hook: Webhook) => {
    if (!window.confirm("この Webhook を削除します。よろしいですか？")) return;
    await run(`hook-del:${hook.id}`, async () => {
      await call("DELETE", `/ai/webhooks/${hook.id}`);
      await load();
    });
  };

  const testWebhook = async (hook: Webhook) => {
    await run(`hook-test:${hook.id}`, async () => {
      await call("POST", `/ai/webhooks/${hook.id}/test`);
      setNotice("テストイベントを送信しました。配信結果は deliveries で確認できます。");
    });
  };

  if (loading) return <Spinner label="AI 設定を読み込み中…" />;

  if (error && !agents) {
    return (
      <Notice kind="error" onRetry={() => void load()}>
        {error}
      </Notice>
    );
  }

  return (
    <div className="oc-stack">
      {error ? <Notice kind="error">{error}</Notice> : null}
      {notice ? <Notice kind="ok">{notice}</Notice> : null}

      {globalStopped ? (
        <Notice kind="warn">
          サイト全体の AI が緊急停止中です（{status?.stop.reason ?? "理由未記録"} / {formatTime(status?.stop.stoppedAt)}）。
          サイト管理者が解除するまで、この板の AI も動作しません。
        </Notice>
      ) : null}

      {boardStopped ? (
        <Notice kind="warn">
          この板の AI は停止中です（{status?.stop.boards.find((board) => board.boardId === boardId)?.reason ?? "理由未記録"}）。
        </Notice>
      ) : null}

      {secret ? (
        <div className="oc-warn-box">
          <div className="oc-row-between">
            <strong>{secret.title}</strong>
            <Button
              size="sm"
              onClick={() => {
                navigator.clipboard?.writeText(secret.value).catch(() => undefined);
                setNotice("クリップボードにコピーしました。");
              }}
            >
              コピー
            </Button>
          </div>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "6px 0" }}>{secret.value}</pre>
          <div className="oc-small">{secret.warning}</div>
          <div className="oc-row" style={{ marginTop: 6 }}>
            <Button size="sm" onClick={() => setSecret(null)}>
              保存したので閉じる
            </Button>
          </div>
        </div>
      ) : null}

      {/* ───────── 緊急停止（板単位） ───────── */}
      <section className="oc-card">
        <div className="oc-row-between">
          <strong>この板の AI 操作</strong>
          <span className={boardStopped ? "oc-badge oc-badge-red" : "oc-badge oc-badge-green"}>
            {boardStopped ? "停止中" : "稼働可"}
          </span>
        </div>
        <div className="oc-small oc-muted">
          停止するとこの板を対象とするすべての AI 操作（投稿・非表示・通報処理など）が即時拒否されます。
          解除は板管理人またはサイト管理者が行えます。
        </div>
        <div className="oc-row" style={{ marginTop: 8 }}>
          {boardStopped ? (
            <Button variant="primary" size="sm" disabled={busy === "resume"} onClick={() => void resumeBoard()}>
              停止を解除
            </Button>
          ) : (
            <>
              <input
                className="oc-input"
                style={{ maxWidth: 320 }}
                placeholder="停止理由"
                value={stopReason}
                onChange={(event) => setStopReason(event.target.value)}
                maxLength={500}
              />
              <Button variant="danger" size="sm" disabled={busy === "stop"} onClick={() => void stopBoard()}>
                AI を緊急停止
              </Button>
            </>
          )}
        </div>
      </section>

      {/* ───────── 接続 AI 管理者 ───────── */}
      <section className="oc-card">
        <div className="oc-row-between">
          <strong>接続中の AI 管理者</strong>
          <span className="oc-small oc-muted">{agents?.length ?? 0} 体</span>
        </div>

        {agents && agents.length > 0 ? (
          <div className="oc-stack" style={{ marginTop: 8 }}>
            {agents.map((agent) => {
              const draft = drafts[agent.id] ?? null;
              return (
                <div key={agent.id} className="oc-surface" style={{ padding: 8 }}>
                  <div className="oc-row-between">
                    <div>
                      <strong>{agent.name}</strong>{" "}
                      <span className="oc-tiny oc-muted">名義: {agent.displayName}</span>
                    </div>
                    <div className="oc-row" style={{ gap: 4 }}>
                      {statusBadge(agent)}
                      <span className={riskBadgeClass(agent.riskCap)}>cap: {agent.riskCap}</span>
                    </div>
                  </div>
                  <div className="oc-small oc-muted">
                    キー: {agent.keyPrefix}… / レート: {agent.rateLimitPerMin} 回/分・{agent.dailyLimit} 回/日 / 最終使用:{" "}
                    {formatTime(agent.lastUsedAt)}
                  </div>
                  {agent.suspendedReason ? <div className="oc-small">停止理由: {agent.suspendedReason}</div> : null}

                  <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                    <Button size="sm" disabled={busy === `rotate:${agent.id}`} onClick={() => void rotateKey(agent)}>
                      キー再発行
                    </Button>
                    {agent.status === "active" ? (
                      <>
                        <input
                          className="oc-input oc-input-sm"
                          style={{ maxWidth: 180 }}
                          placeholder="停止理由"
                          value={suspendReason[agent.id] ?? ""}
                          onChange={(event) =>
                            setSuspendReason((prev) => ({ ...prev, [agent.id]: event.target.value }))
                          }
                          maxLength={500}
                        />
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy === `suspend:${agent.id}`}
                          onClick={() => void suspendAgent(agent)}
                        >
                          停止
                        </Button>
                      </>
                    ) : agent.status === "suspended" ? (
                      <Button size="sm" disabled={busy === `resume:${agent.id}`} onClick={() => void resumeAgent(agent)}>
                        再開
                      </Button>
                    ) : null}
                    <Button size="sm" variant="danger" disabled={busy === `revoke:${agent.id}`} onClick={() => void revokeAgent(agent)}>
                      失効
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        setDrafts((prev) => ({
                          ...prev,
                          [agent.id]: prev[agent.id] ?? {
                            riskCap: agent.riskCap,
                            rateLimitPerMin: agent.rateLimitPerMin,
                            dailyLimit: agent.dailyLimit,
                            displayName: agent.displayName,
                          },
                        }))
                      }
                    >
                      設定変更
                    </Button>
                  </div>

                  {draft ? (
                    <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                      <label className="oc-field">
                        <span className="oc-label">権限上限 (risk_cap)</span>
                        <select
                          className="oc-select"
                          value={draft.riskCap}
                          onChange={(event) =>
                            setDrafts((prev) => ({ ...prev, [agent.id]: { ...draft, riskCap: event.target.value as RiskCap } }))
                          }
                        >
                          <option value="low">low（medium は承認待ち）</option>
                          <option value="medium">medium</option>
                          <option value="high">high（high も承認キュー）</option>
                        </select>
                      </label>
                      <label className="oc-field">
                        <span className="oc-label">回/分</span>
                        <input
                          className="oc-input"
                          style={{ maxWidth: 100 }}
                          type="number"
                          min={1}
                          max={600}
                          value={draft.rateLimitPerMin}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [agent.id]: { ...draft, rateLimitPerMin: Number(event.target.value) },
                            }))
                          }
                        />
                      </label>
                      <label className="oc-field">
                        <span className="oc-label">回/日</span>
                        <input
                          className="oc-input"
                          style={{ maxWidth: 120 }}
                          type="number"
                          min={1}
                          max={100000}
                          value={draft.dailyLimit}
                          onChange={(event) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [agent.id]: { ...draft, dailyLimit: Number(event.target.value) },
                            }))
                          }
                        />
                      </label>
                      <label className="oc-field">
                        <span className="oc-label">投稿名義</span>
                        <input
                          className="oc-input"
                          style={{ maxWidth: 160 }}
                          value={draft.displayName}
                          onChange={(event) =>
                            setDrafts((prev) => ({ ...prev, [agent.id]: { ...draft, displayName: event.target.value } }))
                          }
                          maxLength={50}
                        />
                      </label>
                      <Button size="sm" variant="primary" disabled={busy === `save:${agent.id}`} onClick={() => void saveAgent(agent)}>
                        保存
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          setDrafts((prev) => {
                            const next = { ...prev };
                            delete next[agent.id];
                            return next;
                          })
                        }
                      >
                        取消
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="oc-empty">この板に接続中の AI 管理者はまだありません。</div>
        )}
      </section>

      {/* ───────── 新規登録 ───────── */}
      {canManage ? (
        <section className="oc-card">
          <strong>AI 管理者をこの板に接続</strong>
          <div className="oc-small oc-muted">
            発行した API キーを外部 AI（OMP / Claude Code / Codex / 任意の HTTP クライアント）に設定します。
            REST は <code>/v1/ai/*</code>、MCP は <code>/mcp</code> です。キーはこの画面でしか表示されません。
          </div>
          <div className="oc-grid-2" style={{ marginTop: 8 }}>
            <label className="oc-field">
              <span className="oc-label">管理名（識別用）</span>
              <input className="oc-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} placeholder="例: 板の巡回AI" />
            </label>
            <label className="oc-field">
              <span className="oc-label">投稿名義</span>
              <input className="oc-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={50} />
            </label>
            <label className="oc-field">
              <span className="oc-label">権限上限 (risk_cap)</span>
              <select className="oc-select" value={riskCap} onChange={(event) => setRiskCap(event.target.value as RiskCap)}>
                <option value="low">low — 中リスクも必ず承認待ち（最も安全）</option>
                <option value="medium">medium — 投稿・非表示・通報処理を自動実行</option>
                <option value="high">high — 削除等も「承認キュー経由」でのみ実行</option>
              </select>
            </label>
            <label className="oc-field">
              <span className="oc-label">レート上限（回/分）</span>
              <input
                className="oc-input"
                type="number"
                min={1}
                max={600}
                value={rateLimit}
                onChange={(event) => setRateLimit(Number(event.target.value))}
              />
            </label>
            <label className="oc-field">
              <span className="oc-label">日次上限（回/日）</span>
              <input
                className="oc-input"
                type="number"
                min={1}
                max={100000}
                value={dailyLimit}
                onChange={(event) => setDailyLimit(Number(event.target.value))}
              />
            </label>
            <label className="oc-field">
              <span className="oc-label">説明（任意）</span>
              <input className="oc-input" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} />
            </label>
          </div>
          <div className="oc-row" style={{ marginTop: 8 }}>
            <Button variant="primary" disabled={busy === "create" || !name.trim()} onClick={() => void createAgent()}>
              API キーを発行して接続
            </Button>
            <span className="oc-small oc-muted">担当範囲はこの板のみ。他板・サイト全体の操作は常に拒否されます。</span>
          </div>
        </section>
      ) : (
        <Notice kind="warn">AI 管理者の登録・変更には板管理人（admin）権限が必要です。</Notice>
      )}

      {/* ───────── 承認キュー ───────── */}
      <section className="oc-card">
        <div className="oc-row-between">
          <strong>承認待ち（高リスク操作）</strong>
          <span className="oc-small oc-muted">{queue?.length ?? 0} 件</span>
        </div>
        {!queue || queue.length === 0 ? (
          <div className="oc-empty">承認待ちの操作はありません。</div>
        ) : (
          <div className="oc-stack" style={{ marginTop: 8 }}>
            {queue.map((item) => (
              <div key={item.id} className="oc-surface" style={{ padding: 8 }}>
                <div className="oc-row-between">
                  <strong>{item.summary}</strong>
                  <div className="oc-row" style={{ gap: 4 }}>
                    <span className={riskBadgeClass(item.risk)}>{item.risk}</span>
                    <span className="oc-badge oc-badge-yellow">承認待ち</span>
                  </div>
                </div>
                <div className="oc-small oc-muted">
                  {item.agentName ?? item.agentId} / action: {item.action} / 要求: {formatTime(item.requestedAt)} / 期限:{" "}
                  {formatTime(item.expiresAt)}
                </div>
                {item.evidence ? (
                  <details>
                    <summary className="oc-small">根拠（原文・通報内容）</summary>
                    <pre className="oc-small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 240, overflow: "auto" }}>
                      {JSON.stringify(item.evidence, null, 2)}
                    </pre>
                  </details>
                ) : null}
                <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                  <input
                    className="oc-input oc-input-sm"
                    style={{ maxWidth: 320 }}
                    placeholder="却下理由（却下時は必須）/ 承認メモ"
                    value={queueNotes[item.id] ?? ""}
                    onChange={(event) => setQueueNotes((prev) => ({ ...prev, [item.id]: event.target.value }))}
                    maxLength={2000}
                  />
                  <Button size="sm" variant="primary" disabled={busy === `decide:${item.id}`} onClick={() => void decide(item, "approve")}>
                    承認して実行
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy === `decide:${item.id}`} onClick={() => void decide(item, "reject")}>
                    却下
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ───────── 板の政策 ───────── */}
      <section className="oc-card">
        <strong>この板の AI 政策</strong>
        <div className="oc-small oc-muted">
          リスク既定より厳しくできます（auto → queue/deny）。high は常に人間承認が必要で auto にはできません。
        </div>
        {policies && policies.length > 0 ? (
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  {["action", "mode", "更新", ""].map((head) => (
                    <th key={head} style={{ textAlign: "left", borderBottom: "1px solid #bbb", padding: 4 }}>
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id}>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{policy.action}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{policy.mode}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{formatTime(policy.updatedAt)}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
                      <Button size="sm" disabled={busy === `policy-del:${policy.id}`} onClick={() => void deletePolicy(policy)}>
                        削除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="oc-empty">板固有の政策はありません（サイト既定が適用されます）。</div>
        )}
        <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
          <label className="oc-field">
            <span className="oc-label">action</span>
            <select className="oc-select" value={policyAction} onChange={(event) => setPolicyAction(event.target.value)}>
              <option value="">選択してください</option>
              {catalog.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}（{item.risk}）
                </option>
              ))}
            </select>
          </label>
          <label className="oc-field">
            <span className="oc-label">mode</span>
            <select className="oc-select" value={policyMode} onChange={(event) => setPolicyMode(event.target.value as PolicyMode)}>
              <option value="auto">auto（許可）</option>
              <option value="queue">queue（承認必須）</option>
              <option value="deny">deny（禁止）</option>
            </select>
          </label>
          <Button variant="primary" size="sm" disabled={busy === "policy" || !policyAction} onClick={() => void savePolicy()}>
            政策を保存
          </Button>
        </div>
      </section>

      {/* ───────── Webhook（板スコープ） ───────── */}
      <section className="oc-card">
        <strong>Webhook 通知（この板）</strong>
        <div className="oc-small oc-muted">
          HMAC 署名付き POST（<code>x-openclone-signature: t=…,v1=…</code>）。失敗時は指数バックオフで再送します。
        </div>
        {webhooks && webhooks.length > 0 ? (
          <div className="oc-stack" style={{ marginTop: 8 }}>
            {webhooks.map((hook) => (
              <div key={hook.id} className="oc-surface" style={{ padding: 8 }}>
                <div className="oc-row-between">
                  <code className="oc-small" style={{ wordBreak: "break-all" }}>
                    {hook.url}
                  </code>
                  <span className={hook.active ? "oc-badge oc-badge-green" : "oc-badge oc-badge-gray"}>
                    {hook.active ? "有効" : "停止"}
                  </span>
                </div>
                <div className="oc-small oc-muted">
                  イベント: {hook.events.join(", ")} / 最終配信: {formatTime(hook.lastDeliveryAt)} / 失敗: {hook.failureCount}
                </div>
                <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                  <Button size="sm" disabled={busy === `hook-test:${hook.id}`} onClick={() => void testWebhook(hook)}>
                    テスト送信
                  </Button>
                  <Button size="sm" disabled={busy === `hook-toggle:${hook.id}`} onClick={() => void toggleWebhook(hook)}>
                    {hook.active ? "停止" : "再開"}
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy === `hook-del:${hook.id}`} onClick={() => void deleteWebhook(hook)}>
                    削除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="oc-empty">この板の Webhook はまだありません。</div>
        )}
        <div className="oc-stack" style={{ marginTop: 8 }}>
          <label className="oc-field">
            <span className="oc-label">配信先 URL（https のみ）</span>
            <input className="oc-input" value={hookUrl} onChange={(event) => setHookUrl(event.target.value)} placeholder="https://example.com/hooks/openclone" />
          </label>
          <div className="oc-row" style={{ flexWrap: "wrap" }}>
            {WEBHOOK_EVENT_TYPES.filter((event) => event !== "webhook.test").map((event) => {
              const checked = hookEvents.includes(event);
              return (
                <label key={event} className="oc-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setHookEvents((prev) => (checked ? prev.filter((item) => item !== event) : [...prev, event]))
                    }
                  />
                  <span className="oc-small">{event}</span>
                </label>
              );
            })}
          </div>
          <div className="oc-row">
            <Button
              variant="primary"
              size="sm"
              disabled={busy === "hook-create" || !hookUrl.trim() || hookEvents.length === 0}
              onClick={() => void createWebhook()}
            >
              Webhook を登録
            </Button>
          </div>
        </div>
      </section>

      <div className="oc-small oc-muted">
        接続手順・MCP ツール一覧・injection 対策のシステムプロンプトは <code>packages/mcp/prompts/</code> にあります。
        高リスク操作の承認・監査ログ・サイト全体の停止はサイト管理者の <a href="/admin/ai">AI 管理ダッシュボード</a> から行います。
      </div>
    </div>
  );
}

export default AiBoardPanel;