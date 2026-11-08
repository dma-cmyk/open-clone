"use client";

// 全体通報処理 UI（`/admin/reports`）。管理レイアウトは WP6 の admin/layout.tsx。
// API: WP1 `GET /v1/reports` / `GET /v1/reports/:id` / `POST /v1/reports/:id/handle`。
import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Notice, Spinner, useToast } from "@/components/ui";
import { REPORT_REASON_LABELS, type Report, type ReportStatus } from "shared";
import { threadPath } from "@/features/board-ui/format";
import { formatDate } from "@/features/board-ui/format";
import { Wp1ApiError, queryString, wp1Request } from "../../_wp1/api";

type ReportAction = "reject" | "resolve" | "hide" | "delete";

const ACTION_LABELS: Record<ReportAction, string> = {
  reject: "却下",
  resolve: "対応済み",
  hide: "非表示",
  delete: "削除",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "未処理",
  resolved: "対応済み",
  rejected: "却下",
  accepted: "受理",
};

interface ReportDetail {
  report: Report;
  posts: Array<{ id: number; num: number; name: string; body: string; hidden: number; deleted: number }>;
  reasonLabel: string;
}

interface ListResponse {
  items: Report[];
  nextCursor: string | null;
}

export default function AdminReportsPage() {
  const toast = useToast();
  const [status, setStatus] = useState("pending");
  const [board, setBoard] = useState("");
  const [items, setItems] = useState<Report[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await wp1Request<ListResponse>(
          `/reports${queryString({
            status: status || undefined,
            board: board.trim() || undefined,
            cursor: nextCursor,
            limit: 50,
          })}`,
        );
        setItems((current) => (nextCursor ? [...current, ...data.items] : data.items));
        setCursor(data.nextCursor);
      } catch (cause) {
        setError(cause instanceof Wp1ApiError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : "通報の取得に失敗しました");
      } finally {
        setLoading(false);
      }
    },
    [status, board],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (report: Report) => {
    setDetailLoading(true);
    setNote("");
    try {
      const detail = await wp1Request<ReportDetail>(`/reports/${encodeURIComponent(report.id)}`);
      setSelected(detail);
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : "通報詳細の取得に失敗しました");
    } finally {
      setDetailLoading(false);
    }
  };

  const handle = async (report: Report, action: ReportAction) => {
    setBusy(report.id);
    try {
      await wp1Request(`/reports/${encodeURIComponent(report.id)}/handle`, {
        method: "POST",
        body: JSON.stringify({ action, note }),
      });
      toast.show(`${ACTION_LABELS[action]}しました`);
      setSelected(null);
      await load();
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : "処理に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="oc-stack">
      <div className="oc-row-between">
        <h1 style={{ fontSize: 18, margin: 0 }}>通報処理</h1>
        <span className="oc-row">
          <select className="oc-select" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="状態">
            <option value="pending">未処理</option>
            <option value="resolved">対応済み</option>
            <option value="rejected">却下</option>
            <option value="accepted">受理</option>
            <option value="">すべて</option>
          </select>
          <input
            className="oc-input"
            style={{ width: 150 }}
            value={board}
            placeholder="板 slug（任意）"
            aria-label="板 slug"
            onChange={(event) => setBoard(event.target.value)}
          />
          <Button size="sm" onClick={() => void load()}>
            更新
          </Button>
        </span>
      </div>

      {loading && items.length === 0 ? <Spinner label="通報を読み込み中…" /> : null}
      {error ? <Notice kind="error" onRetry={() => void load()}>{error}</Notice> : null}
      {!loading && !error && items.length === 0 ? <div className="oc-empty">該当する通報はありません。</div> : null}

      {items.map((report) => (
        <div key={report.id} className="oc-surface">
          <div className="oc-row-between">
            <span className="oc-row">
              <span className={`oc-badge ${report.status === "pending" ? "oc-badge-yellow" : "oc-badge-gray"}`}>
                {STATUS_LABELS[report.status] ?? report.status}
              </span>
              <span className="oc-badge oc-badge-red">{REPORT_REASON_LABELS[report.reason]}</span>
              <a
                className="oc-thread-title"
                href={threadPath(report.boardSlug, report.threadId)}
                target="_blank"
                rel="noreferrer"
              >
                {report.threadTitle}
              </a>
            </span>
            <span className="oc-muted oc-tiny">{formatDate(report.createdAt)}</span>
          </div>
          <div className="oc-small oc-mt">
            板: {report.boardSlug} / 対象レス: {report.nums || "all"}
            {report.comment ? <div className="oc-mt" style={{ whiteSpace: "pre-wrap" }}>{report.comment}</div> : null}
          </div>
          <div className="oc-row oc-mt">
            <Button size="sm" onClick={() => void openDetail(report)}>
              詳細・処理
            </Button>
            {report.status === "pending" ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy === report.id}
                  onClick={() => void handle(report, "resolve")}
                >
                  対応済み
                </Button>
                <Button size="sm" disabled={busy === report.id} onClick={() => void handle(report, "reject")}>
                  却下
                </Button>
              </>
            ) : (
              <span className="oc-muted oc-small">
                {STATUS_LABELS[report.status] ?? report.status}
                {report.note ? `: ${report.note}` : ""}
              </span>
            )}
          </div>
        </div>
      ))}

      {cursor ? (
        <div className="oc-row" style={{ justifyContent: "center" }}>
          <Button size="sm" onClick={() => void load(cursor)} disabled={loading}>
            さらに読み込む
          </Button>
        </div>
      ) : null}

      <Modal
        open={selected !== null || detailLoading}
        title={selected ? `通報 ${selected.report.id}` : "通報詳細を読み込み中…"}
        onClose={() => setSelected(null)}
        width={760}
        footer={
          selected && selected.report.status === "pending" ? (
            <>
              {(
                [
                  ["resolve", "対応済み", "primary"],
                  ["reject", "却下", "normal"],
                  ["hide", "対象レスを非表示", "normal"],
                  ["delete", "対象レスを削除", "danger"],
                ] as Array<[ReportAction, string, "primary" | "normal" | "danger"]>
              ).map(([action, label, variant]) => (
                <Button
                  key={action}
                  variant={variant}
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => selected && void handle(selected.report, action)}
                >
                  {label}
                </Button>
              ))}
            </>
          ) : (
            <Button size="sm" onClick={() => setSelected(null)}>
              閉じる
            </Button>
          )
        }
      >
        {detailLoading && !selected ? <Spinner /> : null}
        {selected ? (
          <div className="oc-stack">
            <div className="oc-small">
              <strong>{selected.reasonLabel}</strong> / 状態: {STATUS_LABELS[selected.report.status] ?? selected.report.status} /
              通報者コメント: {selected.report.comment || "（なし）"}
            </div>
            {selected.report.status === "pending" ? (
              <label className="oc-small">
                処理メモ（任意）
                <textarea
                  className="oc-textarea"
                  value={note}
                  maxLength={1000}
                  rows={2}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
            ) : null}
            {selected.posts.length === 0 ? <div className="oc-empty">対象レスの本文がありません（削除済み）。</div> : null}
            {selected.posts.map((post) => (
              <div key={post.id} className="oc-surface">
                <div className="oc-post-header">
                  <span className="oc-post-num">{post.num}</span>{" "}
                  <span className="oc-post-name">{post.name}</span>
                  {post.hidden ? <span className="oc-badge oc-badge-gray" style={{ marginLeft: 6 }}>非表示</span> : null}
                  {post.deleted ? <span className="oc-badge oc-badge-red" style={{ marginLeft: 6 }}>削除</span> : null}
                </div>
                <div className="oc-post-main" style={{ whiteSpace: "pre-wrap" }}>{post.body}</div>
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

void (null as unknown as ReportStatus);