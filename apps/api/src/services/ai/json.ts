// JSON 列（D1 の TEXT）を安全に辞書として読むヘルパ。
// 配列・プリミティブ・壊れた JSON は null を返し、呼び出し側は既定値に倒す（fail-closed）。

/** JSON.parse 済みの値が plain object なら Record として返す。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // 上の検査で plain object であることは保証済み（配列・null・プリミティブを排除）。
  const record = value as Record<string, unknown>;
  return record;
}

/** D1 の TEXT 列（JSON）を辞書として読む。壊れていれば null。 */
export function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}
