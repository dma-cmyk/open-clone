// プラグインコードの静的検査（DESIGN §7.3 の審査支援）。
// WP5 の AI 審査（`runStaticChecks` 契約）と WP3 の公開申請・エディタのプレビュー検査が呼ぶ。
// 検査は「sandbox 前提のコード品質・意図検出」であり、サンドボックスの安全性は iframe + bridge が担保する。

import {
  analyzeRegexPattern,
  PLUGIN_CODE_MAX_BYTES,
  type PluginManifest,
  type PluginPermission,
  type PluginStaticCheckResult,
} from "shared";

export type StaticCheckResult = PluginStaticCheckResult;

/**
 * コードが実際に使いそうな RPC と permission 宣言の突き合わせ（審査の補助）。
 * `POST /v1/plugins/preview-check` と `/mcp-plugin` の `authoring.check` が共有する。
 */
export function manifestPermissionWarnings(manifest: PluginManifest, code: string): string[] {
  const warnings: string[] = [];
  const checks: { needle: string; permission: PluginPermission; label: string }[] = [
    { needle: "net.fetch", permission: "net:fetch", label: "net.fetch" },
    { needle: "storage.set", permission: "storage:shared", label: "storage.set" },
    { needle: "storage.get", permission: "storage:shared", label: "storage.get" },
    { needle: "data.post.create", permission: "data:write:post", label: "data.post.create" },
    { needle: "github.gist", permission: "github:gist", label: "github.gist" },
    { needle: "github.repo", permission: "github:repo", label: "github.repo" },
    { needle: "upload.start", permission: "upload:start", label: "upload.start" },
    { needle: "ai.complete", permission: "ai:complete", label: "ai.complete" },
    { needle: "events.subscribe", permission: "events:subscribe", label: "events.subscribe" },
  ];
  for (const check of checks) {
    if (code.includes(check.needle) && !manifest.permissions.includes(check.permission)) {
      warnings.push(`${check.label} を呼んでいますが ${check.permission} 権限が宣言されていません`);
    }
  }
  return warnings;
}

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
 * 文字列・テンプレート・コメント・正規表現リテラルの外側にある
 * Unicode エスケープ（`\uXXXX` / `\u{...}`）の位置を返す（M-2）。
 *
 * JavaScript の識別子は `\uXXXX` 表記を許すため、`\u0065val` は `eval` と同じ意味になる。
 * テキスト走査の RULES は表記の違いを区別できないので、字句の文脈を見て
 * 「識別子の位置」にあるエスケープだけを拒否する。文字列・テンプレート内の
 * JSON データ（`jsonLiteral` が生成する `\u0065val` など）は許可する。
 *
 * パーサーは使わない小さな走査で、次の状態だけを追う:
 * - code: 通常のコード。`${...}` の中はここに戻る
 * - template: テンプレートリテラルの生テキスト
 * 正規表現リテラルか除算かは直前の有意なトークンで判定する（取り違えても
 * 誤検出側に倒れるよう、式を終えるトークンの後は除算とみなす）。
 */
function findIdentifierUnicodeEscapes(code: string): number[] {
  const hits: number[] = [];
  const len = code.length;
  type Frame = { kind: "code"; braceDepth: number } | { kind: "template" };
  const stack: Frame[] = [{ kind: "code", braceDepth: 0 }];
  // "value" = 式を終えるトークン（識別子・数値・文字列・`)` `]` `}`）。
  // "operator" = それ以外（演算子・`(`・`,`・キーワード）。
  let previous: "none" | "value" | "operator" = "none";
  let i = 0;

  const REGEX_PRECEDING_KEYWORDS: Record<string, true> = {
    return: true,
    typeof: true,
    instanceof: true,
    in: true,
    of: true,
    new: true,
    delete: true,
    void: true,
    throw: true,
    case: true,
    do: true,
    else: true,
    yield: true,
    await: true,
  };

  const skipString = (start: number): number => {
    const quote = code[start]!;
    let j = start + 1;
    while (j < len) {
      const ch = code[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === quote) return j + 1;
      if (ch === "\n") return j;
      j++;
    }
    return j;
  };

  const skipRegex = (start: number): number => {
    let j = start + 1;
    let inClass = false;
    while (j < len) {
      const ch = code[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "[") {
        inClass = true;
      } else if (ch === "]") {
        inClass = false;
      } else if (ch === "/" && !inClass) {
        j++;
        while (j < len && /[A-Za-z]/.test(code[j]!)) j++;
        return j;
      } else if (ch === "\n") {
        return j;
      }
      j++;
    }
    return j;
  };

  while (i < len) {
    const frame = stack[stack.length - 1]!;
    const ch = code[i]!;

    if (frame.kind === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        previous = "value";
        i++;
        continue;
      }
      if (ch === "$" && code[i + 1] === "{") {
        stack.push({ kind: "code", braceDepth: 0 });
        previous = "operator";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i + 2);
      i = end === -1 ? len : end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = skipString(i);
      previous = "value";
      continue;
    }
    if (ch === "`") {
      stack.push({ kind: "template" });
      previous = "value";
      i++;
      continue;
    }
    if (ch === "/") {
      if (previous === "none" || previous === "operator") {
        i = skipRegex(i);
        previous = "value";
      } else {
        previous = "operator";
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      if (code[i + 1] === "u") hits.push(i);
      if (code[i + 1] === "u" && code[i + 2] === "{") {
        const end = code.indexOf("}", i + 3);
        i = end === -1 ? len : end + 1;
      } else if (code[i + 1] === "u") {
        i = Math.min(len, i + 6);
      } else if (code[i + 1] === "x") {
        i = Math.min(len, i + 4);
      } else {
        i = Math.min(len, i + 2);
      }
      previous = "value";
      continue;
    }
    if (ch === "{") {
      frame.braceDepth++;
      previous = "operator";
      i++;
      continue;
    }
    if (ch === "}") {
      if (frame.braceDepth === 0 && stack.length > 1) {
        stack.pop();
        previous = "operator";
      } else {
        frame.braceDepth = Math.max(0, frame.braceDepth - 1);
        previous = "value";
      }
      i++;
      continue;
    }
    if (ch === ")") {
      previous = "value";
      i++;
      continue;
    }
    if (ch === "]") {
      previous = "value";
      i++;
      continue;
    }
    if (ch === "+" || ch === "-") {
      if (code[i + 1] === ch && previous === "value") {
        // 後置の ++ / -- は式を終える。続く `/` は除算として扱う。
        previous = "value";
        i += 2;
      } else {
        previous = "operator";
        i++;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$]/.test(code[j]!)) j++;
      const word = code.slice(i, j);
      previous = REGEX_PRECEDING_KEYWORDS[word] ? "operator" : "value";
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[0-9A-Za-z_.]/.test(code[j]!)) j++;
      previous = "value";
      i = j;
      continue;
    }
    previous = "operator";
    i++;
  }

  return hits;
}

/**
 * プラグインコードの静的検査。
 * - `allowed=false` は公開不可（reject ルール該当 or サイズ超過 or 空）
 * - `riskScore` は 0–100（高いほど審査で要注意）
 *
 * `manifest` を渡すと宣言的レンダー規則（`render.post`）も検査する。規則は閲覧者の
 * ブラウザで実行されるため、破滅的バックトラックを起こす正規表現はここで拒否する（M-1）。
 */
export async function runStaticChecks(code: string, manifest?: PluginManifest | null): Promise<StaticCheckResult> {
  const reasons: string[] = [];
  let riskScore = 0;
  let rejected = false;

  if (!code || code.trim().length === 0) {
    return { allowed: false, reasons: ["コードが空です"], riskScore: 100 };
  }

  const renderRules = manifest?.render?.post ?? [];
  renderRules.forEach((rule, index) => {
    const safety = analyzeRegexPattern(rule.pattern, rule.flags);
    if (safety.safe) return;
    reasons.push(`禁止: render.post[${index}] の正規表現が危険です（${safety.reason}）`);
    riskScore += 40;
    rejected = true;
  });

  const bytes = new TextEncoder().encode(code).byteLength;
  if (bytes > PLUGIN_CODE_MAX_BYTES) {
    reasons.push(
      `コードサイズが上限（${Math.floor(PLUGIN_CODE_MAX_BYTES / 1024)}KB）を超えています（${Math.ceil(bytes / 1024)}KB）`,
    );
    rejected = true;
    riskScore = 100;
  }

  // 識別子の位置の Unicode エスケープは、RULES のテキスト走査をすり抜けたまま
  // 禁止 API（`eval` 等）を呼べるため、字句を見て拒否する（M-2）。
  const unicodeEscapeLines = [
    ...new Set(findIdentifierUnicodeEscapes(code).map((index) => lineOf(code, index))),
  ];
  for (const line of unicodeEscapeLines.slice(0, 10)) {
    reasons.push(
      `禁止: 識別子の位置で Unicode エスケープ（\\uXXXX / \\u{...}）を使うことはできません（${line}行目付近）`,
    );
    riskScore += 35;
  }
  if (unicodeEscapeLines.length > 10) {
    reasons.push(`禁止: 識別子の位置の Unicode エスケープがほかに ${unicodeEscapeLines.length - 10} 行あります`);
  }
  if (unicodeEscapeLines.length > 0) rejected = true;

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
