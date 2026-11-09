// 宣言的レンダー規則の正規表現をメインスレッド外で実行する Worker（報告書 24 第4回 M-4）。
//
// バンドラの Worker チャンク生成に依存しないよう、Worker のコードは**自己完結した関数**を
// 文字列化して Blob URL で起動する（CSP は `worker-src 'self' blob:` を許可済み）。
// `new Worker(new URL(..., import.meta.url))` は Turbopack の静的エクスポートで生の .ts を
// アセットとして複製するだけで、ブラウザでは動かない（実測）。
//
// - 1 規則を実行する直前に `rule-start` を送る。メインスレッドはそれを合図に時間制限を
//   開始し、超えたら `terminate()` する（実行中の exec は中断できないため）。
// - 結果は HTML ではなく断片（text/rule の区間）だけを返す。
// - 静的判定はメインスレッド（render-worker-client）が送信前に済ませる。ここでは
//   規則ごとの 50ms・500 マッチ上限だけを持つ（未知の形に対する保険）。
// - スレ全体の予算はメインスレッド側が管理する。

import type { RenderWorkerRequest, RenderWorkerResponse } from "./render-worker-types";

/**
 * Worker の本体。モジュールスコープの値は一切参照しない（`toString()` で文字列化するため）。
 * 型注釈はコンパイル時に消えるので、Worker に渡るのは素の JavaScript になる。
 */
function renderWorkerMain(): void {
  const MAX_RULES = 20;
  const MAX_TEXT_CHARS = 2_048;
  const MAX_MATCHES = 500;
  const RULE_BUDGET_MS = 50;
  const ALLOWED_FLAGS: Record<string, true> = { g: true, i: true, m: true, s: true, u: true };

  type WorkerSegment = { type: "text"; text: string } | { type: "rule"; kind: string; text: string };

  interface Scope {
    onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
    postMessage: (message: RenderWorkerResponse) => void;
  }

  const scope = self as unknown as Scope;

  // Worker インスタンス内で上限に達した規則を記憶し、以降のレスで再実行しない。
  const disabled: Record<string, true> = {};
  const ruleKey = (pattern: string, flags: string): string => `${pattern}\u0000${flags}`;

  const normalizeFlags = (flags: unknown): string => {
    const result: string[] = [];
    if (typeof flags === "string") {
      for (let i = 0; i < flags.length; i += 1) {
        const flag = flags[i]!;
        if (ALLOWED_FLAGS[flag] && result.indexOf(flag) < 0) result.push(flag);
      }
    }
    return result.join("");
  };

  /** 1 規則を 1 テキスト断片へ適用する。上限超過なら null（その規則を諦める）。 */
  const splitMatches = (
    text: string,
    regex: RegExp,
    kind: string,
    template: string,
    started: number,
  ): WorkerSegment[] | null => {
    const parts: WorkerSegment[] = [];
    let cursor = 0;
    let found = false;
    let matches = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches += 1;
      if (matches > MAX_MATCHES || performance.now() - started > RULE_BUDGET_MS) return null;
      found = true;
      const index = match.index;
      if (index > cursor) parts.push({ type: "text", text: text.slice(cursor, index) });
      const rendered = template.replace(/\$(\d)/g, (_matched: string, digit: string) => {
        const capture = match ? match[Number(digit)] : undefined;
        return typeof capture === "string" ? capture : "";
      });
      parts.push({ type: "rule", kind, text: rendered });
      cursor = index + match[0].length;
      // 空マッチだと lastIndex が進まないため手動で進める。
      if (match[0].length === 0) regex.lastIndex += 1;
    }
    if (!found) return [{ type: "text", text }];
    if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
    return parts;
  };

  scope.onmessage = (event) => {
    const data = event.data;
    if (!data || typeof data.id !== "number") return;
    const text = typeof data.text === "string" ? data.text : "";
    if (text.length > MAX_TEXT_CHARS) {
      scope.postMessage({ type: "done", id: data.id, segments: [{ type: "text", text }] });
      return;
    }
    const rules = Array.isArray(data.rules) ? data.rules.slice(0, MAX_RULES) : [];
    let segments: WorkerSegment[] = [{ type: "text", text }];

    for (let index = 0; index < rules.length; index += 1) {
      scope.postMessage({ type: "rule-start", id: data.id, index });
      const rule = rules[index];
      if (!rule || typeof rule.pattern !== "string") continue;
      const key = ruleKey(rule.pattern, normalizeFlags(rule.flags));
      if (disabled[key]) continue;
      let regex: RegExp;
      try {
        const flags = normalizeFlags(rule.flags);
        regex = new RegExp(rule.pattern, flags.indexOf("g") >= 0 ? flags : `${flags}g`);
      } catch {
        continue;
      }
      const kind = typeof rule.kind === "string" ? rule.kind : "text";
      const template = typeof rule.template === "string" ? rule.template : "";
      const started = performance.now();
      const next: WorkerSegment[] = [];
      let aborted = false;
      for (let s = 0; s < segments.length; s += 1) {
        const segment = segments[s]!;
        if (segment.type === "rule") {
          next.push(segment);
          continue;
        }
        const result = splitMatches(segment.text, regex, kind, template, started);
        if (result === null) {
          aborted = true;
          break;
        }
        for (let k = 0; k < result.length; k += 1) next.push(result[k]!);
      }
      // 中断した規則は捨て、以前の断片のまま次の規則へ進む（メインスレッド版と同じ）。
      // 同じ Worker インスタンスでは以降も実行しない。
      if (aborted) disabled[key] = true;
      else segments = next;
    }

    scope.postMessage({ type: "done", id: data.id, segments });
  };
}

/** Blob URL で起動する Worker のソース。 */
export const RENDER_WORKER_SOURCE = `(${renderWorkerMain.toString()})();`;