"use client";

// 管理画面「通報」のプラグインタブ。
// API: GET /v1/admin/plugin-reports（サイト管理者のみ）。未対応の通報があるプラグインを新しい順に出す。
// 通報の中身と対応はプラグイン詳細（/plugins/view/?id=...）で行う。
import { useCallback, useEffect, useState } from "react";
import { Button, Notice, Spinner } from "@/components/ui";
import { PLUGIN_REPORT_REASON_LABELS, type PluginReportGroup, type PluginReportReason } from "shared";
import { pluginApi } from "@/features/plugin-host";
import { formatDate } from "@/features/board-ui/format";

const REASONS = Object.keys(PLUGIN_REPORT_REASON_LABELS) as PluginReportReason[];

function ownerLabel(group: PluginReportGroup): string {
  if (group.ownerName) return group.ownerName;
  if (group.ownership === "device") return "ログインなしの作成";
  return "運営（公式）";
}

function detailHref(pluginId: string): string {
  return `/plugins/view/?id=${encodeURIComponent(pluginId)}`;
}

export function PluginReportsPanel() {
  const [includeResolved, setIncludeResolved] = useState(false);
  const [items, setItems] = useState<PluginReportGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await pluginApi.pluginReports(includeResolved);
      setItems(data.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "通報の取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, [includeResolved]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalOpen = items.reduce((sum, item) => sum + item.openCount, 0);

  return (
    <div className="oc-stack">
      <div className="oc-row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="oc-row" style={{ gap: 6, alignItems: "center" }}>
          <span className="oc-badge oc-badge-red">未対応 {totalOpen} 件</span>
          <span className="oc-muted oc-small">プラグイン {items.length} 件</span>
        </span>
        <span className="oc-row" style={{ gap: 8, alignItems: "center" }}>
          <label className="oc-small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={(event) => setIncludeResolved(event.target.checked)}
            />
            対応済みも表示
          </label>
          <Button size="sm" onClick={() => void load()}>
            更新
          </Button>
        </span>
      </div>

      {loading && items.length === 0 ? <Spinner label="プラグインの通報を読み込み中…" /> : null}
      {error ? (
        <Notice kind="error" onRetry={() => void load()}>
          {error}
        </Notice>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <div className="oc-empty">未対応のプラグイン通報はありません。</div>
      ) : null}

      {items.map((group) => {
        const openReasons = REASONS.filter((reason) => (group.byReason[reason] ?? 0) > 0);
        return (
          <div key={group.pluginId} className="oc-surface">
            <div className="oc-row-between">
              <span className="oc-row" style={{ flexWrap: "wrap" }}>
                <a className="oc-thread-title" href={detailHref(group.pluginId)}>
                  {group.name}
                </a>
                {group.openCount > 0 ? (
                  <span className="oc-badge oc-badge-red">未対応 {group.openCount}</span>
                ) : (
                  <span className="oc-badge oc-badge-gray">未対応なし</span>
                )}
                {group.flagged ? <span className="oc-badge oc-badge-yellow">要確認</span> : null}
              </span>
              <span className="oc-muted oc-tiny">最新の通報 {formatDate(group.latestReportAt)}</span>
            </div>
            <div className="oc-small oc-mt">
              作者: {ownerLabel(group)} / 通報の累計 {group.totalCount} 件 / v{group.latestVersion ?? "-"}
            </div>
            <div className="oc-row oc-mt" style={{ flexWrap: "wrap" }}>
              {openReasons.length > 0 ? (
                openReasons.map((reason) => (
                  <span key={reason} className="oc-badge oc-badge-gray">
                    {PLUGIN_REPORT_REASON_LABELS[reason]} {group.byReason[reason]}
                  </span>
                ))
              ) : (
                <span className="oc-muted oc-small">未対応の通報はありません（対応済み・却下のみ）</span>
              )}
            </div>
            <div className="oc-row oc-mt">
              <a className="oc-btn oc-btn-sm" href={detailHref(group.pluginId)}>
                通報の中身を見る
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}