"use client";

// 板管理画面のシェル。ルール・デザイン・スタッフ・プラグイン・AI・通報。
import { useEffect, useState } from "react";
import { api } from "@/features/board-ui/api";
import { boardPath } from "@/features/board-ui/format";
import { useApiData, errorMessage } from "@/features/board-ui/use-api-data";
import { PluginSlot } from "@/components/plugin-slot";
import { AiBoardPanel } from "@/components/ai-board-panel";
import { Notice, Spinner } from "@/components/ui";
import { Link, navigate } from "../router";
import { usePageTitle } from "@/lib/title";
import { ManageBoardSettings } from "./manage-settings";
import { ManageStaff } from "./manage-staff";
import { ManageReports } from "./manage-reports";
import type { BoardDetail, StaffEntry } from "@/features/board-ui/types";
import { clearQueuedTour, setTourContext, setTourContextPending, startTour } from "@/features/site-tour";

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
  // 板名が取れるまでは slug で仮のタイトルを出す（前の画面のスレ名を残さない）。
  const info = useApiData(() => api.getBoard(slug), [slug]);
  usePageTitle(`${info.data?.board.name ?? slug} 板の管理`);
  const [board, setBoard] = useState<BoardDetail | null>(null);
  const [staff, setStaff] = useState<StaffEntry[] | null>(null);

  const current = board ?? info.data?.board ?? null;
  const currentStaff = staff ?? info.data?.staff ?? [];
  const canManage = info.data?.canManage ?? false;
  const active = TABS.some((item) => item.value === tab) ? tab : "basic";
  // 板の管理画面の権限をツアーへ知らせる（ヘッダー／フッターから開始されても同じ手順にする）。
  const [accountId, setAccountId] = useState<string | null>(null);
  const [sessionSettled, setSessionSettled] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getSession()
      .then((session) => {
        if (alive) setAccountId(session?.id ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setSessionSettled(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  const myLevel = accountId
    ? currentStaff.find((entry) => entry.accountId === accountId)?.level
    : undefined;
  const isStaff = canManage || myLevel === "deputy" || myLevel === "moderator";
  // 権限（板情報・セッション）が揃うまでは、ツアー開始要求を保留する。
  // 以前は読み込み中の開始が権限不足と同じ false になり、ヘッダーの「使い方」が
  // ヘルプへ飛んでいた（K3）。
  const tourContextReady = sessionSettled && !info.loading;
  useEffect(() => {
    if (!tourContextReady) {
      setTourContextPending(true);
      return;
    }
    setTourContext({ boardStaff: isStaff, canManageBoard: canManage });
    setTourContextPending(false);
  }, [tourContextReady, isStaff, canManage]);
  // 画面を離れたら、保留中の開始要求と権限を持ち越さない。
  useEffect(
    () => () => {
      clearQueuedTour();
      setTourContextPending(false);
      setTourContext({ boardStaff: false, canManageBoard: false });
    },
    [],
  );

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
          {canManage ? (
            <div className="oc-row oc-mb" style={{ gap: 6, alignItems: "center" }}>
              {/* 板の管理画面の使い方（ツアー）と管理者向けヘルプへの導線。
                  管理権限が無い人には、管理操作の案内を出さない。 */}
              <button
                type="button"
                className="oc-btn oc-btn-sm"
                data-tour="manage-help"
                onClick={() => startTour("manage")}
                title="この板の管理画面の使い方を順に案内します"
              >
                使い方ツアー
              </button>
              <a className="oc-btn oc-btn-sm" href="/help/admin/#board-staff">
                板の管理のヘルプ
              </a>
              <a className="oc-btn oc-btn-sm" href="/help/admin/#board-staff">
                通報の対応
              </a>
            </div>
          ) : null}
          {!canManage ? (
            <Notice kind="warn">
              この板の管理には板スタッフ（管理人/副管理人/モデレーター）権限が必要です。
              <a href="/account/login"> ログイン</a> してから再度お試しください。
            </Notice>
          ) : null}

          <div className="oc-tabs" role="tablist" data-tour="manage-tabs">
            {TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active === item.value}
                data-tour={`manage-tab-${item.value}`}
                className={active === item.value ? "active" : undefined}
                onClick={() => navigate(`${boardPath(slug)}/manage/${item.value}`)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div data-tour="manage-panel">

          {active === "basic" || active === "rules" || active === "design" ? (
            <ManageBoardSettings
              board={current}
              mode={active}
              canManage={canManage}
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
    </div>
  );
}