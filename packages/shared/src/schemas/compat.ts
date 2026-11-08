// 専ブラ互換（subject.txt / dat / bbsmenu / RSS）の整形。
// 出力は Shift_JIS（`packages/shared/src/lib/shiftjis.ts` でエンコードする）。

import { z } from "zod";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const JST_OFFSET_SECONDS = 9 * 3600;

/** Unix 秒 → `YY/MM/DD(曜) HH:MM:SS`（JST）。dat / レス表示の標準書式。 */
export function formatJstDate(unixSeconds: number): string {
  const date = new Date((unixSeconds + JST_OFFSET_SECONDS) * 1000);
  const year = String(date.getUTCFullYear() % 100).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const weekday = WEEKDAYS[date.getUTCDay()]!;
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}/${month}/${day}(${weekday}) ${hour}:${minute}:${second}`;
}

/** 今日の JST 日付（`YYYYMMDD`）。表示 ID の日替わり回転に使う。 */
export function jstDateKey(unixSeconds: number): string {
  const date = new Date((unixSeconds + JST_OFFSET_SECONDS) * 1000);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** JST の当日終端（Unix 秒）。アク禁の「日跨ぎ有効」に使う。 */
export function jstEndOfDay(unixSeconds: number): number {
  const date = new Date((unixSeconds + JST_OFFSET_SECONDS) * 1000);
  const endUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000;
  return endUtc - JST_OFFSET_SECONDS;
}

/** HTML エスケープ（dat のフィールド区切り `<>` を壊さない）。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 1 行 1 フィールドに収める（改行・`<>` を除去）。 */
export function sanitizeField(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replaceAll("<>", "＜＞").trim();
}

/**
 * dat の本文フィールドを HTML 化する。
 * `<br>` 改行 + 安価 `>>n` のリンク化（open2ch の dat と同じ表現）。
 */
export function renderDatBody(body: string, boardSlug: string, threadId: number): string {
  const escaped = escapeHtml(body);
  return escaped
    .replace(/&gt;&gt;(\d{1,4})/g, (_match, num: string) => {
      return `<a class="_ank ank" href="/test/read.cgi/${boardSlug}/${threadId}/${num}">&gt;&gt;${num}</a>`;
    })
    .replace(/\n/g, "<br>");
}

/** subject.txt の 1 行（`<id>.dat<>タイトル (レス数)`）。 */
export function formatSubjectLine(threadId: number, title: string, postCount: number): string {
  return `${threadId}.dat<>${sanitizeField(title)} (${postCount})`;
}

export const datLineSchema = z.object({
  name: z.string(),
  trip: z.string().nullable(),
  mail: z.string(),
  createdAt: z.number().int(),
  idHash: z.string(),
  body: z.string(),
  title: z.string().nullable(),
  num: z.number().int(),
  boardSlug: z.string(),
  threadId: z.number().int(),
});
export type DatLineInput = z.infer<typeof datLineSchema>;

/** dat の 1 行（5 フィールド固定）。 */
export function formatDatLine(input: DatLineInput): string {
  const name = sanitizeField(`${input.name}${input.trip ?? ""}`);
  const mail = sanitizeField(input.mail);
  const date = `${formatJstDate(input.createdAt)} ID:${sanitizeField(input.idHash)}`;
  const body = renderDatBody(input.body, input.boardSlug, input.threadId);
  const title = input.num === 1 ? sanitizeField(input.title ?? "") : "";
  return `${name}<>${mail}<>${date}<>${body}<>${title}`;
}

export interface BbsmenuGroup {
  category: string;
  boards: Array<{ slug: string; name: string }>;
}

/** bbsmenu.html（専ブラ用板一覧・Shift_JIS）。 */
export function renderBbsmenu(groups: BbsmenuGroup[], baseUrl = ""): string {
  const lines = [
    "<HTML><HEAD><TITLE>おーぷんクローン</TITLE></HEAD><BODY>",
    "<BR><BR>",
  ];
  for (const group of groups) {
    lines.push(`<B>${escapeHtml(group.category)}</B><BR>`);
    for (const board of group.boards) {
      lines.push(`<A HREF="${baseUrl}/b/${encodeURIComponent(board.slug)}/">${escapeHtml(board.name)}</A><BR>`);
    }
    lines.push("<BR>");
  }
  lines.push("</BODY></HTML>");
  return lines.join("\n");
}

export interface RssItem {
  threadId: number;
  title: string;
  url: string;
  description: string;
  pubDate: number;
}

/** index.rdf（RSS 2.0・UTF-8）。open2ch の中身は未取得のため独自仕様（DESIGN §15-11）。 */
export function renderRss(channelTitle: string, channelUrl: string, items: RssItem[]): string {
  const escapeXml = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const body = items
    .map((item) => {
      return [
        "<item>",
        `<title>${escapeXml(item.title)}</title>`,
        `<link>${escapeXml(item.url)}</link>`,
        `<guid isPermaLink="true">${escapeXml(item.url)}</guid>`,
        `<description>${escapeXml(item.description)}</description>`,
        `<pubDate>${new Date(item.pubDate * 1000).toUTCString()}</pubDate>`,
        "</item>",
      ].join("");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${escapeXml(channelTitle)}</title>
<link>${escapeXml(channelUrl)}</link>
<description>${escapeXml(channelTitle)} の新着スレッド</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${body}
</channel></rss>`;
}