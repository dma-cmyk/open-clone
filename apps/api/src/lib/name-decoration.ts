// 名前欄コマンドの表示（`!random` / `!kuji` / `!dama` / `!NdM`）。
// 乱数はサーバーの `crypto.getRandomValues` だけを使い、出目はクライアントから受け取らない。
// pipeline から切り離した純関数にして、単体テスト（範囲・偏り・長い名前・偽装）から直接呼べるようにする。

import type { NameDice } from "shared";

export const DEFAULT_NAME = "名無しさん";

/** 表示名の上限。切るのは利用者が書いた名前だけで、サーバーが付ける出目などは切らない。 */
export const NAME_MAX_CHARS = 64;

const OMIKUJI = ["大吉", "中吉", "小吉", "吉", "末吉", "凶", "大凶"] as const;

/**
 * 0 以上 `maxExclusive` 未満の一様乱数（棄却法）。
 * `value % maxExclusive` だけだと 2^32 が割り切れない範囲で小さい値がわずかに出やすいため、
 * 余りが一様になる上限まで捨てる。
 */
export function randomBelow(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("maxExclusive は正の整数で指定してください");
  }
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]!;
    if (value < limit) return value % maxExclusive;
  }
}

export interface DiceRoll {
  dice: NameDice;
  /** 各サイコロの出目（1〜sides） */
  values: number[];
  total: number;
}

/** `!NdM` の出目をサーバーで振る。 */
export function rollDice(dice: NameDice): DiceRoll {
  const values: number[] = [];
  for (let index = 0; index < dice.count; index += 1) {
    values.push(randomBelow(dice.sides) + 1);
  }
  return { dice, values, total: values.reduce((sum, value) => sum + value, 0) };
}

/** 出目の表示（`【2d6:3+5=8】`、1 個なら合計を省いて `【1d6:4】`）。 */
export function formatDiceResult(roll: DiceRoll): string {
  const label = `${roll.dice.count}d${roll.dice.sides}`;
  const faces = roll.values.join("+");
  return roll.dice.count === 1 ? `【${label}:${faces}】` : `【${label}:${faces}=${roll.total}】`;
}

/**
 * 利用者が名前欄に書いた `【】` を `〔〕` に置き換える。
 * 本物の出目・おみくじは `【…】` で付くので、手書きの `【2d6:6+6=12】` や `【大吉】` は
 * そのままでは本物と同じ見た目になってしまう。名前側の括弧を変えて区別できるようにする。
 */
export function neutralizeNameBrackets(name: string): string {
  return name.replace(/【/g, "〔").replace(/】/g, "〕");
}

/**
 * 名前欄のコマンド適用後の表示名を組み立てる。
 * 乱数（`!random` / `!kuji` / `!dama` / `!NdM`）はここでサーバーが決める。
 */
export function decorateName(
  rawName: string,
  ninjaLv: number,
  commands: readonly string[],
  dice: NameDice | null,
): string {
  const base = neutralizeNameBrackets(rawName).trim();
  const suffixes: string[] = [];
  if (commands.includes("!ninja")) suffixes.push(`(Lv${ninjaLv})`);
  if (commands.includes("!random")) suffixes.push(`(乱数:${randomBelow(101)})`);
  if (commands.includes("!kuji")) suffixes.push(`【${OMIKUJI[randomBelow(OMIKUJI.length)]!}】`);
  if (commands.includes("!dama")) suffixes.push(`(お年玉:${randomBelow(10_001)}円)`);
  if (dice !== null) suffixes.push(formatDiceResult(rollDice(dice)));

  const suffix = suffixes.map((part) => ` ${part}`).join("");
  // 上限で切るのは利用者の名前の側だけ。出目・おみくじの表示は最後まで残す。
  const budget = Math.max(0, NAME_MAX_CHARS - Array.from(suffix).length);
  const userPart = Array.from(base.length > 0 ? base : DEFAULT_NAME)
    .slice(0, budget)
    .join("")
    .trimEnd();
  return `${userPart.length > 0 ? userPart : DEFAULT_NAME}${suffix}`;
}