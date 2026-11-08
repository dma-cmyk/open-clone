// 板デザイン設定を CSS カスタムプロパティへ変換する。
// shared の boardDesignSchema（themeColor / accentColor / bannerUrl / css）に対応。
// 任意 CSS（design.css）は他の利用者への影響が読めないため描画に適用しない（保存のみ）。

import type { CSSProperties } from "react";
import type { BoardDesign } from "./types";

const COLOR = /^(#[0-9a-fA-F]{6}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;

function accepted(value: unknown): string | null {
  return typeof value === "string" && COLOR.test(value.trim()) ? value.trim() : null;
}

export function boardDesignStyle(design: BoardDesign | undefined | null): CSSProperties {
  const vars: Record<string, string> = {};
  const theme = accepted(design?.themeColor);
  const accent = accepted(design?.accentColor);
  if (theme) {
    vars["--oc-panel"] = theme;
    vars["--oc-panel-soft"] = theme;
    vars["--oc-border"] = theme;
  }
  if (accent) {
    vars["--oc-accent"] = accent;
    vars["--oc-name"] = accent;
  }
  // CSS カスタムプロパティは CSSProperties の型に無いため、検証済みの値だけを渡す。
  return vars as CSSProperties;
}

/** 板バナーの URL を安全に取り出す（http/https/data:image のみ）。 */
export function boardBanner(design: BoardDesign | undefined | null): string | null {
  const url = design?.bannerUrl;
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return trimmed;
  }
  return null;
}