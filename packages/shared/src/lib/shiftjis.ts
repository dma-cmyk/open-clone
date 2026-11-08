// Shift_JIS（WHATWG 準拠）エンコード/デコード。Workers では TextDecoder が UTF-8 専用のため、
// 事前生成テーブル（lib/shiftjis-table.ts、tools/gen-shiftjis-table.mjs で生成）で変換する。

import { SJIS_TABLE_PACKED } from "./shiftjis-table";

let encodeMap: Map<number, number> | null = null;
let decodeMap: Map<number, number> | null = null;

function init(): void {
  if (encodeMap !== null) return;
  encodeMap = new Map();
  decodeMap = new Map();
  for (let i = 0; i < SJIS_TABLE_PACKED.length; i += 2) {
    const cp = SJIS_TABLE_PACKED.charCodeAt(i);
    const sjis = SJIS_TABLE_PACKED.charCodeAt(i + 1);
    if (!encodeMap.has(cp)) encodeMap.set(cp, sjis);
    if (!decodeMap.has(sjis)) decodeMap.set(sjis, cp);
  }
}

/**
 * 文字列を Shift_JIS バイト列に変換する。
 * 変換できない文字は `fallback`（既定 `?`=0x3F）に置き換える（dat 出力での文字化け防止）。
 */
export function encodeShiftJis(text: string, fallback = 0x3f): Uint8Array {
  init();
  const output: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const code = encodeMap!.get(cp);
    if (code === undefined) {
      output.push(fallback);
    } else if (code <= 0xff) {
      output.push(code);
    } else {
      output.push(code >> 8, code & 0xff);
    }
  }
  return new Uint8Array(output);
}

/** Shift_JIS バイト列を文字列に変換する。未定義バイトは U+FFFD。 */
export function decodeShiftJis(bytes: Uint8Array): string {
  init();
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte <= 0x80 || (byte >= 0xa1 && byte <= 0xdf)) {
      const cp = decodeMap!.get(byte);
      result += cp === undefined ? "" : String.fromCharCode(cp);
    } else if (i + 1 < bytes.length) {
      const code = (byte << 8) | bytes[++i]!;
      const cp = decodeMap!.get(code);
      result += cp === undefined ? "" : String.fromCharCode(cp);
    } else {
      result += "";
    }
  }
  return result;
}

/** Shift_JIS でのバイト数（トリップの 12 バイト切詰め等に使用）。 */
export function shiftJisByteLength(text: string): number {
  return encodeShiftJis(text).length;
}
