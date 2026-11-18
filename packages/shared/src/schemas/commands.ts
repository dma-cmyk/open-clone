// open2ch コマンド記法の純粋パーサ（shared）。
// DB を知らない純関数のみ。状態遷移（アク禁・副主任免など）は apps/api の lib/commands.ts が行う。

import { z } from "zod";
import { extractAnchorSpec, parseAnchors } from "./anchor";
import { threadTitleFlagsSchema, type ThreadTitleFlags } from "./thread";

/** 名前欄で誰でも使えるコマンド。 */
export const NAME_COMMANDS = ["!ninja", "!random", "!kuji", "!dama", "!AA", "!icon"] as const;
export type NameCommand = (typeof NAME_COMMANDS)[number];

/** 本文（名前欄）でスレ主／副主が使う自治コマンド。 */
export const THREAD_COMMANDS = [
  "!aku",
  "!kaijo",
  "!sub",
  "!cap",
  "!reset",
  "!nopic",
  "!ngk",
  "!jien",
  "!add",
] as const;
export type ThreadCommandName = (typeof THREAD_COMMANDS)[number];

/** 本文コマンドの識別子（`!` を除いた形）。 */
export type ThreadCommandKey = "aku" | "kaijo" | "sub" | "cap" | "reset" | "nopic" | "ngk" | "jien" | "add";

/** スレタイに埋め込む作成時フラグ。 */
export const TITLE_FLAG_COMMANDS = ["!no_id", "!sage", "!oekaki", "!timer", "!live"] as const;

/** 名前欄のサイコロ指定（`!2d6`）。出目はサーバーが振る。 */
export interface NameDice {
  /** 振る個数（1〜10） */
  count: number;
  /** 面の数（2〜1000） */
  sides: number;
}

export const NAME_DICE_COUNT_MIN = 1;
export const NAME_DICE_COUNT_MAX = 10;
export const NAME_DICE_SIDES_MIN = 2;
export const NAME_DICE_SIDES_MAX = 1000;

/** `!NdM`。直後が空白か末尾のときだけコマンドとして扱う（他の名前コマンドと同じ境界）。 */
const NAME_DICE = /!(\d{1,2})d(\d{1,4})(?=\s|$)/g;

export interface ParsedName {
  /** コマンドを除去した素の名前 */
  name: string;
  /** 使用されたコマンド（重複なし） */
  commands: NameCommand[];
  /** `!NdM` の指定（書式外・2 個目以降は無視する） */
  dice: NameDice | null;
  /** `!random` 等により sage が強制されるか */
  forceSage: boolean;
  /** AA（等幅）表示 */
  aa: boolean;
}

/** 名前欄のコマンドを解釈する（`!ninja` 等はサーバ側で名前へ付加する）。 */
export function parseNameCommands(rawName: string): ParsedName {
  const commands: NameCommand[] = [];
  // 1 レスにつき振るのは 1 個だけ。2 個目以降の有効な指定は振らずに名前から取り除く
  // （数字が範囲外の `!0d6` などはコマンドではなく、そのまま名前の文字として残す）。
  const validDice: NameDice[] = [];
  let name = rawName.replace(NAME_DICE, (token: string, countText: string, sidesText: string) => {
    const count = Number(countText);
    const sides = Number(sidesText);
    if (count < NAME_DICE_COUNT_MIN || count > NAME_DICE_COUNT_MAX) return token;
    if (sides < NAME_DICE_SIDES_MIN || sides > NAME_DICE_SIDES_MAX) return token;
    if (validDice.length === 0) validDice.push({ count, sides });
    return " ";
  });
  for (const command of NAME_COMMANDS) {
    const pattern = new RegExp(`${escapeRegExp(command)}(?=\\s|$)`, "gi");
    if (pattern.test(name)) {
      name = name.replace(pattern, " ").trim();
      commands.push(command);
    }
  }
  return {
    name: name.replace(/\s{2,}/g, " ").trim(),
    commands,
    dice: validDice[0] ?? null,
    forceSage: commands.includes("!random"),
    aa: commands.includes("!AA"),
  };
}

export interface ParsedTitle {
  title: string;
  flags: ThreadTitleFlags;
}

/** スレタイの作成時フラグを解釈して除去する（`!maxNNN` は 10〜999 のみ有効）。 */
export function parseTitleFlags(rawTitle: string): ParsedTitle {
  let title = rawTitle;
  const flags = threadTitleFlagsSchema.parse({});

  const maxMatch = /!max(\d{1,4})/i.exec(title);
  if (maxMatch) {
    const value = Number(maxMatch[1]);
    if (value >= 10 && value <= 999) flags.maxPosts = value;
    title = title.replace(maxMatch[0], " ");
  }

  for (const command of TITLE_FLAG_COMMANDS) {
    const pattern = new RegExp(`${escapeRegExp(command)}(?=\\s|$)`, "gi");
    if (pattern.test(title)) {
      title = title.replace(pattern, " ");
      if (command === "!no_id") flags.noId = true;
      if (command === "!sage") flags.sage = true;
      if (command === "!oekaki") flags.oekaki = true;
      if (command === "!timer") flags.timer = true;
      if (command === "!live") flags.live = true;
    }
  }

  return { title: title.replace(/\s{2,}/g, " ").trim(), flags };
}

export interface ParsedBodyCommand {
  name: ThreadCommandKey;
  /** コマンド行の生テキスト */
  line: string;
  /** 同じ行・直前の行から解決した安価のレス番号 */
  anchors: number[];
  /** コマンド引数（`!cap` のキャップ文字列、`!add` の追記本文） */
  arg: string;
}

export interface ParsedBody {
  /** コマンド行を除去した表示本文 */
  body: string;
  commands: ParsedBodyCommand[];
  /** 本文中の安価（最大 5 件） */
  anchors: number[];
}

const COMMAND_LINE = /^\s*!(aku|kaijo|sub|cap|reset|nopic|ngk|jien|add)\b(.*)$/i;

/**
 * 本文を行単位で解釈する。コマンド行は表示本文から除去する。
 * `!aku` / `!kaijo` / `!sub` / `!cap` は同じ行または直前の行の安価を対象にする。
 */
export function parseBodyCommands(rawBody: string): ParsedBody {
  const lines = rawBody.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  const commands: ParsedBodyCommand[] = [];
  let previousLine = "";

  for (const line of lines) {
    const match = COMMAND_LINE.exec(line);
    if (!match) {
      kept.push(line);
      previousLine = line;
      continue;
    }
    const name = match[1]!.toLowerCase() as ThreadCommandKey;
    const remainder = match[2]!.trim();
    let anchors = parseAnchors(remainder);
    if (anchors.length === 0) anchors = parseAnchors(previousLine);
    const arg = name === "cap" || name === "add" ? extractAnchorSpec(remainder).rest : "";
    commands.push({ name, line: line.trim(), anchors, arg });
  }

  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { body, commands, anchors: parseAnchors(body) };
}

/** コマンド文字列を正規表現へ埋め込むためのエスケープ。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** コマンド名の zod enum（テスト・ルートの入力検証用）。 */
export const threadCommandNameSchema = z.enum(THREAD_COMMANDS);
export const threadCommandKeySchema = z.enum(["aku", "kaijo", "sub", "cap", "reset", "nopic", "ngk", "jien", "add"]);