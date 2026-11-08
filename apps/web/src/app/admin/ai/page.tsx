"use client";

// AI 運営ダッシュボード（/admin/ai）。
// 稼働状況・緊急停止・直近メトリクス・接続 AI・サイト Webhook を一画面にまとめる。
// 承認キュー / 監査ログ / agent 管理 / 停止操作は子ページに分ける。

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AiAgent, AiStatus, Webhook, WebhookEventType, WebhookWithSecret } from "shared";
import { WEBHOOK_EVENT_TYPES } from "shared";
import { Notice, Spinner } from "../../../components/ui";
import { aiFetch, errorMessage, formatTime, PageTitle, RiskBadge, StatCard } from "./_components";

interface MetricRow {
  agentId: string | null;
  kind: string;
  value: number;
  threshold: number | null;
  windowStart: number;
}

export default function AiDashboardPage() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [agents, setAgents] = useState<AiAgent[] | null>(null);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState("異常検知のため全 AI を停止");
  const [secret, setSecret] = useState<{ value: string; warning: string } | null>(null);

  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState<WebhookEventType[]>(["queue.pending", "anomaly.detected", "agent.suspended"]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextStatus, agentList, metricList, hookList] = await Promise.all([
        aiFetch<AiStatus>("GET", "/ai/status"),
        aiFetch<{ items: AiAgent[] }>("GET", "/ai/agents"),
        aiFetch<{ items: MetricRow[] }>("GET", "/ai/metrics").catch(() => ({ items: [] })),
        aiFetch<{ items: Webhook[] }>("GET", "/ai/webhooks"),
      ]);
      setStatus(nextStatus);
      setAgents(agentList.items);
      setMetrics(metricList.items);
      setWebhooks(hookList.items);
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

  const stopAll = async () => {
    if (!window.confirm("全 AI の操作を即時停止します。よろしいですか？")) return;
    await run("stop", async () => {
      await aiFetch("POST", "/ai/stop", { scope: "global", reason: stopReason.trim() || "管理者による停止" });
      setNotice("全 AI を停止しました。");
      await load();
    });
  };

  const resumeAll = async () => {
    await run("resume", async () => {
      await aiFetch("POST", "/ai/resume", { scope: "global" });
      setNotice("全 AI の停止を解除しました。");
      await load();
    });
  };

  const createWebhook = async () => {
    await run("hook-create", async () => {
      const created = await aiFetch<WebhookWithSecret>("POST", "/ai/webhooks", {
        ownerType: "site",
        ownerId: "site",
        url: hookUrl.trim(),
        events: hookEvents,
      });
      setSecret({ value: created.secret, warning: created.secretWarning });
      setHookUrl("");
      setNotice("サイト Webhook を登録しました。");
      await load();
    });
  };

  const toggleWebhook = async (hook: Webhook) => {
    await run(`hook-toggle:${hook.id}`, async () => {
      await aiFetch("PATCH", `/ai/webhooks/${hook.id}`, { active: !hook.active });
      await load();
    });
  };

  const deleteWebhook = async (hook: Webhook) => {
    if (!window.confirm("この Webhook を削除します。よろしいですか？")) return;
    await run(`hook-del:${hook.id}`, async () => {
      await aiFetch("DELETE", `/ai/webhooks/${hook.id}`);
      await load();
    });
  };

  const testWebhook = async (hook: Webhook) => {
    await run(`hook-test:${hook.id}`, async () => {
      await aiFetch("POST", `/ai/webhooks/${hook.id}/test`);
      setNotice("テストイベントを送信しました（配信履歴は deliveries で確認できます）。");
    });
  };

  if (!status && !error) return <Spinner label="AI 運営状況を取得中…" />;

  return (
    <div className="oc-stack">
      <PageTitle>AI 運営</PageTitle>
      {error ? <Notice kind="error" onRetry={() => void load()}>{error}</Notice> : null}
      {notice ? <Notice kind="ok">{notice}</Notice> : null}

      {status ? (
        <div className={status.stop.globalStopped ? "oc-error" : "oc-ok"}>
          <div className="oc-row-between">
            <strong>{status.stop.globalStopped ? "全 AI は緊急停止中です" : "AI 運営は稼働しています"}</strong>
            <span className="oc-small">
              {status.stop.globalStopped
                ? `${status.stop.reason ?? "理由未記録"} / ${formatTime(status.stop.stoppedAt)}`
                : `停止中の板: ${status.stop.boards.length}`}
            </span>
          </div>
          <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            {status.stop.globalStopped ? (
              <button
                type="button"
                className="oc-btn oc-btn-primary oc-btn-sm"
                disabled={busy === "resume"}
                onClick={() => void resumeAll()}
              >
                停止を解除（監査に記録）
              </button>
            ) : (
              <>
                <input
                  className="oc-input"
                  style={{ maxWidth: 360 }}
                  value={stopReason}
                  onChange={(event) => setStopReason(event.target.value)}
                  maxLength={500}
                  placeholder="停止理由"
                />
                <button
                  type="button"
                  className="oc-btn oc-btn-danger oc-btn-sm"
                  disabled={busy === "stop"}
                  onClick={() => void stopAll()}
                >
                  全 AI を緊急停止
                </button>
              </>
            )}
            <Link className="oc-btn oc-btn-sm" href="/admin/ai/queue">
              承認キュー（{status.counts.pendingQueue}）
            </Link>
            <Link className="oc-btn oc-btn-sm" href="/admin/ai/stop">
              停止操作
            </Link>
          </div>
        </div>
      ) : null}

      {status ? (
        <div className="oc-grid-2">
          <StatCard label="AI 管理者" value={`${status.counts.activeAgents} / ${status.counts.agents}`} note="稼働 / 全体" />
          <StatCard label="停止中" value={status.counts.suspendedAgents} />
          <StatCard label="承認待ち" value={status.counts.pendingQueue} />
          <StatCard label="本日の実行" value={status.counts.executedToday} />
          <StatCard label="本日の拒否" value={status.counts.deniedToday} />
        </div>
      ) : null}

      <div className="oc-card">
        <div className="oc-row-between">
          <strong>接続中の AI 管理者</strong>
          <Link className="oc-btn oc-btn-sm" href="/admin/ai/agents">
            管理
          </Link>
        </div>
        {!agents || agents.length === 0 ? (
          <div className="oc-empty">まだ AI 管理者がいません。</div>
        ) : (
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  {["名前", "所有", "担当板", "権限上限", "状態", "上限", "最終使用"].map((head) => (
                    <th key={head} style={{ textAlign: "left", borderBottom: "1px solid #bbb", padding: 4 }}>
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{agent.name}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{agent.ownerType}</td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
                      {agent.allowedBoards === "*" ? "全板" : agent.allowedBoards.join(", ") || "-"}
                    </td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
                      <RiskBadge risk={agent.riskCap} />
                    </td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
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
                    </td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>
                      {agent.rateLimitPerMin}/分・{agent.dailyLimit}/日
                    </td>
                    <td style={{ padding: 4, borderBottom: "1px solid #e0e0e0" }}>{formatTime(agent.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="oc-grid-2">
        <div className="oc-card">
          <strong>停止中の板</strong>
          {!status || status.stop.boards.length === 0 ? (
            <div className="oc-empty">板単位の停止はありません。</div>
          ) : (
            <div className="oc-stack" style={{ marginTop: 8 }}>
              {status.stop.boards.map((board) => (
                <div key={board.boardId} className="oc-small">
                  板 #{board.boardId}: {board.reason} / {formatTime(board.stoppedAt)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="oc-card">
          <strong>直近の監視メトリクス</strong>
          {metrics.length === 0 ? (
            <div className="oc-empty">メトリクスはまだありません（cron が 10 分毎に収集します）。</div>
          ) : (
            <div style={{ maxHeight: 220, overflow: "auto", marginTop: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["kind", "値", "閾値", "agent", "時刻"].map((head) => (
                      <th key={head} style={{ textAlign: "left", borderBottom: "1px solid #bbb", padding: 3 }}>
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((metric, index) => (
                    <tr key={`${metric.kind}:${metric.windowStart}:${index}`}>
                      <td style={{ padding: 3, borderBottom: "1px solid #eee" }}>{metric.kind}</td>
                      <td style={{ padding: 3, borderBottom: "1px solid #eee" }}>{metric.value}</td>
                      <td style={{ padding: 3, borderBottom: "1px solid #eee" }}>{metric.threshold ?? "-"}</td>
                      <td style={{ padding: 3, borderBottom: "1px solid #eee" }}>{metric.agentId ?? "-"}</td>
                      <td style={{ padding: 3, borderBottom: "1px solid #eee" }}>{formatTime(metric.windowStart)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="oc-card">
        <strong>サイト Webhook（HMAC 署名・再送 3 回）</strong>
        <div className="oc-small oc-muted">
          `x-openclone-signature: t=…,v1=…` を検証してください。secret は作成時のみ表示します。
        </div>
        {secret ? (
          <div className="oc-warn-box" style={{ marginTop: 8 }}>
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>{secret.value}</pre>
            <div className="oc-small">{secret.warning}</div>
            <button type="button" className="oc-btn oc-btn-sm" style={{ marginTop: 6 }} onClick={() => setSecret(null)}>
              保存したので閉じる
            </button>
          </div>
        ) : null}
        {!webhooks || webhooks.length === 0 ? (
          <div className="oc-empty">サイト Webhook はまだありません。</div>
        ) : (
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
                  {hook.ownerType}/{hook.ownerId} / {hook.events.join(", ")} / 最終配信 {formatTime(hook.lastDeliveryAt)} /
                  失敗 {hook.failureCount}
                </div>
                <div className="oc-row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                  <button type="button" className="oc-btn oc-btn-sm" onClick={() => void testWebhook(hook)}>
                    テスト送信
                  </button>
                  <button type="button" className="oc-btn oc-btn-sm" onClick={() => void toggleWebhook(hook)}>
                    {hook.active ? "停止" : "再開"}
                  </button>
                  <button type="button" className="oc-btn oc-btn-sm oc-btn-danger" onClick={() => void deleteWebhook(hook)}>
                    削除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="oc-stack" style={{ marginTop: 8 }}>
          <input
            className="oc-input"
            value={hookUrl}
            onChange={(event) => setHookUrl(event.target.value)}
            placeholder="https://example.com/hooks/openclone"
          />
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
            <button
              type="button"
              className="oc-btn oc-btn-primary oc-btn-sm"
              disabled={busy === "hook-create" || !hookUrl.trim() || hookEvents.length === 0}
              onClick={() => void createWebhook()}
            >
              サイト Webhook を登録
            </button>
          </div>
        </div>
      </div>

      <p className="oc-note">
        接続方法・MCP ツール・injection 対策のプロンプトは `packages/mcp/prompts/` と docs/mcp.md を参照。
        板管理人は各板の管理画面「AI 管理者」タブから自板の AI を接続できます。
      </p>
    </div>
  );
}