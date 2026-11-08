// E2E 用の TOTP 計算（RFC 6238 / SHA-1 / 6桁 / 30秒）。
// サーバ実装（packages/shared/src/lib/totp.ts）と独立に、仕様どおり HMAC を計算して UI を操作する。

import { createHmac } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 指定時刻（既定は現在）の TOTP コード。 */
export function totpCode(secret: string, timeMs = Date.now()): string {
  const counter = Math.floor(timeMs / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * 30 秒境界の直前に発行すると検証側（±1窓）でも通るが、テストの安定性のため
 * 残り 2 秒未満なら次の周期まで待ってからコードを返す。
 */
export async function stableTotpCode(secret: string): Promise<string> {
  const now = Date.now();
  const remaining = 30_000 - (now % 30_000);
  if (remaining < 2_000) {
    await sleep(remaining + 200);
  }
  return totpCode(secret);
}

/** 画面に表示された secret（大文字 base32）を拾う。 */
export function isBase32Secret(value: string): boolean {
  return /^[A-Z2-7]{16,64}$/.test(value.trim());
}