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

export interface ParsedName {
  /** コマンドを除去した素の名前 */
  name: string;
  /** 使用されたコマンド（重複なし） */
  commands: NameCommand[];
  /** `!random` 等により sage が強制されるか */
  forceSage: boolean;
  /** AA（等幅）表示 */
  aa: boolean;
}

/** 名前欄のコマンドを解釈する（`!ninja` 等はサーバ側で名前へ付加する）。 */
export function parseNameCommands(rawName: string): ParsedName {
  const commands: NameCommand[] = [];
  let name = rawName;
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