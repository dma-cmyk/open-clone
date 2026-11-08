// GitHub トークンの AES-256-GCM 暗号化（DESIGN §8）。
// 保存形式: `v1:<iv base64>:<ciphertext+tag base64>`。鍵は Wrangler secret `ENC_KEY`。
// `ENC_KEY` は 32 バイトの base64 / hex を推奨。それ以外の文字列は SHA-256 で鍵導出する（後方互換）。

import { ApiError, ErrorCode, asBufferSource, sha256 } from "shared";
import { base64ToBytes, bytesToBase64 } from "../uploads/util";

const PREFIX = "v1";
const IV_BYTES = 12;

async function importEncryptionKey(keyMaterial: string): Promise<CryptoKey> {
  if (!keyMaterial) {
    throw new ApiError(500, ErrorCode.MISCONFIGURED, "ENC_KEY が設定されていません");
  }

  let raw: Uint8Array | null = null;
  try {
    const decoded = base64ToBytes(keyMaterial);
    if (decoded.byteLength === 32) raw = decoded;
  } catch {
    raw = null;
  }
  if (!raw && /^[0-9a-fA-F]{64}$/.test(keyMaterial)) {
    raw = new Uint8Array(keyMaterial.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
  }
  if (!raw) raw = await sha256(keyMaterial);

  return crypto.subtle.importKey("raw", asBufferSource(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** 平文トークンを暗号化する。 */
export async function encryptSecret(plaintext: string, keyMaterial: string): Promise<string> {
  const key = await importEncryptionKey(keyMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBufferSource(iv), tagLength: 128 },
      key,
      asBufferSource(new TextEncoder().encode(plaintext)),
    ),
  );
  return `${PREFIX}:${bytesToBase64(iv)}:${bytesToBase64(ciphertext)}`;
}

/** 暗号化された文字列を復号する。改竄・破損時は 500（内部情報は出さない）。 */
export async function decryptSecret(stored: string, keyMaterial: string): Promise<string> {
  const [prefix, ivPart, dataPart] = stored.split(":");
  if (prefix !== PREFIX || !ivPart || !dataPart) {
    throw new ApiError(500, ErrorCode.INTERNAL, "保存された認証情報の形式が不正です");
  }
  const key = await importEncryptionKey(keyMaterial);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asBufferSource(base64ToBytes(ivPart)), tagLength: 128 },
      key,
      asBufferSource(base64ToBytes(dataPart)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new ApiError(500, ErrorCode.INTERNAL, "保存された認証情報を復号できませんでした");
  }
}