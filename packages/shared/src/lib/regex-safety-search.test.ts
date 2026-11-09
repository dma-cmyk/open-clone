// ReDoS 判定の自動探索テスト（報告書 24 第3回 M-3 / CI 安定化）。
// 小さな部品から決定的な乱数シードで正規表現を生成し、`analyzeRegexPattern` が安全と
// 判定したものすべてについて、入力長を 2 倍にしたときの実行時間の伸びを調べる。
// マシンの絶対速度には依存せず、指数的な爆発（2 乗を大きく超える伸び）だけを失敗にする。
// 2 乗の伸びは通常の正規表現にもあるため許容し、表示側の本文長・スレ合計時間の上限で抑える。

import { describe, expect, it } from "vitest";
import { analyzeRegexPattern } from "./regex-safety";

/** 決定的な乱数（mulberry32）。同じシードなら生成列は常に同じ。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ATOMS = ["a", "b", "\\w", "\\d", "[ab]", "[a-z]", "."];
const QUANTIFIERS = ["", "?", "+", "*", "{1,3}", "{2}", "{2,}", "{0,2}"];
const LOOKAROUNDS = ["(?=a)", "(?!b)", "(?=a+)", "(?=(a+))", "(?<=\\w)", "(?<!a)", "(?=a+[ab])"];
const ALTERNATIONS = [
  "(?:a|ab)",
  "(?:a|aa)",
  "(?:a|b)",
  "(?:ab|ac)",
  "(?:a|\\w)",
  "(?:\\d|1)",
  "(?:a|[ab])",
  "(?:[ab]|a)",
  "(?:a|[a-z])",
  "(?:a|[^x])",
  "(?:\\d|[0-9])",
  "(?:\\w|_)",
  "(?:\\d|\\D)",
  "(?:\\w|\\W)",
  "(?:\\s|\\S)",
];
const REPEAT_QUANTIFIERS = ["+", "*", "{1,3}", "{2,}", "{2}", "{0,3}"];

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function atomPart(random: () => number): string {
  const roll = random();
  if (roll < 0.15) return pick(random, LOOKAROUNDS);
  if (roll < 0.3) return `${pick(random, ALTERNATIONS)}${pick(random, QUANTIFIERS)}`;
  if (roll < 0.45) return `(?:${pick(random, ATOMS)}${pick(random, QUANTIFIERS)})`;
  return `${pick(random, ATOMS)}${pick(random, QUANTIFIERS)}`;
}

function body(random: () => number): string {
  const count = 1 + Math.floor(random() * 3);
  let result = "";
  for (let index = 0; index < count; index += 1) result += atomPart(random);
  return result;
}

function generatePattern(random: () => number): string {
  const roll = random();
  let core: string;
  if (roll < 0.7) {
    core = `(${body(random)})${pick(random, REPEAT_QUANTIFIERS)}`;
  } else if (roll < 0.85) {
    core = `(?:${body(random)})`;
  } else {
    core = body(random);
  }
  const prefix = random() < 0.5 ? pick(random, ATOMS) : "";
  const suffix = random() < 0.5 ? pick(random, ["x", "!", "b", ""]) : "";
  return `${prefix}${core}${suffix}`;
}

const BASE_LENGTH = 1_000;

/** 入力長 n と 2n の組（末尾に失敗させる文字を置き、バックトラックを誘発する）。 */
function growthInputs(): [string, string][] {
  const n = BASE_LENGTH;
  return [
    [`${"a".repeat(n)}!`, `${"a".repeat(n * 2)}!`],
    [`${"ab".repeat(n / 2)}!`, `${"ab".repeat(n)}!`],
  ];
}

/**
 * 入力を最後まで走査したときの合計時間を測る（空マッチは手動で進める）。
 * JIT の影響を除くため 1 回ウォームアップし、GC・スケジューリングの揺れを避けるため
 * 3 回測って小さい方を使う。
 */
function totalExecMs(regex: RegExp, input: string, maxSteps = 2_000): number {
  const scan = (): number => {
    regex.lastIndex = 0;
    const started = performance.now();
    for (let step = 0; step < maxSteps; step += 1) {
      const match = regex.exec(input);
      if (!match) break;
      if (match[0].length === 0) regex.lastIndex += 1;
    }
    return performance.now() - started;
  };
  scan();
  return Math.min(scan(), scan(), scan());
}

/**
 * マシンの絶対速度に依存しない判定。
 * - 入力長 2 倍で 20 倍（+10ms のノイズ許容）を超える伸びは指数的とみなす。
 *   2 乗は約 4 倍、3 乗は約 8 倍なので通り、指数的な爆発だけを検出する。
 * - 併せて 1 測定 250ms の上限を置く。比が小さくなるほど遅い形（両方とも遅い）を
 *   検出するための保険で、CI の遅いマシンでも通常の多項式形（2,000 文字で数十ms）は通る。
 */
const GROWTH_LIMIT = 20;
const FLOOR_MS = 10;
const SLOW_CAP_MS = 250;

function assertNoExponentialGrowth(pattern: string): void {
  const regex = new RegExp(pattern, "g");
  for (const [small, large] of growthInputs()) {
    const smallMs = totalExecMs(regex, small);
    const largeMs = totalExecMs(regex, large);
    if (smallMs > SLOW_CAP_MS || largeMs > SLOW_CAP_MS) {
      throw new Error(
        `safe 判定なのに遅い: ${pattern} (${small.length}文字 ${smallMs.toFixed(1)}ms / ${large.length}文字 ${largeMs.toFixed(1)}ms)`,
      );
    }
    if (largeMs > smallMs * GROWTH_LIMIT + FLOOR_MS) {
      throw new Error(
        `指数的な伸び: ${pattern} (${small.length}文字 ${smallMs.toFixed(2)}ms -> ${large.length}文字 ${largeMs.toFixed(2)}ms)`,
      );
    }
  }
}

describe("analyzeRegexPattern（自動探索）", () => {
  it(
    "safe 判定のパターンは入力長 2 倍で指数的に伸びない",
    { timeout: 60_000 },
    () => {
      let safeCount = 0;
      let unsafeCount = 0;

      for (const seed of [0x5ecf_1234, 0x1234_abcd, 0x0bad_f00d, 0x0dd_ba11, 0x7e57_1234]) {
        const random = mulberry32(seed);
        for (let generated = 0; generated < 1_500; generated += 1) {
          const pattern = generatePattern(random);
          const safety = analyzeRegexPattern(pattern);
          if (!safety.safe) {
            unsafeCount += 1;
            continue;
          }
          try {
            new RegExp(pattern, "g");
          } catch {
            continue;
          }
          safeCount += 1;
          assertNoExponentialGrowth(pattern);
        }
      }

      // 生成列が「拒否される形」と「安全な形」の両方を含むことを確認する。
      expect(safeCount).toBeGreaterThan(100);
      expect(unsafeCount).toBeGreaterThan(100);
    },
  );

  it("2 乗の伸び（\\w((?:a|b)){2,}b）は安全判定のまま許容する", () => {
    const pattern = "\\w((?:a|b)){2,}b";
    expect(analyzeRegexPattern(pattern).safe).toBe(true);
    assertNoExponentialGrowth(pattern);
  });
});