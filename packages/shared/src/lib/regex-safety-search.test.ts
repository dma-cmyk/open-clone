// ReDoS 判定の自動探索テスト（報告書 24 第3回 M-3）。
// 小さな部品から決定的な乱数シードで正規表現を生成し、`analyzeRegexPattern` が安全と
// 判定したものすべてについて、悪意ある入力で exec が 50ms 以内に終わることを検証する。
// 安全判定なのに遅いものが 1 つでもあれば失敗する。

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
const ALTERNATIONS = ["(?:a|ab)", "(?:a|aa)", "(?:a|b)", "(?:ab|ac)"];
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

const MALICIOUS_INPUTS = [
  `${"a".repeat(3_000)}!`,
  `${"ab".repeat(1_500)}!`,
  `${"a".repeat(1_500)}b${"a".repeat(1_499)}!`,
  `${"a".repeat(3_000)}b`,
];

describe("analyzeRegexPattern（自動探索）", () => {
  it(
    "safe 判定のパターンは悪意ある入力でも exec が 50ms を超えない",
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

          let regex: RegExp;
          try {
            regex = new RegExp(pattern, "g");
          } catch {
            continue;
          }
          safeCount += 1;

          for (const input of MALICIOUS_INPUTS) {
            regex.lastIndex = 0;
            for (let step = 0; step < 2_000; step += 1) {
              const started = performance.now();
              const match = regex.exec(input);
              const elapsed = performance.now() - started;
              if (elapsed >= 50) {
                throw new Error(`safe 判定のパターンが遅い: ${pattern} (len=${input.length}, ${elapsed.toFixed(1)}ms)`);
              }
              if (!match) break;
              // 空マッチでも進める（無限ループ防止）。
              if (match[0].length === 0) regex.lastIndex += 1;
            }
          }
        }
      }

      // 生成列が「拒否される形」と「安全な形」の両方を含むことを確認する。
      expect(safeCount).toBeGreaterThan(100);
      expect(unsafeCount).toBeGreaterThan(100);
    },
  );
});