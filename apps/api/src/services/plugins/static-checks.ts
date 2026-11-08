// プラグインコードの静的検査（DESIGN §7.3 の審査支援）。
// WP5 の AI 審査（`runStaticChecks` 契約）と WP3 の公開申請・エディタのプレビュー検査が呼ぶ。
// 検査は「sandbox 前提のコード品質・意図検出」であり、サンドボックスの安全性は iframe + bridge が担保する。

import { PLUGIN_CODE_MAX_BYTES, type PluginStaticCheckResult } from "shared";

export type StaticCheckResult = PluginStaticCheckResult;

interface Rule {
  pattern: RegExp;
  reason: string;
  /** reject = 公開不可 / warn = 警告のみ */
  severity: "reject" | "warn";
  score: number;
}

/**
 * 禁止・警告パターン。sandbox（不透明オリジン + CSP default-src 'none'）では
 * これらは動作しないが、作者の意図（脱出・外部送信）を示すため公開を止める。
 */
const RULES: readonly Rule[] = [
  // ── サンドボックス外へのアクセス試行（reject） ──
  { pattern: /\bdocument\s*\.\s*cookie\b/, reason: "document.cookie はサンドボックスでは利用できません", severity: "reject", score: 30 },
  { pattern: /\blocalStorage\b/, reason: "localStorage は利用できません（storage:* RPC を使用してください）", severity: "reject", score: 25 },
  { pattern: /\bsessionStorage\b/, reason: "sessionStorage は利用できません（storage:* RPC を使用してください）", severity: "reject", score: 25 },
  { pattern: /\bindexedDB\b/, reason: "indexedDB は利用できません", severity: "reject", score: 25 },
  { pattern: /\b(?:window\s*\.\s*)?parent\s*\.\s*document\b/, reason: "親 DOM へのアクセスは禁止です", severity: "reject", score: 40 },
  { pattern: /\b(?:window\s*\.\s*)?top\s*\.\s*document\b/, reason: "トップ DOM へのアクセスは禁止です", severity: "reject", score: 40 },
  { pattern: /\bwindow\s*\.\s*opener\b|\bopener\s*\./, reason: "window.opener へのアクセスは禁止です", severity: "reject", score: 30 },
  { pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/, reason: "document.write は使用できません", severity: "reject", score: 15 },
  { pattern: /(^|[^.\w])eval\s*\(/, reason: "eval は使用できません", severity: "reject", score: 35 },
  { pattern: /\bnew\s+Function\s*\(/, reason: "new Function は使用できません", severity: "reject", score: 35 },
  { pattern: /\bimport\s*\(\s*["'`]https?:/, reason: "リモートモジュールの動的 import は禁止です", severity: "reject", score: 35 },
  { pattern: /\bnew\s+(?:WebSocket|EventSource)\s*\(/, reason: "直接の WebSocket/EventSource は禁止です（events:subscribe を使用）", severity: "reject", score: 25 },
  { pattern: /\bfor\s*\(\s*;\s*;\s*\)/, reason: "無限ループ（for(;;)）は禁止です", severity: "reject", score: 30 },
  { pattern: /\bwhile\s*\(\s*(?:true|1)\s*\)/, reason: "無限ループ（while(true)）は禁止です", severity: "reject", score: 30 },
  { pattern: /\bwhile\s*\(\s*1\s*\)/, reason: "無限ループ（while(1)）は禁止です", severity: "reject", score: 30 },

  // ── 警告 ──
  { pattern: /\bfetch\s*\(\s*["'`]https?:/, reason: "直接 fetch はサンドボックスで遮断されます。net.fetch RPC を使用してください", severity: "warn", score: 12 },
  { pattern: /\bXMLHttpRequest\b/, reason: "XMLHttpRequest は遮断されます。net.fetch RPC を使用してください", severity: "warn", score: 12 },
  { pattern: /\bwindow\s*\.\s*location\b|\blocation\s*\.\s*(?:href|assign|replace)\b/, reason: "ページ遷移はサンドボックスで遮断されます", severity: "warn", score: 8 },
  { pattern: /\balert\s*\(/, reason: "alert は表示されません（notify RPC を使用してください）", severity: "warn", score: 3 },
  { pattern: /\bdocument\s*\.\s*domain\b/, reason: "document.domain は不透明オリジンでは無効です", severity: "warn", score: 10 },
];

/** 単一行が極端に長い場合は難読化の疑い（警告）。 */
const LONG_LINE_CHARS = 20_000;

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) line++;
  }
  return line;
}

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * プラグインコードの静的検査。
 * - `allowed=false` は公開不可（reject ルール該当 or サイズ超過 or 空）
 * - `riskScore` は 0–100（高いほど審査で要注意）
 */
export async function runStaticChecks(code: string): Promise<StaticCheckResult> {
  const reasons: string[] = [];
  let riskScore = 0;
  let rejected = false;

  if (!code || code.trim().length === 0) {
    return { allowed: false, reasons: ["コードが空です"], riskScore: 100 };
  }

  const bytes = new TextEncoder().encode(code).byteLength;
  if (bytes > PLUGIN_CODE_MAX_BYTES) {
    reasons.push(
      `コードサイズが上限（${Math.floor(PLUGIN_CODE_MAX_BYTES / 1024)}KB）を超えています（${Math.ceil(bytes / 1024)}KB）`,
    );
    rejected = true;
    riskScore = 100;
  }

  for (const rule of RULES) {
    const match = rule.pattern.exec(code);
    if (!match) continue;
    const line = lineOf(code, match.index);
    const label = rule.severity === "reject" ? "禁止" : "警告";
    reasons.push(`${label}: ${rule.reason}（${line}行目付近）`);
    riskScore += rule.score;
    if (rule.severity === "reject") rejected = true;
  }

  const longestLine = code.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
  if (longestLine > LONG_LINE_CHARS) {
    reasons.push(`警告: 1 行が ${LONG_LINE_CHARS} 文字を超えています（難読化の疑い）`);
    riskScore += 10;
  }

  // 著しいコード欠損（括弧の明らかな不均衡）は警告（構文検査は実行時に行う）
  const balance = (open: string, close: string) =>
    code.split(open).length - code.split(close).length;
  if (Math.abs(balance("{", "}")) > 0) {
    reasons.push("警告: 波括弧の対応が取れていません（構文エラーの可能性）");
    riskScore += 5;
  }

  if (reasons.length === 0) {
    reasons.push("静的検査に問題はありません");
  }

  return {
    allowed: !rejected,
    reasons: reasons.map((reason) => truncate(reason, 300)),
    riskScore: Math.min(100, riskScore),
  };
}
