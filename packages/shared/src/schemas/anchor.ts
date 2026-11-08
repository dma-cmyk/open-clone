// 安価（アンカー）の記法パーサと契約。
// `>>n` / `>>n-m` / `>>3,4,8`（最大 5 件）。書込時にレス番号→post id へ解決し backlinks を作る。

import { z } from "zod";

/** 1 レスが参照できる安価の最大件数（open2ch 準拠）。 */
export const ANCHOR_MAX_COUNT = 5;
/** 通報のレス指定で許容する最大件数。 */
export const REPORT_MAX_NUMS = 100;

export const anchorRefSchema = z.object({
  raw: z.string(),
  nums: z.array(z.number().int().positive()),
});
export type AnchorRef = z.infer<typeof anchorRefSchema>;

const ANCHOR_PATTERN = />>\s*(\d{1,4}(?:\s*[-,]\s*\d{1,4})*)/g;

/**
 * 本文中の安価記法を抽出し、レス番号の昇順・重複なし配列を返す。
 * 範囲指定（`>>5-8`）は展開するが、合計 `ANCHOR_MAX_COUNT` 件で打ち切る。
 */
export function parseAnchors(body: string): number[] {
  const nums: number[] = [];
  ANCHOR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANCHOR_PATTERN.exec(body)) !== null) {
    for (const part of match[1]!.split(",")) {
      const trimmed = part.trim();
      const span = /^(\d{1,4})\s*-\s*(\d{1,4})$/.exec(trimmed);
      if (span) {
        const from = Number(span[1]);
        const to = Math.max(from, Number(span[2]));
        for (let num = from; num <= to && nums.length < ANCHOR_MAX_COUNT; num++) {
          if (num > 0 && !nums.includes(num)) nums.push(num);
        }
      } else {
        const num = Number(trimmed);
        if (Number.isInteger(num) && num > 0 && !nums.includes(num) && nums.length < ANCHOR_MAX_COUNT) {
          nums.push(num);
        }
      }
      if (nums.length >= ANCHOR_MAX_COUNT) return nums.sort((a, b) => a - b);
    }
  }
  return nums.sort((a, b) => a - b);
}

/**
 * コマンド行から安価指定を取り出す（`!aku >>5` / `!cap >>3 ▲cap`）。
 * 安価を除いた残り（キャップ文字列など）を `rest` として返す。
 */
export function extractAnchorSpec(text: string): { nums: number[]; rest: string } {
  const nums = parseAnchors(text);
  const rest = text.replace(ANCHOR_PATTERN, " ").replace(/\s{2,}/g, " ").trim();
  return { nums, rest };
}

/**
 * 通報・モデレーションのレス指定（`all` / `1` / `1-3` / `1,3,5`）を解釈する。
 * 範囲は展開せず、呼び出し側が SQL の範囲条件に使える形で返す。
 */
export function parsePostSpec(spec: string): { all: boolean; nums: number[]; ranges: Array<[number, number]> } {
  const value = spec.trim().toLowerCase();
  if (value === "" || value === "all" || value === "全て" || value === "すべて") {
    return { all: true, nums: [], ranges: [] };
  }
  const nums: number[] = [];
  const ranges: Array<[number, number]> = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    const span = /^(\d{1,4})-(\d{1,4})$/.exec(trimmed);
    if (span) {
      const from = Number(span[1]);
      const to = Math.max(from, Number(span[2]));
      if (to - from + 1 <= REPORT_MAX_NUMS) {
        ranges.push([from, to]);
        for (let num = from; num <= to && nums.length < REPORT_MAX_NUMS; num++) nums.push(num);
      }
    } else if (/^\d{1,4}$/.test(trimmed)) {
      const num = Number(trimmed);
      if (num > 0 && nums.length < REPORT_MAX_NUMS) nums.push(num);
    }
  }
  return { all: false, nums: Array.from(new Set(nums)).sort((a, b) => a - b), ranges };
}