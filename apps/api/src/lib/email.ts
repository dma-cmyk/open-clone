// メールアドレスの照合用の正規化。
// 保存値は変えない（登録時の表示・既存データを維持する）。照合と試行制限の鍵で同じ形を使い、
// 大文字・小文字の違いで試行制限の枠が分裂しないようにする。

/** 前後の空白を除いて小文字化する（SQLite の lower() と同じ ASCII 前提）。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}