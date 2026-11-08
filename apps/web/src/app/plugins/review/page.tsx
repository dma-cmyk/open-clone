"use client";

// プラグイン審査キュー（owner / 特別管理人向け）

import { useCallback, useEffect, useState } from "react";
import type { PluginReviewInfo } from "shared";
import { pluginApi } from "@/features/plugin-host";
import { Badge, Card, Field, Notice, PluginShell, errorText, formatTime, ui } from "../_shared";

const RISK_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

export default function PluginReviewPage() {
  const [items, setItems] = useState<PluginReviewInfo[]>([]);
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await pluginApi.reviews({ status, scope: "site", limit: 100 });
      setItems(response.items);
    } catch (caught) {
      setError(errorText(caught));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: PluginReviewInfo, decision: "approve" | "reject"): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await pluginApi.decideReview(item.pluginId, {
        decision,
        note: notes[item.id] || undefined,
        scope: "site",
      });
      setNotice(
        `${item.pluginName} v${item.version} を${decision === "approve" ? "承認" : "却下"}しました`,
      );
      await load();
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <PluginShell
      title="プラグイン審査キュー"
      description="サイト全体（site スコープ）への公開申請を審査します。静的検査の結果とリスクレベルを確認してください。"
      actions={
        <a href="/plugins/" className="oc-btn">
          レジストリへ
        </a>
      }
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}

      <Card>
        <div className="oc-row">
          {(["pending", "approved", "rejected"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              className={status === value ? "oc-btn oc-btn-primary" : "oc-btn"}
            >
              {value === "pending" ? "未審査" : value === "approved" ? "承認済み" : "却下済み"}
            </button>
          ))}
          <button type="button" className="oc-btn" onClick={() => void load()}>
            再読み込み
          </button>
        </div>
      </Card>

      {loading ? <p className="oc-muted oc-small">読み込み中…</p> : null}
      {!loading && items.length === 0 ? <Notice tone="warn">該当する審査はありません。</Notice> : null}

      {items.map((item) => (
        <Card
          key={item.id}
          title={
            <span>
              {item.pluginName} <span className="oc-muted oc-small">v{item.version}</span>
            </span>
          }
          actions={
            <>
              <Badge tone={item.status === "pending" ? "warn" : item.status === "approved" ? "ok" : "danger"}>
                {item.status === "pending" ? "未審査" : item.status === "approved" ? "承認済み" : "却下済み"}
              </Badge>
              <Badge>リスク: {RISK_LABEL[item.riskLevel ?? "low"]}</Badge>
            </>
          }
        >
          <div className="oc-muted oc-small">
            申請 {formatTime(item.createdAt)}
            {item.decidedAt ? ` / 判定 ${formatTime(item.decidedAt)}` : ""}
            {item.reviewerType ? ` / 判定者: ${item.reviewerType}` : ""}
          </div>
          {item.staticResult ? (
            <div style={{ marginTop: 6 }}>
              <div className="oc-row">
                {item.staticResult.allowed ? (
                  <Badge tone="ok">静的検査: 通過</Badge>
                ) : (
                  <Badge tone="danger">静的検査: 不通過</Badge>
                )}
                <Badge>スコア {item.staticResult.riskScore ?? 0}</Badge>
              </div>
              <ul style={{ margin: "4px 0", paddingLeft: 18, fontSize: 12 }}>
                {item.staticResult.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div style={{ ...ui.row, alignItems: "flex-end", marginTop: 8 }}>
            <div style={{ flex: 1 }}>
              <Field label="審査メモ">
                <input
                  className="oc-input"
                  value={notes[item.id] ?? ""}
                  onChange={(event) => setNotes((prev) => ({ ...prev, [item.id]: event.target.value }))}
                />
              </Field>
            </div>
            <a
              href={`/plugins/view/?id=${encodeURIComponent(item.pluginId)}`}
              className="oc-btn"
            >
              詳細
            </a>
            {item.status === "pending" ? (
              <>
                <button type="button" className="oc-btn oc-btn-primary" onClick={() => void decide(item, "approve")}>
                  承認
                </button>
                <button type="button" className="oc-btn oc-btn-danger" onClick={() => void decide(item, "reject")}>
                  却下
                </button>
              </>
            ) : null}
          </div>
        </Card>
      ))}
    </PluginShell>
  );
}