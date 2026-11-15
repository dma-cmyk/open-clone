// ログイン/新規登録後の戻り先（`next`）を同一サイト内のローカルパスへ制限する（レビュー UX-R3）。
// `//host/`（プロトコル相対）・`/\host`・`http:`・制御文字（生のままでも % 符号化でも）などは
// 別オリジンへ飛びうるためすべて既定値へ落とす。オープンリダイレクト対策。

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * クエリパラメータの `next` を検証し、安全なローカルパスだけを返す。
 * 不正・不明な値は `fallback` を返す（呼び出し側はそのまま router.push してよい）。
 */
export function resolveSafeNext(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  // 生の値に制御文字（改行・TAB 等）が含まれるものは拒否
  if (CONTROL_CHARS.test(raw)) return fallback;
  // % 符号化された制御文字も拒否（不正なエスケープは復号できないため既定値へ）
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (CONTROL_CHARS.test(decoded)) return fallback;
  // ローカルパスは必ず 1 つのスラッシュで始まる。`//` はプロトコル相対 URL、
  // バックスラッシュはブラウザによってはオリジン区切りと解釈されるため拒否。
  // 復号後も同じ規則を適用し、%2F 等で組み立てた `//host` 相当も拒否する。
  for (const value of [raw, decoded]) {
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  }
  return raw;
}
