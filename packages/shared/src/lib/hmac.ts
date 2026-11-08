// WebCrypto ベースの共通ヘルパ。Workers/Node 18+ で動作し、秘密情報は Uint8Array として扱う。

const textEncoder = new TextEncoder();

/** 実行時は常に新規確保した ArrayBuffer 由来。TS の ArrayBufferLike 汎化を呼び出し側で解消する。 */
export function asBufferSource(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data as Uint8Array<ArrayBuffer>;
}

export function toHex(bytes: Uint8Array | ArrayBuffer): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError("Invalid hex");
  return new Uint8Array(hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(bytes)));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

export async function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? textEncoder.encode(key) : key;
  const dataBytes = typeof data === "string" ? textEncoder.encode(data) : data;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asBufferSource(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, asBufferSource(dataBytes)));
}

export async function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): Promise<string> {
  return toHex(await hmacSha256(key, data));
}

/** セキュア乱数（hex）。既定 128 bit。 */
export function randomHex(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** セキュア乱数（URL-safe base64）。既定 256 bit。 */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 文字列を一定時間比較する（長さが違う場合は false）。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 Base32（padding なし）。TOTP secret 等に使用。 */
export function toBase32(bytes: Uint8Array): string {
  let result = "";
  let buffer = 0;
  let bits = 0;
  for (const value of bytes) {
    buffer = (buffer << 8) | value;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return result;
}

export function fromBase32(value: string): Uint8Array {
  const normalized = value.toUpperCase().replaceAll(/[=\s-]/g, "");
  if (!/^[A-Z2-7]*$/.test(normalized)) throw new TypeError("Invalid Base32");
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}
