// ペットの返事のうち、同じサイト内のパス（`/b/...` など）だけをリンクにする。
// 本文は HTML として解釈しない（改行は残して文字として描く）。

export interface TextToken {
  type: "text" | "link";
  value: string;
}

/** パスとして認める形（全体が URL でも `//` で始まる別ホストでもないもの）。 */
const PATH_RE = /\/[A-Za-z0-9\-._~%!$&'()*+,;=:@]+(?:\/[A-Za-z0-9\-._~%!$&'()*+,;=:@]*)*/g;
/** パスの直前がこれなら「文章の中のパス」とみなす（英数字の途中はリンクにしない）。 */
const BOUNDARY: Record<string, true> = {
  " ": true,
  "\n": true,
  "\t": true,
  "(": true,
  "（": true,
  "「": true,
  "『": true,
  '"': true,
  "'": true,
  "、": true,
  "。": true,
  ",": true,
  ".": true,
  "!": true,
  "?": true,
  "！": true,
  "？": true,
  "）": true,
  "」": true,
  "』": true,
};

function trimTrailingPunctuation(value: string): { path: string; rest: string } {
  const match = value.match(/[.,!?;:」』）)。、！？]+$/);
  if (!match) return { path: value, rest: "" };
  return { path: value.slice(0, value.length - match[0].length), rest: match[0] };
}

export function splitSiteLinks(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let last = 0;
  for (const match of text.matchAll(PATH_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 1), start);
    const atBoundary = before === "" || BOUNDARY[before] === true;
    if (!atBoundary || raw.startsWith("//")) continue;
    const { path, rest } = trimTrailingPunctuation(raw);
    if (path.length < 2) continue;
    if (start > last) tokens.push({ type: "text", value: text.slice(last, start) });
    tokens.push({ type: "link", value: path });
    if (rest) tokens.push({ type: "text", value: rest });
    last = start + path.length + rest.length;
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) });
  return tokens.length > 0 ? tokens : [{ type: "text", value: text }];
}