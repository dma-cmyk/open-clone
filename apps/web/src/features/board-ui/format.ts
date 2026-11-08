// 表示整形（open2ch のレス行書式に合わせる）。

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** `26/11/08(日) 09:19:44` — open2ch 実測の 2 桁年・全角括弧。 */
export function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const yy = String(date.getFullYear() % 100).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yy}/${mm}/${dd}(${WEEKDAYS[date.getDay()]}) ${hh}:${mi}:${ss}`;
}

export function formatRelative(seconds: number | null | undefined, now = Date.now() / 1000): string {
  if (!seconds) {
    return "";
  }
  const diff = Math.max(0, now - seconds);
  if (diff < 60) return "たった今";
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}日前`;
  return formatDate(seconds).slice(0, 8);
}

export function formatSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** レス本文の引用範囲 `>>1-3` を [1,3] に展開する（最大 100 件）。 */
export function expandAnchorSpec(spec: string): number[] {
  const text = spec.replace(/^>>/, "");
  const result: number[] = [];
  for (const part of text.split(",")) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      for (let n = Math.min(from, to); n <= Math.max(from, to) && result.length < 100; n += 1) {
        result.push(n);
      }
      continue;
    }
    const single = Number(part);
    if (Number.isFinite(single) && single > 0 && result.length < 100) {
      result.push(single);
    }
  }
  return result;
}

export function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

/** `/b/<slug>/t/<id>` */
export function threadPath(slug: string, threadId: number): string {
  return `/b/${encodeURIComponent(slug)}/t/${threadId}`;
}

export function boardPath(slug: string): string {
  return `/b/${encodeURIComponent(slug)}`;
}

/** 画像・動画 URL の判定（添付の contentType が無い場合のフォールバック）。 */
export function mediaKind(url: string, contentType?: string): "image" | "video" | "text" | "file" {
  const type = (contentType ?? "").toLowerCase();
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? "";
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/.test(path)) return "image";
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/.test(path)) return "video";
  if (type.startsWith("text/") || /\.(txt|md|csv|json|log)$/.test(path)) return "text";
  return "file";
}