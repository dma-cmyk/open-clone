// ヘルプの本文を `help-view.tsx` から読む（唯一の正本。文面をツール側に写さない）。
//
// 方式: 必要になったときだけ `HelpView` と `react-dom/server` を動的読み込みし、
//   `renderToStaticMarkup` の HTML を `<section id="...">` ごとに切り出して文字にする。
// 理由:
//   - `help-view.tsx` の本文は JSX の中にあり、書き写すとすぐ古くなる（二重管理）。
//   - `/help/` の HTML を fetch する方法は使えない。このサイトは 1 枚のシェルをクライアントで
//     切り替えるので、静的エクスポートの HTML には節の本文が入っていない。
//   - JSX の構造（`<Section id title>`）をそのまま読むので、ヘルプに節が増えても
//     （DSPetUI の `#pet` 節など）ツール側の変更なしで一覧・本文に出る。
// 節の取り出しは HTML を正規表現でたどる。出力はこのリポジトリの `Section` 部品が作る
// 決まった形（入れ子の section は無い）なので、汎用の HTML パーサを持ち込む必要はない。

import type { PetToolResult } from "../contract";

export interface HelpSection {
  id: string;
  title: string;
  text: string;
}

/** 1 節あたりに返す本文の上限。 */
export const HELP_SECTION_MAX_CHARS = 6000;

class HelpUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HelpUnavailableError";
  }
}

/** 実体参照を戻す（React はテキストを実体参照にエスケープする）。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** HTML 断片を読める文字にする（段落・箇条書きの区切りだけ残す）。 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "・")
    .replace(/<\/(p|li|div|ul|ol|h1|h2|h3|h4|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attribute(attrs: string, name: string): string | null {
  const matched = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return matched ? decodeEntities(matched[1] ?? "") : null;
}

/**
 * 描画済みのヘルプ HTML から節を取り出す（`<section id="...">` 単位）。
 * 節の本文は見出し（h2）を除いた中身。
 */
export function parseHelpSections(markup: string): HelpSection[] {
  const sections: HelpSection[] = [];
  const openTag = /<section\b([^>]*)>/gi;
  let matched: RegExpExecArray | null;
  while ((matched = openTag.exec(markup)) !== null) {
    const attrs = matched[1] ?? "";
    const id = attribute(attrs, "id");
    const start = matched.index + matched[0].length;
    const end = markup.indexOf("</section>", start);
    if (!id || end < 0) continue;
    const inner = markup.slice(start, end);
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(inner);
    const title = heading ? htmlToText(heading[1] ?? "") : id;
    const body = heading ? inner.replace(heading[0], "") : inner;
    sections.push({ id, title, text: htmlToText(body) });
    openTag.lastIndex = end;
  }
  return sections;
}

let cached: HelpSection[] | null = null;
let pending: Promise<HelpSection[]> | null = null;

/**
 * `help-view.tsx` を描画して節の一覧を返す（同一セッションでは 1 回だけ描画する）。
 * 失敗したら次回もう一度試す（読み込み失敗を握りつぶさない）。
 *
 * 動的読み込み（静的 import にしない理由）: `react-dom/server` はペットの会話で
 * `read_help` を呼んだときだけ要る。パネルを開いた全員の初回読み込みに含めない
 * （Next はクライアントでは `react-dom/server` を `server.browser` に差し替えるので、
 * `renderToStaticMarkup` がそのまま使える）。
 */
export async function loadHelpSections(): Promise<HelpSection[]> {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    const [{ renderToStaticMarkup }, { createElement }, helpView] = await Promise.all([
      import("react-dom/server"),
      import("react"),
      import("../../../app/_shell/views/help-view"),
    ]);
    const markup = renderToStaticMarkup(createElement(helpView.HelpView));
    const sections = parseHelpSections(markup);
    if (sections.length === 0) {
      throw new HelpUnavailableError("ヘルプの節を取り出せませんでした");
    }
    cached = sections;
    return sections;
  })();
  try {
    return await pending;
  } catch (cause) {
    throw new HelpUnavailableError("ヘルプを読み込めませんでした", { cause });
  } finally {
    pending = null;
  }
}

/** 試験用（節のキャッシュを捨てる）。 */
export function resetHelpCache(): void {
  cached = null;
  pending = null;
}

/** 見出し語・ID・本文のどれかに含まれるかの判定（日本語なので語の分割はしない）。 */
export function matchesHelp(section: HelpSection, query: string): boolean {
  const needle = query.trim();
  if (needle.length === 0) return true;
  return section.title.includes(needle) || section.text.includes(needle);
}

/** 節の ID か見出しの完全一致で探す（見出しは部分一致も許す）。 */
export function findHelpSection(sections: HelpSection[], key: string): HelpSection | null {
  const needle = key.trim();
  const byId = sections.find((section) => section.id === needle);
  if (byId) return byId;
  const byTitle = sections.find((section) => section.title === needle);
  if (byTitle) return byTitle;
  return sections.find((section) => section.title.includes(needle)) ?? null;
}

/** 失敗をツールの結果にする（呼び出し側で分岐しない）。 */
export function helpFailure(cause: unknown): PetToolResult {
  const message = cause instanceof Error ? cause.message : "ヘルプを読み込めませんでした";
  return { ok: false, code: "HELP_UNAVAILABLE", error: message };
}