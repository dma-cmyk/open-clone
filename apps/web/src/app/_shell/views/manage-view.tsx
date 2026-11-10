"use client";

// 板管理画面のシェル。ルール・デザイン・スタッフ・プラグイン・AI・通報。
import { useState } from "react";
import { api } from "@/features/board-ui/api";
import { boardPath } from "@/features/board-ui/format";
import { useApiData, errorMessage } from "@/features/board-ui/use-api-data";
import { PluginSlot } from "@/components/plugin-slot";
import { AiBoardPanel } from "@/components/ai-board-panel";
import { Notice, Spinner } from "@/components/ui";
import { Link, navigate } from "../router";
import { ManageBoardSettings } from "./manage-settings";
import { ManageStaff } from "./manage-staff";
import { ManageReports } from "./manage-reports";
import type { BoardDetail, StaffEntry } from "@/features/board-ui/types";

const TABS = [
  { value: "basic", label: "基本設定" },
  { value: "rules", label: "ルール" },
  { value: "design", label: "デザイン" },
  { value: "staff", label: "スタッフ" },
  { value: "plugins", label: "プラグイン" },
  { value: "ai", label: "AI 管理者" },
  { value: "reports", label: "通報" },
];

export function ManageView({ slug, tab }: { slug: string; tab: string }) {
  const info = useApiData(() => api.getBoard(slug), [slug]);
  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [staff, setStaff] = useState<StaffEntry[] | null>(null);

  const current = board ?? info.data?.board ?? null;
  const currentStaff = staff ?? info.data?.staff ?? [];
  const canManage = info.data?.canManage ?? false;
  const active = TABS.some((item) => item.value === tab) ? tab : "basic";

  if (info.loading && !info.data) {
    return <Spinner label="板情報を読み込み中…" />;
  }
  if (info.error) {
    return (
      <Notice kind="error" onRetry={info.reload}>
        {errorMessage(info.error)}
      </Notice>
    );
  }
  if (!current) {
    return <Notice kind="error">板が見つかりません。</Notice>;
  }

  return (
    <div>
      <div className="oc-panel">
        <div className="oc-panel-title">
          <span>{current.name} の板管理</span>
          <span className="oc-spacer" />
          <Link href={boardPath(slug)} className="oc-small">
            板に戻る
          </Link>
        </div>
        <div className="oc-panel-inner">
          {!canManage ? (
            <Notice kind="warn">
              この板の管理には板スタッフ（管理人/副管理人/モデレーター）権限が必要です。
              <a href="/account/login"> ログイン</a> してから再度お試しください。
            </Notice>
          ) : null}

          <div className="oc-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active === item.value}
                className={active === item.value ? "active" : undefined}
                onClick={() => navigate(`${boardPath(slug)}/manage/${item.value}`)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {active === "basic" || active === "rules" || active === "design" ? (
            <ManageBoardSettings
              board={current}
              mode={active}
              onSaved={(updated) => {
                setBoard(updated);
                info.reload();
              }}
            />
          ) : null}

          {active === "staff" ? (
            <ManageStaff slug={slug} staff={currentStaff} onChange={(next) => setStaff(next)} />
          ) : null}

          {active === "plugins" ? (
            <div className="oc-stack">
              <Notice kind="ok">
                板に適用するプラグインはプラグイン管理画面から導入できます。プラグインはブラウザ内サンドボックスで実行され、
                宣言した権限の範囲でのみ動作します。
              </Notice>
              <div className="oc-row">
                <a className="oc-btn oc-btn-primary" href={`/plugins/board/?slug=${encodeURIComponent(slug)}`}>
                  板のプラグイン設定を開く
                </a>
                <a className="oc-btn" href="/plugins">
                  プラグインを探す
                </a>
              </div>
              <PluginSlot slot="board-manage" boardSlug={slug} />
            </div>
          ) : null}

          {active === "ai" ? (
            <div className="oc-stack">
              <AiBoardPanel
                slug={slug}
                boardId={Number.isFinite(Number(current.id)) ? Number(current.id) : undefined}
                canManage={canManage}
              />
              <PluginSlot slot="board-manage" boardSlug={slug} />
            </div>
          ) : null}

          {active === "reports" ? <ManageReports slug={slug} /> : null}
        </div>
      </div>
    </div>
  );
}