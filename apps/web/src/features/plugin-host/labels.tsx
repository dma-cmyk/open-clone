"use client";

// プラグインの権限・表示場所（スロット）の利用者向け表示。
// 文言と危険度は shared の説明表（plugin-labels.ts）だけを参照する（画面ごとに文面を持たない）。
// 詳細画面・導入画面・エディタ・ヘルプで同じ部品を使う。

import type { CSSProperties } from "react";
import {
  PLUGIN_PERMISSION_INFOS,
  PLUGIN_RISK_LABEL,
  PLUGIN_RISK_NOTE,
  pluginPermissionInfo,
  pluginSlotHost,
  pluginSlotInfo,
  type PluginPermission,
  type PluginRisk,
  type PluginSlotName,
} from "shared";

const RISK_TONE: Record<PluginRisk, { badge: string; border: string; background: string }> = {
  low: { badge: "oc-badge oc-badge-green", border: "var(--oc-border)", background: "transparent" },
  medium: { badge: "oc-badge oc-badge-yellow", border: "#d4a017", background: "#fff8e1" },
  high: { badge: "oc-badge oc-badge-red", border: "var(--oc-danger)", background: "#fdecea" },
};

const listStyle: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

const identifierStyle: CSSProperties = {
  fontFamily: "var(--oc-mono)",
  fontSize: 10.5,
  color: "var(--oc-muted)",
  background: "var(--oc-surface)",
  border: "1px solid var(--oc-border)",
  borderRadius: "var(--oc-radius)",
  padding: "0 3px",
  wordBreak: "break-all",
};

export function PluginRiskBadge({ risk }: { risk: PluginRisk }) {
  return (
    <span className={RISK_TONE[risk].badge} title={PLUGIN_RISK_NOTE[risk]}>
      危険度: {PLUGIN_RISK_LABEL[risk]}
    </span>
  );
}

/**
 * 権限の一覧（日本語名・危険度・説明・識別子）。
 * 中・高は色（左線と背景）と文字（危険度: 中/高）の両方で目立たせる。
 */
export function PluginPermissionList(props: {
  permissions: readonly PluginPermission[];
  /** net:fetch の通信先。詳細では manifest.connectAllowlist を渡す。 */
  connectAllowlist?: readonly string[] | undefined;
  /** 一覧カードなどで詰めて出す。 */
  compact?: boolean;
  emptyLabel?: string;
  testId?: string;
}) {
  const permissions = props.permissions;
  const compact = props.compact === true;
  if (permissions.length === 0) {
    return <p className="oc-muted oc-small" style={{ margin: 0 }}>{props.emptyLabel ?? "権限なし"}</p>;
  }
  const allowlist = props.connectAllowlist ?? [];
  return (
    <ul style={listStyle} data-testid={props.testId}>
      {permissions.map((permission) => {
        const info = pluginPermissionInfo(permission);
        const tone = RISK_TONE[info.risk];
        return (
          <li
            key={permission}
            data-permission={permission}
            data-risk={info.risk}
            style={{
              borderTop: "1px solid var(--oc-border)",
              borderLeft: `3px solid ${tone.border}`,
              background: tone.background,
              padding: compact ? "4px 6px" : "6px 8px",
              marginTop: 2,
            }}
          >
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <strong style={{ fontSize: compact ? 12.5 : 13 }}>{info.name}</strong>
              <PluginRiskBadge risk={info.risk} />
              <code style={identifierStyle}>{permission}</code>
            </div>
            <div style={{ fontSize: compact ? 11.5 : 12, color: "var(--oc-text)", lineHeight: 1.5 }}>
              {info.description}
            </div>
            {permission === "net:fetch" ? (
              <div style={{ fontSize: 11.5, marginTop: 2 }}>
                <span style={{ color: "var(--oc-muted)" }}>通信先: </span>
                {allowlist.length === 0 ? (
                  <span style={{ color: "#8a5b00" }}>指定なし（このプラグインは外部と通信できません）</span>
                ) : (
                  allowlist.map((origin) => (
                    <code key={origin} style={{ ...identifierStyle, marginRight: 4 }}>
                      {origin}
                    </code>
                  ))
                )}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * エディタ用の権限チェックリスト。日本語名・危険度・説明・識別子を並べ、
 * 選べない権限は理由も文字で出す（title だけにしない）。
 */
export function PluginPermissionChecklist(props: {
  selected: readonly PluginPermission[];
  isDisabled?: (permission: PluginPermission) => boolean;
  blockedReason?: string;
  onChange: (permission: PluginPermission) => void;
}) {
  return (
    <ul style={listStyle} data-testid="plugin-permission-checklist">
      {PLUGIN_PERMISSION_INFOS.map((info) => {
        const disabled = props.isDisabled?.(info.permission) === true;
        const tone = RISK_TONE[info.risk];
        return (
          <li key={info.permission} data-permission={info.permission} style={{ marginTop: 3 }}>
            <label
              style={{
                display: "flex",
                gap: 6,
                alignItems: "flex-start",
                padding: "4px 6px",
                borderLeft: `3px solid ${tone.border}`,
                background: tone.background,
                opacity: disabled ? 0.55 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              <input
                type="checkbox"
                style={{ marginTop: 3 }}
                checked={props.selected.includes(info.permission)}
                disabled={disabled}
                onChange={() => props.onChange(info.permission)}
              />
              <span style={{ display: "block", minWidth: 0 }}>
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <strong style={{ fontSize: 12.5 }}>{info.name}</strong>
                  <PluginRiskBadge risk={info.risk} />
                  <code style={identifierStyle}>{info.permission}</code>
                </span>
                <span
                  style={{
                    display: "block",
                    fontSize: 11.5,
                    color: "var(--oc-muted)",
                    lineHeight: 1.45,
                  }}
                >
                  {info.description}
                </span>
                {disabled ? (
                  <span style={{ display: "block", fontSize: 11, color: "#8a5b00" }}>
                    {props.blockedReason ?? "今は選べません"}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 宣言されている表示場所の一覧。別名は置き先の場所名で出し、識別子を小さく添える。
 * 通常の画面に置き場所が無いもの（plugin-page）は「表示場所なし」と出す。
 */
export function PluginSlotList(props: {
  slots: readonly PluginSlotName[];
  compact?: boolean;
  emptyLabel?: string;
}) {
  const compact = props.compact === true;
  if (props.slots.length === 0) {
    return (
      <p className="oc-muted oc-small" style={{ margin: 0 }}>
        {props.emptyLabel ?? "表示場所の指定なし（画面には出ません）"}
      </p>
    );
  }
  return (
    <ul style={listStyle} data-testid="plugin-slot-list">
      {props.slots.map((slot) => {
        const info = pluginSlotInfo(slot);
        return (
          <li
            key={slot}
            data-slot={slot}
            style={{
              borderTop: "1px solid var(--oc-border)",
              padding: compact ? "3px 0" : "5px 0",
            }}
          >
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <strong style={{ fontSize: compact ? 12 : 12.5 }}>{info.label}</strong>
              {info.aliasOf ? <span className="oc-badge oc-badge-gray">別名</span> : null}
              <code style={identifierStyle}>{slot}</code>
            </div>
            {compact ? null : (
              <div style={{ fontSize: 11.5, color: "var(--oc-muted)", lineHeight: 1.5 }}>
                {info.description}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 一覧カード用に、表示場所を場所名だけで 1 行にする。 */
export function pluginSlotNames(slots: readonly PluginSlotName[]): string {
  if (slots.length === 0) return "表示場所の指定なし";
  const labels = slots.map((slot) => pluginSlotInfo(slot).label);
  return [...new Set(labels)].join(" / ");
}

export function PluginLabelsHelpLink({ children }: { children?: string }) {
  return <a href="/help/#plugin-permissions">{children ?? "ヘルプ: プラグインの権限と表示場所"}</a>;
}

interface DiagramBand {
  slot: PluginSlotName;
  label: string;
  /** 帯の高さの目安（px）。 */
  height: number;
  note?: string;
}

const SITE_BANDS: DiagramBand[] = [
  { slot: "site-header", label: "サイトのヘッダー", height: 22 },
  { slot: "site-top", label: "サイトの上部（トップ）", height: 20 },
  { slot: "board-top", label: "板の上", height: 26 },
  { slot: "board-sidebar", label: "板の横（スマホでは表示されません）", height: 48, note: "狭い画面では非表示" },
  { slot: "board-manage", label: "板の管理画面", height: 26 },
];

const THREAD_BANDS: DiagramBand[] = [
  { slot: "thread-top", label: "スレの上", height: 24 },
  { slot: "thread-nav", label: "スレ内メニュー", height: 20 },
  { slot: "post-actions", label: "各レスの下", height: 34, note: "レスごと" },
  { slot: "thread-bottom", label: "スレの下", height: 22 },
  { slot: "post-form-extra", label: "書き込み欄の下", height: 24, note: "投稿欄の下" },
];

function DiagramScreen(props: {
  title: string;
  bands: DiagramBand[];
  active: PluginSlotName | null;
}) {
  return (
    <div
      aria-label={`${props.title}の略図`}
      style={{
        flex: "1 1 180px",
        minWidth: 160,
        border: "1px solid var(--oc-border-strong)",
        borderRadius: "var(--oc-radius)",
        background: "var(--oc-surface-alt)",
        padding: 6,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--oc-muted)", marginBottom: 4 }}>
        {props.title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {props.bands.map((band) => {
          const active = band.slot === props.active;
          return (
            <div
              key={band.slot}
              aria-current={active ? "true" : undefined}
              style={{
                minHeight: band.height,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 4,
                padding: "1px 5px",
                fontSize: 11,
                lineHeight: 1.3,
                border: active ? "2px solid var(--oc-danger)" : "1px dashed var(--oc-border)",
                background: active ? "#ffd54f" : "var(--oc-panel-soft)",
                fontWeight: active ? 700 : 400,
                color: "var(--oc-text)",
              }}
            >
              <span>{band.label}</span>
              <span style={{ fontSize: 9.5, color: active ? "var(--oc-danger)" : "var(--oc-muted)" }}>
                {active ? "▲ ここ" : (band.note ?? "")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 画面の略図（CSS）。選んだスロットを板画面・スレ画面の対応する帯で強調する。
 * `plugin-page` のように通常の画面に置き場所が無いものは、強調せずにその旨を出す。
 */
export function PluginSlotDiagram({ slot }: { slot: PluginSlotName }) {
  const info = pluginSlotInfo(slot);
  const host = pluginSlotHost(slot);
  return (
    <div data-testid="plugin-slot-diagram" data-slot={slot} style={{ marginTop: 6 }}>
      <p style={{ margin: "0 0 4px", fontSize: 12 }}>
        {host === null ? (
          <>
            <strong>{info.label}</strong>: 板・スレの画面には置かれません（専用ページとプレビューだけ）。
          </>
        ) : (
          <>
            <strong>{info.label}</strong>
            {info.aliasOf ? `（${slot}）` : ""} はこの位置です。
          </>
        )}
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <DiagramScreen title="板の画面（サイト共通の上部）" bands={SITE_BANDS} active={host} />
        <DiagramScreen title="スレの画面" bands={THREAD_BANDS} active={host} />
      </div>
      <p className="oc-muted oc-small" style={{ margin: "4px 0 0" }}>
        図は配置場所の目安です。実際の並びは画面によって少し変わります。
      </p>
    </div>
  );
}