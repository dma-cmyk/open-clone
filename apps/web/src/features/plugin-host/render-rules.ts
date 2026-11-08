// 宣言的レンダー規則（manifest.render.post）の実行（DESIGN §7.1）。
// プラグイン JS ではなくホストが regex → template を適用する。キャプチャ・テンプレートは必ず
// エスケープされるため、ホスト DOM への HTML 注入は成立しない。

import type { PluginPostRenderRule } from "shared";

export interface PostRenderResult {
  html: string;
  matched: boolean;
}

/** HTML エスケープ（ホスト描画用）。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ALLOWED_FLAGS: Record<string, true> = { g: true, i: true, m: true, s: true, u: true };

function normalizeFlags(flags: string | undefined): string {
  const result = new Set<string>();
  for (const flag of flags ?? "") {
    if (ALLOWED_FLAGS[flag]) result.add(flag);
  }
  return [...result].join("");
}

/** replace コールバックの引数からキャプチャ文字列を取り出す。 */
function extractCaptures(args: readonly unknown[]): string[] {
  const last = args[args.length - 1];
  const hasNamedGroups = typeof last === "object" && last !== null;
  const end = args.length - (hasNamedGroups ? 3 : 2);
  const captures: string[] = [];
  for (let i = 1; i < end; i++) {
    const value = args[i];
    captures.push(typeof value === "string" ? value : "");
  }
  return captures;
}

/** テンプレートの `$1`..`$9` をキャプチャで置換する（静的部分はエスケープ）。 */
function renderTemplate(template: string, captures: readonly string[]): string {
  return template
    .split(/(\$\d)/)
    .map((part) => {
      const reference = /^\$(\d)$/.exec(part);
      if (reference) return captures[Number(reference[1]) - 1] ?? "";
      return escapeHtml(part);
    })
    .join("");
}

/** 規則の正規表現を global 付きでコンパイルする（不正なら null）。 */
function compileRule(rule: PluginPostRenderRule): RegExp | null {
  try {
    const flags = normalizeFlags(rule.flags);
    return new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch {
    return null;
  }
}

/** レス本文の断片。`rule` はプラグインの変換規則が適用された範囲。 */
export type PostRenderSegment =
  | { type: "text"; text: string }
  | { type: "rule"; kind: string; text: string };

/**
 * レス本文を「通常テキスト」と「規則が適用された範囲」に分割する（React 描画用）。
 *
 * `applyPostRenderRules` が HTML 文字列を返すのに対し、こちらは構造を返すため、
 * 呼び出し側は `rule` 範囲を既存の要素（安価ボタン・URL リンク・AA 等）として描画できる。
 * `rule.text` も**文字列**であり HTML ではない。React のテキストノードとして描画すれば
 * 悪意あるテンプレート・キャプチャもエスケープされる（XSS にならない）。
 */
export function splitPostRenderRules(
  text: string,
  rules: readonly PluginPostRenderRule[] = [],
): PostRenderSegment[] {
  let segments: PostRenderSegment[] = [{ type: "text", text }];

  for (const rule of rules) {
    const regex = compileRule(rule);
    if (!regex) continue;
    const kind = rule.kind ?? "text";
    segments = segments.flatMap((segment) =>
      segment.type === "rule" ? [segment] : splitRuleMatches(segment.text, regex, kind, rule.template),
    );
  }

  return segments;
}

function splitRuleMatches(
  text: string,
  regex: RegExp,
  kind: string,
  template: string,
): PostRenderSegment[] {
  const parts: PostRenderSegment[] = [];
  let cursor = 0;
  let found = false;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    found = true;
    const index = match.index;
    if (index > cursor) parts.push({ type: "text", text: text.slice(cursor, index) });
    const captures = match.slice(1).map((value) => (typeof value === "string" ? value : ""));
    // テンプレートは文字列として組み立てる。エスケープは描画側（React のテキストノード）が担う。
    const rendered = template.replace(/\$(\d)/g, (_matched, index: string) => captures[Number(index) - 1] ?? "");
    parts.push({ type: "rule", kind, text: rendered });
    cursor = index + match[0].length;
    // 空マッチだと lastIndex が進まず無限ループになるため、手動で進める。
    if (match[0].length === 0) regex.lastIndex += 1;
  }

  if (!found) return [{ type: "text", text }];
  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

/**
 * プレーンテキストのレス本文に宣言的規則を適用する。
 * 戻り値の html は安全（すべてエスケープ済み）。`matched=false` なら html は本文のエスケープ結果。
 */
export function applyPostRenderRules(
  text: string,
  rules: readonly PluginPostRenderRule[] = [],
): PostRenderResult {
  let html = escapeHtml(text);
  let matched = false;

  for (const rule of rules) {
    let regex: RegExp;
    try {
      const flags = normalizeFlags(rule.flags);
      regex = new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
    } catch {
      continue;
    }

    let ruleMatched = false;
    html = html.replace(regex, (...args: unknown[]) => {
      ruleMatched = true;
      const captures = extractCaptures(args);
      const kind = rule.kind ?? "text";
      return `<span class="oc-plugin-render oc-plugin-render-${escapeHtml(kind)}" data-plugin-rule="1">${renderTemplate(rule.template, captures)}</span>`;
    });
    matched = matched || ruleMatched;
  }

  return { html, matched };
}

/** 複数プラグインの規則をまとめて適用する（順序は渡した順）。 */
export function applyAllPostRenderRules(
  text: string,
  ruleSets: readonly (readonly PluginPostRenderRule[])[],
): PostRenderResult {
  let html = escapeHtml(text);
  let matched = false;
  for (const rules of ruleSets) {
    const result = applyPostRenderRules(html, rules);
    html = result.html;
    matched = matched || result.matched;
  }
  return { html, matched };
}

/** ホスト側で使う装飾 CSS（PluginSlot が <style> を一度だけ挿入する）。 */
export const PLUGIN_RENDER_CSS = `
.oc-plugin-render-spoiler { background: #2b2b2b; color: #2b2b2b; border-radius: 2px; padding: 0 2px; cursor: pointer; }
.oc-plugin-render-spoiler:hover, .oc-plugin-render-spoiler:focus, .oc-plugin-render-spoiler:active { color: #fff; }
.oc-plugin-render-dice { display: inline-block; border: 1px solid var(--oc-border-strong, #888); border-radius: var(--oc-radius, 3px); padding: 0 3px; font-weight: bold; }
.oc-plugin-render-link { color: var(--oc-name, #228811); text-decoration: underline; }
.oc-plugin-render-image { color: var(--oc-name, #228811); }
`;