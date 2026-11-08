// RFC 6238 TOTP（SHA-1 / 6桁 / 30秒）。WebCrypto HMAC のみを使用する。
// RFC 4226 の動的切捨てと RFC 6238 Appendix B のベクタを lib/totp.test.ts で検証する。

import { asBufferSource, randomHex, toBase32 } from "./hmac";

export interface TotpOptions {
  /** 時間窓（秒）。既定 30 */
  period?: number;
  /** 出力桁数。既定 6（RFC ベクタ確認用に 8 も可） */
  digits?: number;
  /** Unix epoch からの時刻（秒）。省略時は現在時刻 */
  time?: number;
}

export interface TotpVerifyOptions extends TotpOptions {
  /** 許容する前後の窓数。既定 1 */
  window?: number;
}

const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;

/** 時刻からカウンタ値（floor(time / period)）を返す。 */
export function totpCounter(time: number, period = DEFAULT_PERIOD): number {
  return Math.floor(time / period);
}

async function hotp(secret: Uint8Array, counter: number, digits: number): Promise<string> {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError("Invalid HOTP counter");
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new RangeError("Invalid HOTP digits");

  const key = await crypto.subtle.importKey(
    "raw",
    asBufferSource(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );

  const counterBytes = new Uint8Array(8);
  const view = new DataView(counterBytes.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32), false);
  view.setUint32(4, counter >>> 0, false);

  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));
  const offset = digest[19]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  const modulo = 10 ** digits;
  return String(binary % modulo).padStart(digits, "0");
}

/** Base32 secret（`=`` padding・空白・ハイフンを許容）から TOTP コードを生成する。 */
export async function generateTotp(secretBase32: string, options: TotpOptions = {}): Promise<string> {
  const period = options.period ?? DEFAULT_PERIOD;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const time = options.time ?? Math.floor(Date.now() / 1000);
  const secret = decodeTotpSecret(secretBase32);
  return hotp(secret, totpCounter(time, period), digits);
}

/**
 * TOTP コードを定数時間比較で検証し、一致したカウンタ（タイムステップ）を返す。
 * 一致なしは null。全窓を計算してから結果を返し、一致した窓の位置を時間側路に出さない。
 *
 * 呼び出し側は同じカウンタの再利用を拒否できる（RFC 6238 §5.2 / M-4）。
 */
export async function verifyTotpStep(
  secretBase32: string,
  code: string,
  options: TotpVerifyOptions = {},
): Promise<number | null> {
  const period = options.period ?? DEFAULT_PERIOD;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const time = options.time ?? Math.floor(Date.now() / 1000);
  const window = options.window ?? 1;
  const secret = decodeTotpSecret(secretBase32);
  const counter = totpCounter(time, period);
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;

  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset++) {
    if (counter + offset < 0) continue;
    const expected = await hotp(secret, counter + offset, digits);
    if (timingSafeStringEqual(expected, code) && matched === null) matched = counter + offset;
  }
  return matched;
}

/** TOTP コードを定数時間比較で検証する。 `window` は前後に許容する時間窓数。 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  options: TotpVerifyOptions = {},
): Promise<boolean> {
  return (await verifyTotpStep(secretBase32, code, options)) !== null;
}

/** 160 bit の Base32 secret を新規生成する（QR 登録用）。 */
export function generateTotpSecret(): string {
  return toBase32(randomBytes(20));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function decodeTotpSecret(secretBase32: string): Uint8Array {
  const normalized = secretBase32.toUpperCase().replaceAll(/[=\s-]/g, "");
  if (normalized.length === 0 || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new TypeError("TOTP secret must be non-empty Base32");
  }
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface OtpAuthUriOptions {
  accountName: string;
  issuer?: string;
  period?: number;
  digits?: number;
}

/** QR 登録用の `otpauth://` URI を生成する。 */
export function buildOtpAuthUri(secretBase32: string, options: OtpAuthUriOptions): string {
  const issuer = options.issuer ?? "OpenClone";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(options.accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(options.digits ?? DEFAULT_DIGITS),
    period: String(options.period ?? DEFAULT_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** リカバリーコードの表示用文字列（安全な乱数 16byte を区切り付き hex で返す）。 */
export function generateRecoveryCode(): string {
  const hex = randomHex(12).toUpperCase();
  return `${hex.slice(0, 6)}-${hex.slice(6, 12)}-${hex.slice(12, 18)}-${hex.slice(18, 24)}`;
}
