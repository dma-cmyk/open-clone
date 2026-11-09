"use client";

// `/plugins` 配下の共通 UI。
// 見た目は WP2 の globals.css（`oc-*` クラスと `--oc-*` 変数）に合わせる。
// 独自の装飾は足さず、掲示板本体と同じパネル/ボタン/入力の見た目を再利用する。

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

/** レイアウト補助のみ。色・書体・角丸は globals.css の変数に従う。 */
export const ui: Record<string, CSSProperties> = {
  page: { maxWidth: 1000, margin: "0 auto", padding: "8px 10px 40px" },
  nav: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  card: {
    background: "var(--oc-surface-alt)",
    border: "1px solid var(--oc-border)",
    borderRadius: "var(--oc-radius)",
    padding: 8,
    marginBottom: 10,
  },
  row: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  muted: { color: "var(--oc-muted)", fontSize: 12 },
  code: {
    background: "#1e1e1e",
    color: "#e6e6e6",
    padding: 10,
    borderRadius: "var(--oc-radius)",
    overflow: "auto",
    fontSize: 12,
    fontFamily: "var(--oc-mono)",
    maxHeight: 420,
    margin: 0,
  },
};

/** 静的エクスポートで useSearchParams の Suspense 要件を避けるため、window.location から読む。 */
export function useQueryParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setValue(params.get(name));
  }, [name]);
  return value;
}

export function PluginShell(props: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="oc-app">
      <main className="oc-main">
        <nav className="oc-row" style={ui.nav}>
          <Link className="oc-btn oc-btn-sm" href="/plugins/">
            プラグイン一覧
          </Link>
          <Link className="oc-btn oc-btn-sm" href="/plugins/templates/">
            テンプレート
          </Link>
          <Link className="oc-btn oc-btn-sm" href="/plugins/new/">
            新規作成
          </Link>
          <Link className="oc-btn oc-btn-sm" href="/plugins/review/">
            審査キュー
          </Link>
          <Link className="oc-btn oc-btn-sm" href="/plugins/demo/">
            スレ表示デモ
          </Link>
          <Link className="oc-btn oc-btn-sm" href="/">
            掲示板トップ
          </Link>
        </nav>
        <div className="oc-row-between" style={{ alignItems: "flex-start", marginBottom: 6 }}>
          <h1 style={{ fontSize: 18, margin: 0, color: "var(--oc-name)" }}>{props.title}</h1>
          <div className="oc-row">{props.actions}</div>
        </div>
        {props.description ? (
          <p className="oc-note" style={{ margin: "0 0 10px" }}>
            {props.description}
          </p>
        ) : null}
        {props.children}
      </main>
    </div>
  );
}

export function Card(props: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="oc-panel">
      {props.title ? (
        <div className="oc-panel-title">
          <span>{props.title}</span>
          <span className="oc-spacer" />
          <span className="oc-row">{props.actions}</span>
        </div>
      ) : null}
      <div className="oc-panel-inner">{props.children}</div>
    </section>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="oc-field">
      <span className="oc-label">
        {props.label}
        {props.hint ? <span className="oc-note"> — {props.hint}</span> : null}
      </span>
      {props.children}
    </label>
  );
}

const BADGE_TONE: Record<string, string> = {
  ok: "oc-badge-green",
  warn: "oc-badge-yellow",
  danger: "oc-badge-red",
  neutral: "oc-badge-gray",
};

export function Badge(props: { tone?: "ok" | "warn" | "danger" | "neutral"; children: ReactNode }) {
  return <span className={`oc-badge ${BADGE_TONE[props.tone ?? "neutral"]}`}>{props.children}</span>;
}

export function formatTime(seconds: number | null | undefined): string {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString("ja-JP");
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function Notice(props: { tone?: "ok" | "warn" | "danger"; children: ReactNode }) {
  const tone = props.tone ?? "ok";
  if (tone === "warn") {
    return (
      <div
        style={{
          background: "var(--oc-warn-bg)",
          border: "1px solid #d4c44a",
          color: "#5d4037",
          padding: "6px 8px",
          marginBottom: 8,
          fontSize: 12.5,
          whiteSpace: "pre-wrap",
        }}
      >
        {props.children}
      </div>
    );
  }
  return (
    <div
      className={tone === "danger" ? "oc-error" : "oc-ok"}
      style={{ marginBottom: 8, whiteSpace: "pre-wrap" }}
    >
      {props.children}
    </div>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  pending: "審査待ち",
  published: "公開中",
  rejected: "却下",
  disabled: "停止中",
  approved: "承認",
  private: "非公開",
  unlisted: "限定公開",
  public: "公開",
};

export const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  draft: "neutral",
  pending: "warn",
  published: "ok",
  rejected: "danger",
  disabled: "danger",
};

export function StatusBadge(props: { status: string }) {
  return <Badge tone={STATUS_TONE[props.status] ?? "neutral"}>{STATUS_LABEL[props.status] ?? props.status}</Badge>;
}
