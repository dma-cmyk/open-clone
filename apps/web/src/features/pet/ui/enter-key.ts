// 入力欄の Enter の扱い（日本語の変換中の Enter で送ってしまわない）。
//
// - Enter で送る / Shift+Enter で改行。
// - IME の変換中は送らない。Chrome は `isComposing` が true、Safari は `isComposing` が false でも
//   `keyCode` が 229 になるため、両方を見る。

export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function shouldSendOnEnter(event: ComposerKey): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey) return false;
  if (event.isComposing === true) return false;
  if (event.keyCode === 229) return false;
  return true;
}