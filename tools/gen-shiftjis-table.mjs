// 生成スクリプト（WP0 一回のみ実行。再生成は `node tools/gen-shiftjis-table.mjs`）。
// Node の full-ICU TextDecoder('shift_jis')（WHATWG 準拠）から
// Unicode code point ↔ SJIS コードの双方向対応表を packed string として出力する。
// 出力先: packages/shared/src/lib/shiftjis-table.ts
import { writeFileSync } from "node:fs";

const decoder = new TextDecoder("shift_jis", { fatal: true });
const pairs = []; // [unicodeCp, sjisCode]

const push = (cp, sjis) => pairs.push([cp, sjis]);

// 単バイト: 0x00-0x80（ASCII 相当）、0xA1-0xDF（半角カナ）
for (let byte = 0x00; byte <= 0xff; byte++) {
  try {
    const text = decoder.decode(Uint8Array.of(byte));
    if (text.length === 1 && text !== "") push(text.codePointAt(0), byte);
  } catch {
    // 未定義バイト（0x81-0xA0, 0xF0-0xFF の単独）はスキップ
  }
}

// 二バイト: lead 0x81-0x9F / 0xE0-0xFC × trail 0x40-0x7E / 0x80-0xFC
for (const [leadLo, leadHi] of [[0x81, 0x9f], [0xe0, 0xfc]]) {
  for (let lead = leadLo; lead <= leadHi; lead++) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      try {
        const text = decoder.decode(Uint8Array.of(lead, trail));
        if (text.length === 1 && text !== "") {
          push(text.codePointAt(0), (lead << 8) | trail);
        }
      } catch {
        // 未定義領域
      }
    }
  }
}

// エンコード時は最初に現れた SJIS コードを優先（NEC/IBM 拡張の重複対策）
pairs.sort((a, b) => a[0] - b[0]);
const seen = new Set();
const deduped = pairs.filter(([cp]) => (seen.has(cp) ? false : (seen.add(cp), true)));

// packed: 各エントリ 2 コードユニット（unicodeCp, sjisCode）。両方とも BMP に収まる。
let packed = "";
for (const [cp, sjis] of deduped) {
  if (cp > 0xffff) throw new Error(`cp out of BMP: ${cp.toString(16)}`);
  packed += String.fromCharCode(cp, sjis);
}

const header = `// 自動生成: tools/gen-shiftjis-table.mjs（WHATWG shift_jis）。手編集禁止。
// 2 コードユニット = 1 エントリ（[0]=Unicode code point, [1]=SJIS コード）。
// エントリ数: ${deduped.length}
`;
const body = `export const SJIS_TABLE_PACKED =\n${JSON.stringify(packed)};\n`;
writeFileSync(new URL("../packages/shared/src/lib/shiftjis-table.ts", import.meta.url), header + body);
console.log(`entries: ${deduped.length}, packed chars: ${packed.length}`);
