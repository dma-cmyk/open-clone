// Crockford Base32 ULID。Workers/Node の両方で動作する（crypto.getRandomValues のみ使用）。

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** 現在時刻・乱数から新規 ULID（26文字、時刻ソート可能）を生成する。 */
export function ulid(time: number = Date.now()): string {
  if (!Number.isFinite(time) || time < 0 || time >= 2 ** 48) {
    throw new RangeError("ULID timestamp must be within 48-bit range");
  }

  let result = "";
  let remaining = Math.floor(time);
  for (let i = 0; i < TIME_LEN; i++) {
    result = ENCODING[remaining % 32] + result;
    remaining = Math.floor(remaining / 32);
  }

  const random = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(random);
  for (const value of random) result += ENCODING[value % 32];
  return result;
}

/** ULID 形式チェック（大文字 Crockford Base32、26文字）。 */
export function isValidUlid(value: string): boolean {
  return /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(value);
}

/** ULID の先頭 10 文字から生成時刻（Unix ms）を復元する。 */
export function ulidTime(value: string): number {
  if (!isValidUlid(value)) throw new TypeError("Invalid ULID");
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) time = time * 32 + ENCODING.indexOf(value[i]!);
  return time;
}
