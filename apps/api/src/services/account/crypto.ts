// 秘密値の AES-GCM 暗号化（TOTP secret 等）。
// ENC_KEY（base64 32byte を想定）から鍵を導出する。鍵が不正長なら SHA-256 で正規化する。

import { asBufferSource, sha256 } from "shared";

const VERSION = "v1";
const IV_BYTES = 12;

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

async function importKey(encKey: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(encKey);
  } catch {
    raw = await sha256(encKey);
  }
  if (raw.length !== 32) raw = await sha256(raw);
  return crypto.subtle.importKey("raw", asBufferSource(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 平文文字列を `v1.<iv b64>.<cipher b64>` 形式に暗号化する。 */
export async function encryptSecret(plaintext: string, encKey: string): Promise<string> {
  const key = await importKey(encKey);
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(iv) },
      key,
      asBufferSource(new TextEncoder().encode(plaintext)),
    ),
  );
  return `${VERSION}.${bytesToBase64(iv)}.${bytesToBase64(cipher)}`;
}

/** `encryptSecret` の逆変換。改ざん・鍵不一致は例外。 */
export async function decryptSecret(payload: string, encKey: string): Promise<string> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error("Invalid encrypted payload");
  const iv = base64ToBytes(parts[1]!);
  const cipher = base64ToBytes(parts[2]!);
  const key = await importKey(encKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asBufferSource(iv) },
    key,
    asBufferSource(cipher),
  );
  return new TextDecoder().decode(plain);
}