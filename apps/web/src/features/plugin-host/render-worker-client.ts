// レンダー規則の Worker 実行クライアント（報告書 24 第4回 M-4）。
//
// 1 リクエストずつ直列に流す。Worker は規則の実行直前に `rule-start` を送り、メインスレッドは
// それを合図に規則ごとの時間制限を開始する。時間切れなら `terminate()` して Worker を作り直し、
// **その規則だけ**をそのページで無効化して残りの規則でやり直す（公式サンプル等の安全な規則は
// 引き続き適用される）。メインスレッドは一度も同期 exec を実行しない。
//
// Worker が起動しない（CSP・バンドル不備）場合は、本文を通常表示する安全側へ倒す。

import { analyzeRegexPattern, type PluginPostRenderRule } from "shared";
import {
  MAX_RENDER_RULES,
  MAX_RENDER_TEXT_CHARS,
  MAX_THREAD_RENDER_BUDGET_MS,
  type PostRenderSegment,
} from "./render-rules";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./render-worker-types";
import { RENDER_WORKER_SOURCE } from "./render-worker";

declare global {
  interface Window {
    /** 開発ビルド専用の Worker 実行統計（e2e の検証用。本番ビルドでは更新されない）。 */
    __ocRenderWorkerStats?: {
      requests: number;
      ruleStarts: number;
      ruleTimeouts: number;
      workerErrors: number;
    };
  }
}

/** 1 規則あたりの実行時間の上限。超えたら Worker を terminate() する。 */
const RULE_TIMEOUT_MS = 200;
/** Worker のロード（バンドル取得・初期化）を待つ上限。規則実行の時間には数えない。 */
const WORKER_START_TIMEOUT_MS = 5_000;
/** 規則の時間切れによるやり直しの上限（規則数以下）。 */
const MAX_RETRIES = 20;

/**
 * テスト専用の静的判定バイパス。開発ビルドで localStorage にフラグがあるときだけ有効。
 * 本番ビルド（NODE_ENV=production）では常に false になり、利用者が切り替えることはできない。
 */
const STATIC_BYPASS_STORAGE_KEY = "oc.e2e.disable-regex-static";

export function staticSafetyBypassAllowed(nodeEnv: string | undefined, stored: string | null): boolean {
  // 厳密に開発ビルドだけ。NODE_ENV が未定義・本番・テストのいずれでも有効にならない。
  return nodeEnv === "development" && stored === "1";
}

/** 開発ビルドだけが更新する観測用カウンタ（本番は定数畳み込みで何もしない）。 */
function recordDevStat(field: "requests" | "ruleStarts" | "ruleTimeouts" | "workerErrors"): void {
  if (process.env.NODE_ENV !== "development") return;
  if (typeof window === "undefined") return;
  const stats = window.__ocRenderWorkerStats ?? {
    requests: 0,
    ruleStarts: 0,
    ruleTimeouts: 0,
    workerErrors: 0,
  };
  stats[field] += 1;
  window.__ocRenderWorkerStats = stats;
}

function staticSafetyDisabled(): boolean {
  // 本番ビルドではこの分岐が定数畳み込みされ、localStorage も読まない。
  if (process.env.NODE_ENV !== "development") return false;
  if (typeof window === "undefined") return false;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STATIC_BYPASS_STORAGE_KEY);
  } catch {
    stored = null;
  }
  return staticSafetyBypassAllowed(process.env.NODE_ENV, stored);
}

interface Task {
  id: number;
  text: string;
  rules: PluginPostRenderRule[];
  resolve: (segments: PostRenderSegment[] | null) => void;
  retries: number;
}

interface ActiveTask extends Task {
  ruleIndex: number | null;
  firstRuleAt: number | null;
}

let worker: Worker | null = null;
let workerUrl: string | null = null;
let workerBroken = false;
let active: ActiveTask | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 1;
let threadBudgetMs = MAX_THREAD_RENDER_BUDGET_MS;
const pending: Task[] = [];
const disabledRuleKeys = new Set<string>();

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function ruleKey(rule: PluginPostRenderRule): string {
  return `${rule.pattern}\u0000${rule.flags ?? ""}`;
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function armTimer(ms: number): void {
  clearTimer();
  timer = setTimeout(handleTimeout, ms);
}

function terminateWorker(): void {
  if (worker) {
    worker.removeEventListener("message", handleMessage);
    worker.removeEventListener("error", handleWorkerError);
    worker.terminate();
    worker = null;
  }
  if (workerUrl !== null) {
    URL.revokeObjectURL(workerUrl);
    workerUrl = null;
  }
  clearTimer();
}

function handleMessage(event: MessageEvent<RenderWorkerResponse>): void {
  const data = event.data;
  if (!active || !data || data.id !== active.id) return;
  if (data.type === "rule-start") {
    active.ruleIndex = data.index;
    if (active.firstRuleAt === null) active.firstRuleAt = now();
    recordDevStat("ruleStarts");
    armTimer(RULE_TIMEOUT_MS);
    return;
  }
  if (data.type === "done") {
    const task = active;
    const elapsed = task.firstRuleAt === null ? 0 : now() - task.firstRuleAt;
    threadBudgetMs -= elapsed;
    clearTimer();
    active = null;
    task.resolve(data.segments);
    drain();
  }
}

function handleWorkerError(): void {
  // 一度でも Worker が壊れたら、そのページでは本文を通常表示する（無限再試行しない）。
  recordDevStat("workerErrors");
  workerBroken = true;
  terminateWorker();
  const task = active;
  active = null;
  task?.resolve(null);
  resolvePending();
}

function handleTimeout(): void {
  const task = active;
  if (!task) return;
  if (task.ruleIndex === null) {
    // Worker が起動しない。以降は通常表示（安全側）。
    workerBroken = true;
    terminateWorker();
    active = null;
    task.resolve(null);
    resolvePending();
    return;
  }

  const elapsed = task.firstRuleAt === null ? 0 : now() - task.firstRuleAt;
  threadBudgetMs -= elapsed;
  const rule = task.rules[task.ruleIndex];
  if (rule) disabledRuleKeys.add(ruleKey(rule));
  recordDevStat("ruleTimeouts");
  terminateWorker();
  active = null;

  // 時間切れの規則だけを外して残りでやり直す。安全な規則（公式サンプル等）は適用される。
  const remaining = task.rules.filter((candidate) => !disabledRuleKeys.has(ruleKey(candidate)));
  if (remaining.length === 0 || task.retries >= MAX_RETRIES) {
    task.resolve(null);
    drain();
    return;
  }
  pending.unshift({ ...task, rules: remaining, retries: task.retries + 1 });
  drain();
}

function resolvePending(): void {
  for (const task of pending.splice(0)) task.resolve(null);
}

function createWorker(): Worker | null {
  // バンドラの Worker チャンク生成に依存しない（静的エクスポートでも動く）。
  // CSP は worker-src 'self' blob: を許可している。
  try {
    const blob = new Blob([RENDER_WORKER_SOURCE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const created = new Worker(url);
    workerUrl = url;
    created.addEventListener("message", handleMessage);
    created.addEventListener("error", handleWorkerError);
    return created;
  } catch {
    if (workerUrl !== null) {
      URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    }
    return null;
  }
}

function drain(): void {
  if (active) return;
  if (workerBroken) {
    resolvePending();
    return;
  }
  const task = pending.shift();
  if (!task) return;
  const current = worker ?? createWorker();
  if (!current) {
    workerBroken = true;
    task.resolve(null);
    resolvePending();
    return;
  }
  worker = current;
  active = { ...task, ruleIndex: null, firstRuleAt: null };
  armTimer(WORKER_START_TIMEOUT_MS);
  const message: RenderWorkerRequest = {
    id: task.id,
    text: task.text,
    rules: task.rules,
  };
  recordDevStat("requests");
  try {
    current.postMessage(message);
  } catch {
    handleWorkerError();
  }
}

/**
 * 本文の変換断片を返す。変換しない場合（規則なし・全て無効・時間切れ・Worker 不在）は null。
 * 呼び出し側は null の間/あと、本文を通常表示する。
 */
export function requestRenderSegments(
  text: string,
  rules: readonly PluginPostRenderRule[],
): Promise<PostRenderSegment[] | null> {
  if (typeof Worker === "undefined") return Promise.resolve(null);
  if (!rules.length || text.length > MAX_RENDER_TEXT_CHARS) return Promise.resolve(null);
  if (workerBroken || threadBudgetMs <= 0) return Promise.resolve(null);
  // 静的判定は送信前（メインスレッド）に済ませる。純粋な構文解析で、長さ上限は 200 文字。
  // テスト専用のバイパスは開発ビルド + localStorage のフラグでのみ有効。
  const bypass = staticSafetyDisabled();
  const allowed = rules.slice(0, MAX_RENDER_RULES).filter((rule) => {
    const key = ruleKey(rule);
    if (disabledRuleKeys.has(key)) return false;
    if (bypass) return true;
    if (!analyzeRegexPattern(rule.pattern, rule.flags ?? "").safe) {
      disabledRuleKeys.add(key);
      return false;
    }
    return true;
  });
  if (allowed.length === 0) return Promise.resolve(null);

  const { promise, resolve } = Promise.withResolvers<PostRenderSegment[] | null>();
  pending.push({ id: nextId, text, rules: allowed, resolve, retries: 0 });
  nextId += 1;
  drain();
  return promise;
}

/** スレ表示を開始するときに、スレ全体の合計予算をリセットする。 */
export function resetThreadRenderBudget(): void {
  threadBudgetMs = MAX_THREAD_RENDER_BUDGET_MS;
}

/** テスト専用: スレ全体の合計予算を差し替える。 */
export function setThreadRenderBudgetForTest(ms: number): void {
  threadBudgetMs = ms;
}

/** テスト専用: Worker・無効化した規則・予算を初期化する。 */
export function resetRenderWorkerForTest(): void {
  terminateWorker();
  workerBroken = false;
  active = null;
  resolvePending();
  disabledRuleKeys.clear();
  threadBudgetMs = MAX_THREAD_RENDER_BUDGET_MS;
}