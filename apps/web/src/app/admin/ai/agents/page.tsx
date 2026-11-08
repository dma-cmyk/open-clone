"use client";

// AI 管理者の登録・API キー・権限/レート/担当板・停止（/admin/ai/agents）。
// サイト管理者（owner/special_admin）は全 agent を、板管理人は自板分を /admin/ai ではなく板管理画面から操作する。

import { useCallback, useEffect, useState } from "react";
import type { AiAgent, AiAgentWithKey, BoardSummary, RiskCap } from "shared";
import { Notice, Spinner } from "../../../../components/ui";
import { aiFetch, errorMessage, formatTime, PageTitle, RiskBadge } from "../_components";

interface AgentDraft {
  riskCap: RiskCap;
  rateLimitPerMin: number;
  dailyLimit: number;
  displayName: string;
}

const RISK_CAP_HELP: Record<RiskCap, string> = {
  low: "medium も自動実行せず承認待ち（最も安全）",
  medium: "投稿・非表示・通報処理を自動実行",
  high: "削除等の high も承認キュー経由で実行可能",
};

export default function AiAgentsPage() {
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string; warning: string } | null>(null);

  // 作成フォーム
  const [ownerType, setOwnerType] = useState<"site" | "board" | "account">("board");
  const [boardId, setBoardId] = useState<number | "">("");
  const [allowedBoardsText, setAllowedBoardsText] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("AI運営");
  const [description, setDescription] = useState("");
  const [riskCap, setRiskCap] = useState<RiskCap>("medium");
  const [rateLimit, setRateLimit] = useState(30);
  const [dailyLimit, setDailyLimit] = useState(2000);

  // 個別操作
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const [agentList, boardList] = await Promise.all([
        aiFetch<{ items: AiAgent[] }>("GET", "/ai/agents"),
        aiFetch<{ items: BoardSummary[] }>("GET", "/boards?limit=100").catch(() => ({ items: [] })),
      ]);
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

  const parseAllowedBoards = (): number[] | "*" => {
    const raw = allowedBoardsText.trim();
    if (raw === "*") return "*";
    if (!raw) return boardId === "" ? [] : [Number(boardId)];
    return raw
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
  };

  const createAgent = async () => {
    await run("create", async () => {
      const created = await aiFetch<AiAgentWithKey>("POST", "/ai/agents", {
        name: name.trim(),
        description: description.trim() || undefined,
        ownerType,
        ...(ownerType === "board" ? { boardId: Number(boardId) } : {}),
        allowedBoards: parseAllowedBoards(),
        riskCap,
        rateLimitPerMin: rateLimit,
        dailyLimit,
        displayName: displayName.trim() || "AI運営",
      });
      setSecret({ title: `API キー（${created.name}）`, value: created.apiKey, warning: created.keyWarning });
      setName("");
      setDescription("");
      setNotice("AI 管理者を登録しました。キーは再表示できません。");
      await load();
    });
  };

  const rotateKey = async (agent: AiAgent) => {
    if (!window.confirm(`${agent.name} の API キーを再発行します。旧キーは即時無効になります。`)) return;
    await run(`rotate:${agent.id}`, async () => {
      const rotated = await aiFetch<AiAgentWithKey>("POST", `/ai/agents/${agent.id}/rotate-key`);
      setSecret({ title: `新しい API キー（${agent.name}）`, value: rotated.apiKey, warning: rotated.keyWarning });
      await load();
    });
  };

  const suspendAgent = async (agent: AiAgent) => {
    const reason = (reasons[agent.id] ?? "").trim() || "管理者による停止";
    await run(`suspend:${agent.id}`, async () => {
      await aiFetch("POST", `/ai/agents/${agent.id}/suspend`, { reason });
      setNotice(`${agent.name} を停止しました。`);
      await load();
    });
  };

  const resumeAgent = async (agent: AiAgent) => {
    await run(`resume:${agent.id}`, async () => {
      await aiFetch("POST", `/ai/agents/${agent.id}/resume`);
      setNotice(`${agent.name} を再開しました。`);
      await load();
    });
  };

  const revokeAgent = async (agent: AiAgent) => {
    if (!window.confirm(`${agent.name} を失効（削除）します。よろしいですか？`)) return;
    await run(`revoke:${agent.id}`, async () => {
      await aiFetch("DELETE", `/ai/agents/${agent.id}`);
      setNotice(`${agent.name} を失効しました。`);
      await load();
    });
  };

  const saveAgent = async (agent: AiAgent) => {
    const draft = drafts[agent.id];
    if (!draft) return;
    await run(`save:${agent.id}`, async () => {
      await aiFetch("PATCH", `/ai/agents/${agent.id}`, draft);
      setNotice(`${agent.name} の設定を更新しました。`);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[agent.id];
        return next;
      });
      await load();
    });
  };

  if (!agents && !error) return <Spinner label="AI 管理者を取得中…" />;

  return (
    <div className="oc-stack">
      <PageTitle>AI 管理者</PageTitle>
      {error ? <Notice kind="error" onRetry={() => void load()}>{error}</Notice> : null}
      {notice ? <Notice kind="ok">{notice}</Notice> : null}
      {secret ? (
        <div className="oc-warn-box">
          <div className="oc-row-between">
            <strong>{secret.title}</strong>
            <button
              type="button"
              className="oc-btn oc-btn-sm"
              onClick={() => {
                navigator.clipboard?.writeText(secret.value).catch(() => undefined);
                setNotice("クリップボードにコピーしました。");
              }}
            >
              コピー
            </button>
          </div>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "6px 0" }}>{secret.value}</pre>
          <div className="oc-small">{secret.warning}</div>
          <button type="button" className="oc-btn oc-btn-sm" style={{ marginTop: 6 }} onClick={() => setSecret(null)}>
            保存したので閉じる
          </button>
        </div>
      ) : null}

      <section className="oc-card">
        <strong>新規登録</strong>
        <div className="oc-grid-2" style={{ marginTop: 8 }}>
          <label className="oc-field">
            <span className="oc-label">所有</span>
            <select
              className="oc-select"
              value={ownerType}
              onChange={(event) => setOwnerType(event.target.value as "site" | "board" | "account")}
            >
              <option value="board">板（board admin / サイト管理者）</option>
              <option value="account">アカウント（個人・最大 medium）</option>
              <option value="site">サイト（owner/special_admin のみ）</option>
            </select>
          </label>
          {ownerType === "board" ? (
            <label className="oc-field">
              <span className="oc-label">板</span>
              <select className="oc-select" value={boardId} onChange={(event) => setBoardId(Number(event.target.value))}>
                <option value="">選択してください</option>
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    #{board.id} {board.name} (/{board.slug})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="oc-field">
            <span className="oc-label">管理名（識別用）</span>
            <input className="oc-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} />
          </label>
          <label className="oc-field">
            <span className="oc-label">投稿名義</span>
            <input className="oc-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={50} />
          </label>
          <label className="oc-field">
            <span className="oc-label">担当板（カンマ区切り ID / 全板は *）</span>
            <input
              className="oc-input"
              value={allowedBoardsText}
              onChange={(event) => setAllowedBoardsText(event.target.value)}
              placeholder={boardId === "" ? "未指定なら上の板、* はサイト管理者のみ" : `未指定なら ${boardId}`}
            />
          </label>
          <label className="oc-field">
            <span className="oc-label">権限上限 (risk_cap)</span>
            <select className="oc-select" value={riskCap} onChange={(event) => setRiskCap(event.target.value as RiskCap)}>
              {(["low", "medium", "high"] as RiskCap[]).map((cap) => (
                <option key={cap} value={cap}>
                  {cap} — {RISK_CAP_HELP[cap]}
                </option>
              ))}
            </select>
          </label>
          <label className="oc-field">
            <span className="oc-label">回/分</span>
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
            <span className="oc-label">回/日</span>
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
          <button
            type="button"
            className="oc-btn oc-btn-primary"
            disabled={busy === "create" || !name.trim() || (ownerType === "board" && boardId === "")}
            onClick={() => void createAgent()}
          >
            登録して API キーを発行
          </button>
          <span className="oc-small oc-muted">high は常に人間の承認が必要です。AI から権限は変更できません。</span>
        </div>
      </section>

      <section className="oc-card">
        <div className="oc-row-between">
          <strong>登録済み（{agents?.length ?? 0}）</strong>
          <button type="button" className="oc-btn oc-btn-sm" onClick={() => void load()}>
            再読込
          </button>
        </div>
        {!agents || agents.length === 0 ? (
          <div className="oc-empty">AI 管理者がいません。</div>
        ) : (
          <div className="oc-stack" style={{ marginTop: 8 }}>
            {agents.map((agent) => {
              const draft = drafts[agent.id] ?? null;
              return (
                <div key={agent.id} className="oc-surface" style={{ padding: 8 }}>
                  <div className="oc-row-between">
                    <div>
                      <strong>{agent.name}</strong> <span className="oc-tiny oc-muted">id: {agent.id}</span>
                    </div>
                    <div className="oc-row" style={{ gap: 4 }}>
                      <span className="oc-badge oc-badge-gray">{agent.ownerType}</span>
                      <RiskBadge risk={agent.riskCap} />
                      <span
                        className={
                          agent.status === "active"
                            ? "oc-badge oc-badge-green"
                            : agent.status === "suspended"
                              ? "oc-badge oc-badge-red"
                              : "oc-badge oc-badge-gray"
                        }
                      >
                        {agent.status}
                      </span>
                    </div>
                  </div>
                  <div className="oc-small oc-muted">
                    名義 {agent.displayName} / 担当 {agent.allowedBoards === "*" ? "全板" : agent.allowedBoards.join(", ") || "-"} /
                    キー {agent.keyPrefix}… / {agent.rateLimitPerMin}回/分・{agent.dailyLimit}回/日 / 最終使用{" "}
                    {formatTime(agent.lastUsedAt)}
                  </div>
                  {agent.description ? <div className="oc-small">{agent.description}</div> : null}
                  {agent.suspendedReason ? <div className="oc-small">停止理由: {agent.suspendedReason}</div> : null}

                  <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                    <button type="button" className="oc-btn oc-btn-sm" onClick={() => void rotateKey(agent)}>
                      キー再発行
                    </button>
                    {agent.status === "active" ? (
                      <>
                        <input
                          className="oc-input oc-input-sm"
                          style={{ maxWidth: 200 }}
                          placeholder="停止理由"
                          value={reasons[agent.id] ?? ""}
                          onChange={(event) => setReasons((prev) => ({ ...prev, [agent.id]: event.target.value }))}
                          maxLength={500}
                        />
                        <button type="button" className="oc-btn oc-btn-sm oc-btn-danger" onClick={() => void suspendAgent(agent)}>
                          停止
                        </button>
                      </>
                    ) : agent.status === "suspended" ? (
                      <button type="button" className="oc-btn oc-btn-sm" onClick={() => void resumeAgent(agent)}>
                        再開
                      </button>
                    ) : null}
                    <button type="button" className="oc-btn oc-btn-sm oc-btn-danger" onClick={() => void revokeAgent(agent)}>
                      失効
                    </button>
                    <button
                      type="button"
                      className="oc-btn oc-btn-sm"
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
                      編集
                    </button>
                  </div>

                  {draft ? (
                    <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                      <label className="oc-field">
                        <span className="oc-label">risk_cap</span>
                        <select
                          className="oc-select"
                          value={draft.riskCap}
                          onChange={(event) =>
                            setDrafts((prev) => ({ ...prev, [agent.id]: { ...draft, riskCap: event.target.value as RiskCap } }))
                          }
                        >
                          {(["low", "medium", "high"] as RiskCap[]).map((cap) => (
                            <option key={cap} value={cap}>
                              {cap}
                            </option>
                          ))}
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
                            setDrafts((prev) => ({ ...prev, [agent.id]: { ...draft, rateLimitPerMin: Number(event.target.value) } }))
                          }
                        />
                      </label>
                      <label className="oc-field">
                        <span className="oc-label">回/日</span>
                        <input
                          className="oc-input"
                          style={{ maxWidth: 110 }}
                          type="number"
                          min={1}
                          max={100000}
                          value={draft.dailyLimit}
                          onChange={(event) =>
                            setDrafts((prev) => ({ ...prev, [agent.id]: { ...draft, dailyLimit: Number(event.target.value) } }))
                          }
                        />
                      </label>
                      <label className="oc-field">
                        <span className="oc-label">投稿名義</span>
                        <input
                          className="oc-input"
                          style={{ maxWidth: 160 }}
                          value={draft.displayName}
                          maxLength={50}
                          onChange={(event) =>
                            setDrafts((prev) => ({ ...prev, [agent.id]: { ...draft, displayName: event.target.value } }))
                          }
                        />
                      </label>
                      <button type="button" className="oc-btn oc-btn-sm oc-btn-primary" onClick={() => void saveAgent(agent)}>
                        保存
                      </button>
                      <button
                        type="button"
                        className="oc-btn oc-btn-sm"
                        onClick={() =>
                          setDrafts((prev) => {
                            const next = { ...prev };
                            delete next[agent.id];
                            return next;
                          })
                        }
                      >
                        取消
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}