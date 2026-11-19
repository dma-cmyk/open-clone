// 事業者のエラー文から鍵らしい文字列を伏せる（応答・ログ・details に API キーを出さない）。
//
// 方針:
// - 中継で受け取った API キーの値そのものを最優先で伏せる（部分一致も含む）。
// - 事業者がキーを変形して返す場合に備え、**送ったキーから**大文字小文字違い・URL エンコード・
//   base64 の形を作って照合する（正規表現で鍵の形を推測しない）。
// - 事業者が返す典型的な鍵の形（`sk-...` / `Bearer ...` / `AIza...` / `x-api-key: ...`）も伏せる。
// - 長さは `MAX_PROVIDER_MESSAGE_CHARS` まで。**伏せてから**切る（切ってから伏せると
//   切り口に鍵の先頭が残る）。
//
// キー・会話本文はこの関数を通したうえでも DB・console には出さない（relay 側の責務）。

/** 事業者エラー文として画面へ出す最大文字数（設計 §5）。 */
export const MAX_PROVIDER_MESSAGE_CHARS = 300;

const REDACTED = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * キーの URL エンコード形に一致するパターン。
 * 各文字は「そのまま」か「%XX（16 進の大小どちらでも）」のどちらでもよいので、
 * 全体エンコード・一部だけのエンコード・エンコーダごとの大文字小文字の違いをまとめて拾う。
 */
function percentEncodedPattern(key: string): string {
  return Array.from(key)
    .map((char) =>
      /[A-Za-z0-9]/.test(char) ? escapeRegExp(char) : `(?:${escapeRegExp(char)}|%[0-9A-Fa-f]{2})`,
    )
    .join("");
}

/** キーの base64 表記（標準・パディング無し・URL-safe）。 */
function base64Variants(key: string): string[] {
  let encoded: string;
  try {
    encoded = btoa(key);
  } catch {
    // 印字可能 ASCII 以外は btoa できない。鍵としては受け付けていないが、防御的に空にする。
    return [];
  }
  const unpadded = encoded.replace(/=+$/, "");
  const urlSafe = (value: string) => value.replace(/\+/g, "-").replace(/\//g, "_");
  return [...new Set([encoded, unpadded, urlSafe(encoded), urlSafe(unpadded)])];
}

/** 鍵らしい文字列を伏せる。`apiKey` は中継で受け取った値（4 文字未満は文中を壊すため使わない）。 */
export function redactSecrets(text: string, apiKey?: string | null): string {
  let out = text;
  if (apiKey && apiKey.length >= 4) {
    // 送ったキーそのものと、その変形。
    out = out.split(apiKey).join(REDACTED);
    out = out.replace(new RegExp(escapeRegExp(apiKey), "gi"), REDACTED);
    out = out.replace(new RegExp(percentEncodedPattern(apiKey), "gi"), REDACTED);
    for (const variant of base64Variants(apiKey)) out = out.split(variant).join(REDACTED);
  }
  // OpenAI / Anthropic / DeepSeek などの `sk-` 系。
  out = out.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, `sk-${REDACTED}`);
  // Authorization ヘッダをそのまま返す事業者。
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, `Bearer ${REDACTED}`);
  // Google API キー。
  out = out.replace(/\bAIza[0-9A-Za-z_-]{10,}/g, `AIza${REDACTED}`);
  // `api_key` / `x-api-key` / `authorization` の代入・JSON フィールド。
  out = out.replace(
    /((?:x[-_]api[-_]key|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi,
    `$1${REDACTED}`,
  );
  return out;
}

/** 事業者エラー文を伏せて 300 文字に切る（改行は空白にまとめる）。 */
export function summarizeProviderMessage(text: string, apiKey?: string | null): string {
  const redacted = redactSecrets(text, apiKey).replace(/\s+/g, " ").trim();
  return Array.from(redacted).slice(0, MAX_PROVIDER_MESSAGE_CHARS).join("");
}

/**
 * 事業者のエラー応答から本文を取り出す。
 * `{error:{message}}` / `{error:"..."}` / `{message}` の順に見て、読めなければ生の本文を返す。
 */
export function extractProviderErrorText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record["error"];
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>)["message"];
        if (typeof message === "string" && message.length > 0) return message;
      }
      if (typeof error === "string" && error.length > 0) return error;
      const message = record["message"];
      if (typeof message === "string" && message.length > 0) return message;
    }
  } catch {
    // JSON でない本文はそのまま使う。
  }
  return trimmed;
}