"use client";

// 板管理: 通報一覧と処理（却下 / 対応済み / 非表示 / 削除）。板スタッフ向け。
// API: WP1 `GET /v1/reports` / `POST /v1/reports/:id/handle`。
import { useState } from "react";
import { api } from "@/features/board-ui/api";
import { formatRelative, threadPath } from "@/features/board-ui/format";
import { REASONS } from "@/features/board-ui/types";
import { useApiData, errorMessage } from "@/features/board-ui/use-api-data";
import { Button, Notice, Spinner, useToast } from "@/components/ui";
import { Link } from "../router";

type ReportAction = "reject" | "resolve" | "hide" | "delete";

const ACTION_LABELS: Record<ReportAction, string> = {
  reject: "却下",
  resolve: "対応済み",
  hide: "非表示",
  delete: "削除",
};

const ACTION_PROMPTS: Record<ReportAction, string> = {
  reject: "却下理由（任意）",
  resolve: "対応メモ（任意）",
  hide: "非表示の理由（任意）",
  delete: "削除の理由（任意）",
};

export function ManageReports({ slug }: { slug: string }) {
  const [status, setStatus] = useState("pending");
  const reports = useApiData(() => api.listReports({ board: slug, status }), [slug, status]);
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string | number, action: ReportAction) => {
    const note = window.prompt(ACTION_PROMPTS[action]) ?? undefined;
    setBusyId(String(id));
    setError(null);
    try {
      await api.handleReport(id, action, note);
      toast.show(`${ACTION_LABELS[action]}しました`);
      reports.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "処理に失敗しました");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="oc-row-between oc-mb">
        <span className="oc-label">通報一覧</span>
        <span className="oc-row">
          <select className="oc-select" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="pending">未処理</option>
            <option value="resolved">対応済み</option>
            <option value="rejected">却下</option>
            <option value="">すべて</option>
          </select>
          <Button size="sm" onClick={reports.reload}>
            更新
          </Button>
        </span>
      </div>
      {reports.loading && !reports.data ? <Spinner /> : null}
      {reports.error ? (
        <Notice kind="error" onRetry={reports.reload}>
          {errorMessage(reports.error)}
        </Notice>
      ) : null}
      {reports.data && reports.data.items.length === 0 ? <div className="oc-empty">通報はありません。</div> : null}
      {reports.data?.items.map((report) => (
        <div key={String(report.id)} className="oc-surface oc-mb">
          <div className="oc-row-between">
            <span>
              <span className="oc-badge oc-badge-yellow">
                {REASONS.find((item) => item.value === report.reason)?.label ?? report.reason ?? "不明"}
              </span>{" "}
              <Link href={threadPath(report.boardSlug ?? slug, report.threadId ?? 0)}>
                {report.threadTitle ?? `スレ ${report.threadId ?? "?"}`}
              </Link>
            </span>
            <span className="oc-muted oc-small">{formatRelative(report.createdAt)}</span>
          </div>
          <div className="oc-small oc-mt">
            対象レス: {report.nums || (report.postIds?.length ? report.postIds.join(",") : "all")}
            {report.status ? `（${report.status}）` : ""}
          </div>
          {report.comment ? (
            <div className="oc-small oc-mt" style={{ whiteSpace: "pre-wrap" }}>
              {report.comment}
            </div>
          ) : null}
          {report.status === "pending" ? (
            <div className="oc-row oc-mt">
              <Button size="sm" variant="primary" disabled={busyId === String(report.id)} onClick={() => void decide(report.id, "resolve")}>
                対応済み
              </Button>
              <Button size="sm" disabled={busyId === String(report.id)} onClick={() => void decide(report.id, "reject")}>
                却下
              </Button>
              <Button size="sm" disabled={busyId === String(report.id)} onClick={() => void decide(report.id, "hide")}>
                非表示
              </Button>
              <Button size="sm" variant="danger" disabled={busyId === String(report.id)} onClick={() => void decide(report.id, "delete")}>
                削除
              </Button>
            </div>
          ) : (
            <div className="oc-small oc-mt oc-muted">
              処理済み{report.note ? `: ${report.note}` : ""}
            </div>
          )}
        </div>
      ))}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}