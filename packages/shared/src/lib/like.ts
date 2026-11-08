// SQL LIKE のワイルドカード（`%` / `_`）とエスケープ文字（`\`）を無害化する。
// 利用側は `LIKE ? ESCAPE '\'` と組み合わせること（バインド自体は SQLi ではないが、
// `%`/`_` をそのまま渡すと意図しない全件マッチになる。L-6）。

/** LIKE パターンに埋め込む前に `\` `%` `_` をエスケープする。 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `%value%` の部分一致パターン（エスケープ済み）。 */
export function likeContains(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

/** `value%` の前方一致パターン（エスケープ済み）。 */
export function likePrefix(value: string): string {
  return `${escapeLikePattern(value)}%`;
}