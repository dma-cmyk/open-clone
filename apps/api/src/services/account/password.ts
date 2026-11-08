// パスワードハッシュ（PBKDF2-SHA256 / 100,000 iter / per-user salt）。
// 反復回数は shared の PBKDF2_ITERATIONS を唯一の正とする（DESIGN §A-1）。

import { asBufferSource, PBKDF2_ITERATIONS, PASSWORD_SALT_BYTES, timingSafeEqual } from "shared";

const ALGORITHM = "pbkdf2-sha256";
const KEY_BITS = 256;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    asBufferSource(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: asBufferSource(salt), iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>` 形式で保存する。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(PASSWORD_SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${ALGORITHM}$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

/**
 * 保存済みハッシュと照合する。`stored` が null でもダミー計算を行い、
 * 存在しないメールへの応答時間を揃える（ユーザー列挙対策）。
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await derive(password, new Uint8Array(PASSWORD_SALT_BYTES), PBKDF2_ITERATIONS);
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  // 保存値が将来引き上げられても Workers の上限を超えないようにする
  const effectiveIterations = Math.min(iterations, PBKDF2_ITERATIONS);
  const salt = base64ToBytes(parts[2]!);
  const expected = parts[3]!;
  const actual = bytesToBase64(await derive(password, salt, effectiveIterations));
  return timingSafeEqual(actual, expected);
}