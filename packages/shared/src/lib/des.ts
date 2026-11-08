// DES crypt(3)（UFC-crypt 相当の純TS実装）と 2ch 互換トリップ（◆+10桁）。
// DES は WebCrypto に存在しないため純粋実装が必要（DESIGN §3.2）。
// テストはシステム crypt(3) 生成のゴールデンベクタで一致を検証する（lib/des.test.ts）。

import { encodeShiftJis } from "./shiftjis";

// --- DES 基本テーブル（FIPS 46-3） ---

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48,
  40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21,
  13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45,
  13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50,
  18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20,
  21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6,
  22, 11, 4, 25,
];

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52,
  44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5,
  28, 20, 12, 4,
];

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31,
  37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

const SBOX: number[][][] = [
  [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
    [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
    [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
    [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  ],
  [
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
    [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
    [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
    [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  ],
  [
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
    [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
    [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
    [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  ],
  [
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
    [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
    [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
    [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  ],
  [
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
    [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
    [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
    [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  ],
  [
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
    [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
    [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
    [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  ],
  [
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
    [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
    [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
    [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  ],
  [
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
    [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
    [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
    [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
  ],
];

const CRYPT_ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function permute(input: number, inBits: number, table: number[]): number {
  let output = 0;
  let inValue = input;
  for (const position of table) {
    const shift = inBits - position;
    const bit = (inValue >>> shift) & 1;
    output = (output << 1) | bit;
    inValue = input >>> 0;
  }
  return output >>> 0;
}

/** JS の >>> は 32bit までなので 64bit は 2×32bit で扱う。input: [hi, lo] */
function permute64(inputHi: number, inputLo: number, table: number[]): [number, number] {
  // table の位置は 1..64（MSB=1）。全テーブルの出力幅は table.length ビット。
  let outHi = 0;
  let outLo = 0;
  const outBits = table.length;
  for (let i = 0; i < outBits; i++) {
    const position = table[i]!;
    const bit = position <= 32 ? (inputHi >>> (32 - position)) & 1 : (inputLo >>> (64 - position)) & 1;
    if (i < outBits - 32) outHi = (outHi << 1) | bit;
    else outLo = (outLo << 1) | bit;
  }
  return [outHi >>> 0, outLo >>> 0];
}

// 48bit サブキー（number。2^48 < 2^53 で正確）
const subkeyList = new Array<number>(16);

function keySchedule(keyBytes: Uint8Array): void {
  // 8 bytes → 56bit key（crypt 準拠: 各バイトの下位7bit）。PC1 を C(28bit)/D(28bit) に直接構成する。
  let c = 0;
  let d = 0;
  for (let i = 0; i < 56; i++) {
    const position = PC1[i]!; // 1..64（key bit、MSB=1）
    const byteIndex = Math.floor((position - 1) / 8);
    const bitIndex = 7 - ((position - 1) % 8);
    const bit = (keyBytes[byteIndex]! >> bitIndex) & 1;
    if (i < 28) c = ((c << 1) | bit) >>> 0;
    else d = ((d << 1) | bit) >>> 0;
  }

  for (let round = 0; round < 16; round++) {
    const shift = SHIFTS[round]!;
    c = ((c << shift) | (c >>> (28 - shift))) & 0x0fffffff;
    d = ((d << shift) | (d >>> (28 - shift))) & 0x0fffffff;
    // C(28bit) || D(28bit) = 56bit に対して PC2（48bit 出力）
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < 48; i++) {
      const position = PC2[i]!; // 1..56
      const bit = position <= 28 ? (c >>> (28 - position)) & 1 : (d >>> (56 - position)) & 1;
      if (i < 16) hi = ((hi << 1) | bit) >>> 0;
      else lo = ((lo << 1) | bit) >>> 0;
    }
    subkeyList[round] = hi * 0x100000000 + lo;
  }
}

function sboxTransform(expanded48: number): number {
  let output = 0;
  for (let box = 0; box < 8; box++) {
    // 48bit の上位から 6bit ずつ取り出す
    const shift = (7 - box) * 6;
    const six = Math.floor(expanded48 / 2 ** shift) & 0x3f;
    const row = ((six & 0x20) >>> 4) | (six & 0x01);
    const col = (six >>> 1) & 0x0f;
    output = output * 16 + SBOX[box]![row]![col]!;
  }
  return output >>> 0;
}

function desRound(left: number, right: number, subkey48: number, saltSwappedE: number[]): [number, number] {
  // E 拡張（32→48）。saltSwappedE は salt 入替済みの位置リスト（1..32 の右辺 bit 位置）。
  let expanded = 0;
  for (let i = 0; i < 48; i++) {
    const position = saltSwappedE[i]!;
    const bit = (right >>> (32 - position)) & 1;
    expanded = expanded * 2 + bit;
  }
  // 48bit XOR は 6bit 単位で行う（number は 53bit まで正確なので安全）
  let xor48 = 0;
  for (let i = 0; i < 8; i++) {
    const shift = (7 - i) * 6;
    const a = Math.floor(expanded / 2 ** shift) & 0x3f;
    const b = Math.floor(subkey48 / 2 ** shift) & 0x3f;
    xor48 += (a ^ b) * 2 ** shift;
  }
  const sOut = sboxTransform(xor48);
  const fOut = permute(sOut, 32, P);
  return [right >>> 0, (left ^ fOut) >>> 0];
}

/**
 * 伝統的な DES crypt(3)。パスワードは最初の 8 文字、salt は 2 文字。
 * 出力は salt2 + ハッシュ11 の 13 文字。
 *
 * 実装メモ（glibc/UFC-crypt との一致をゴールデンベクタで検証済み）:
 * - 鍵: 各文字の 7bit を DES キーバイトの上位7bitに配置（`c << 1`、下位はパリティ）
 * - 本体: 25 回の完全 DES 暗号（各回 IP→16ラウンド（salt 入替 E）→L/R 交換→FP）
 * - 出力: 64bit ブロックから MSB 側へ 6bit ずつ 11 文字（`./0-9A-Za-z`、66bit 目以降は 0）
 */
export function desCrypt(password: string, salt: string): string {
  if (salt.length < 2) throw new RangeError("crypt salt must be 2 characters");

  // salt ビットで E 拡張の位置を入れ替える（crypt(3) 独自）
  const eSwapped = E.slice();
  const saltChars = salt.slice(0, 2);
  for (let i = 0; i < 2; i++) {
    const index = CRYPT_ALPHABET.indexOf(saltChars[i]!);
    if (index < 0) throw new RangeError("crypt salt contains invalid character");
    for (let bit = 0; bit < 6; bit++) {
      if ((index >>> bit) & 1) {
        const tmp = eSwapped[i * 6 + bit]!;
        eSwapped[i * 6 + bit] = eSwapped[i * 6 + bit + 24]!;
        eSwapped[i * 6 + bit + 24] = tmp;
      }
    }
  }

  // 鍵: 先頭 8 文字（各 7bit を上位7bitへ）
  const keyBytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    const char = password.charCodeAt(i);
    keyBytes[i] = ((Number.isNaN(char) ? 0 : char) & 0x7f) << 1;
  }
  keySchedule(keyBytes);

  let hi = 0;
  let lo = 0;
  for (let iteration = 0; iteration < 25; iteration++) {
    const [ipHi, ipLo] = permute64(hi, lo, IP);
    let left = ipHi;
    let right = ipLo;
    for (let round = 0; round < 16; round++) {
      [left, right] = desRound(left, right, subkeyList[round]!, eSwapped);
    }
    [hi, lo] = permute64(right, left, FP);
  }

  // 64bit → MSB 側から 6bit ずつ 11 文字にパッキング（64bit 以降は 0 パディング）
  const bytes = new Uint8Array(8);
  for (const [index, half] of [hi, lo].entries()) {
    bytes[index * 4] = (half >>> 24) & 0xff;
    bytes[index * 4 + 1] = (half >>> 16) & 0xff;
    bytes[index * 4 + 2] = (half >>> 8) & 0xff;
    bytes[index * 4 + 3] = half & 0xff;
  }

  let out = saltChars;
  for (let i = 0; i < 11; i++) {
    let six = 0;
    for (let bit = 0; bit < 6; bit++) {
      const position = i * 6 + bit;
      const value = position < 64 ? (bytes[position >> 3]! >>> (7 - (position & 7))) & 1 : 0;
      six = (six << 1) | value;
    }
    out += CRYPT_ALPHABET[six];
  }
  return out;
}

/** テスト用: 標準 DES（16 ラウンド、salt なし）で 64bit ブロックを暗号化する。 */
export function _desEncryptBlockForTest(
  keyBytes: Uint8Array,
  blockHi: number,
  blockLo: number,
): [number, number] {
  keySchedule(keyBytes);
  const [ipHi, ipLo] = permute64(blockHi, blockLo, IP);
  let left = ipHi;
  let right = ipLo;
  for (let round = 0; round < 16; round++) {
    [left, right] = desRound(left, right, subkeyList[round]!, E);
  }
  return permute64(right, left, FP);
}

// --- 2ch 互換トリップ（DESIGN §5.1 / open2ch.md §3.2） ---

/** salt の無効文字置換（`.`）と tr マッピング（0ch+ 準拠: salt = substr(key."H.", 1, 2)） */
function normalizeSalt(keyBytes: Uint8Array): string {
  let a = keyBytes.length > 1 ? keyBytes[1]! : 0x48; // 'H'
  let b = keyBytes.length > 2 ? keyBytes[2]! : keyBytes.length > 1 ? 0x48 : 0x2e; // 'H' or '.'
  const map = (byte: number): number => {
    if (byte >= 0x3a && byte <= 0x40) return 0x41 + (byte - 0x3a); // : ; < = > ? @ → A-G
    if (byte >= 0x5b && byte <= 0x60) return 0x61 + (byte - 0x5b); // [ \ ] ^ _ ` → a-g
    return byte >= 0x2e && byte <= 0x7a ? byte : 0x2e;
  };
  a = map(a);
  b = map(b);
  return String.fromCharCode(a, b);
}

/**
 * 名前欄 `#key` から 2ch 互換トリップ（`◆` + 10 桁）を生成する。
 * `key` は `#` を除いたキー文字列。SJIS バイト列で先頭 12 バイトに切る。
 */
export function generateTrip(key: string): string {
  const bytes = encodeShiftJis(key).slice(0, 12);
  const salt = normalizeSalt(bytes);
  // crypt のパスワードは 7bit ASCII。SJIS バイト列を 7bit に落とす
  const passwordBytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) passwordBytes[i] = (bytes[i] ?? 0) & 0x7f;
  const password = String.fromCharCode(...passwordBytes);
  const hash = desCrypt(password, salt);
  return `◆${hash.slice(3, 13)}`;
}

/** 名前欄の文字列を `名前` / `トリップ` に分解する（`#` 以降はキー）。 */
export function parseTripName(nameField: string): { name: string; trip: string | null } {
  const hashIndex = nameField.indexOf("#");
  if (hashIndex < 0) return { name: nameField, trip: null };
  const key = nameField.slice(hashIndex + 1);
  if (key.length === 0) return { name: nameField.slice(0, hashIndex), trip: null };
  return { name: nameField.slice(0, hashIndex), trip: generateTrip(key) };
}
