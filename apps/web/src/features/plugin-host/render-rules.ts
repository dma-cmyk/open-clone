// 宣言的レンダー規則（manifest.render.post）の実行（DESIGN §7.1）。
// プラグイン JS ではなくホストが regex → template を適用する。キャプチャ・テンプレートは必ず
// エスケープされるため、ホスト DOM への HTML 注入は成立しない。

import { analyzeRegexPattern, type PluginPostRenderRule } from "shared";

/**
 * ReDoS 対策の実行時上限（M-1）。静的判定（`analyzeRegexPattern`）をすり抜けた規則でも
 * 1 規則あたりのマッチ数と経過時間を制限し、超えた規則はそのページ以降無効化する。
 * 単一の `exec` が長時間ブロックする形は静的判定で拒否する（実行前に判定するため
 * 判定自体がメインスレッドを止めない）。
 */
const MAX_RENDER_RULES = 20;
const MAX_MATCHES_PER_RULE = 500;
const MAX_RENDER_TEXT_CHARS = 10_000;
const DEFAULT_RULE_TIME_BUDGET_MS = 50;

let ruleTimeBudgetMs = DEFAULT_RULE_TIME_BUDGET_MS;
const disabledRuleKeys = new Set<string>();

/** `String.replace` のコールバックから規則の中断を伝える内部センチネル。 */
const RULE_ABORTED = Symbol("render-rule-aborted");

function ruleKey(rule: PluginPostRenderRule): string {
  return `${rule.pattern}\u0000${rule.flags ?? ""}`;
}

/** テスト専用: 経過時間の上限を差し替える（既定 50ms）。 */
export function setRenderRuleTimeBudgetForTest(ms: number): void {
  ruleTimeBudgetMs = ms;
}

/** テスト専用: 無効化した規則の記憶と上限を初期化する。 */
export function resetRenderRuleGuardsForTest(): void {
  disabledRuleKeys.clear();
  ruleTimeBudgetMs = DEFAULT_RULE_TIME_BUDGET_MS;
}

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

/**
 * 規則の正規表現を global 付きでコンパイルする（不正・危険・無効化済みなら null）。
 * `analyzeRegexPattern` はブラウザのメインスレッドで exec を回す前に ReDoS 形を拒否する。
 */
function compileRule(rule: PluginPostRenderRule): RegExp | null {
  const key = ruleKey(rule);
  if (disabledRuleKeys.has(key)) return null;
  if (!analyzeRegexPattern(rule.pattern).safe) {
    disabledRuleKeys.add(key);
    return null;
  }
  try {
    const flags = normalizeFlags(rule.flags);
    return new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch {
    return null;
  }
}

interface RuleRuntime {
  started: number;
  matches: number;
  /** 時間・マッチ数の上限に達した（規則を丸ごと諦める）。 */
  aborted: boolean;
}

function overBudget(runtime: RuleRuntime): boolean {
  const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
  return runtime.matches > MAX_MATCHES_PER_RULE || nowMs - runtime.started > ruleTimeBudgetMs;
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
  // 本文が上限を超える場合は規則を適用しない（防御の最終段。通常の投稿上限は 4096 バイト）。
  if (text.length > MAX_RENDER_TEXT_CHARS) return [{ type: "text", text }];

  let segments: PostRenderSegment[] = [{ type: "text", text }];

  for (const rule of rules.slice(0, MAX_RENDER_RULES)) {
    const regex = compileRule(rule);
    if (!regex) continue;
    const kind = rule.kind ?? "text";
    const runtime: RuleRuntime = {
      started: typeof performance !== "undefined" ? performance.now() : Date.now(),
      matches: 0,
      aborted: false,
    };
    const next: PostRenderSegment[] = [];
    for (const segment of segments) {
      if (segment.type === "rule") {
        next.push(segment);
        continue;
      }
      next.push(...splitRuleMatches(segment.text, regex, kind, rule.template, runtime));
      if (runtime.aborted) break;
    }
    if (runtime.aborted) {
      // 途中までの結果は使わず、この規則を無効化する（以降のレスでも実行しない）。
      disabledRuleKeys.add(ruleKey(rule));
      continue;
    }
    segments = next;
  }

  return segments;
}

function splitRuleMatches(
  text: string,
  regex: RegExp,
  kind: string,
  template: string,
  runtime: RuleRuntime,
): PostRenderSegment[] {
  const parts: PostRenderSegment[] = [];
  let cursor = 0;
  let found = false;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    runtime.matches += 1;
    if (overBudget(runtime)) {
      runtime.aborted = true;
      return [{ type: "text", text }];
    }
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
  if (text.length > MAX_RENDER_TEXT_CHARS) return { html, matched };

  for (const rule of rules.slice(0, MAX_RENDER_RULES)) {
    const regex = compileRule(rule);
    if (!regex) continue;
    const runtime: RuleRuntime = {
      started: typeof performance !== "undefined" ? performance.now() : Date.now(),
      matches: 0,
      aborted: false,
    };
    const before = html;
    let ruleMatched = false;
    try {
      html = html.replace(regex, (...args: unknown[]) => {
        runtime.matches += 1;
        if (overBudget(runtime)) {
          runtime.aborted = true;
          throw RULE_ABORTED;
        }
        ruleMatched = true;
        const captures = extractCaptures(args);
        const kind = rule.kind ?? "text";
        return `<span class="oc-plugin-render oc-plugin-render-${escapeHtml(kind)}" data-plugin-rule="1">${renderTemplate(rule.template, captures)}</span>`;
      });
    } catch (error) {
      if (error !== RULE_ABORTED) throw error;
      // 上限超過は規則を丸ごと諦め、この規則を無効化する（以前の規則の結果は保持）。
      html = before;
      ruleMatched = false;
      disabledRuleKeys.add(ruleKey(rule));
    }
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