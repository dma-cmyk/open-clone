// アップローダ表示用の純関数（テスト対象）。

import type { AttachmentKind } from "shared";

const TEXT_APPLICATION_TYPES: Record<string, true> = {
  "application/json": true,
  "application/ld+json": true,
  "application/javascript": true,
  "application/typescript": true,
  "application/xml": true,
  "application/x-yaml": true,
  "application/yaml": true,
  "application/toml": true,
  "application/sql": true,
  "application/x-sh": true,
};

const TEXT_EXTENSIONS: Record<string, true> = {
  txt: true,
  md: true,
  markdown: true,
  csv: true,
  tsv: true,
  json: true,
  jsonl: true,
  js: true,
  mjs: true,
  cjs: true,
  ts: true,
  tsx: true,
  jsx: true,
  css: true,
  html: true,
  htm: true,
  xml: true,
  yml: true,
  yaml: true,
  toml: true,
  ini: true,
  log: true,
  sql: true,
  sh: true,
  py: true,
  rb: true,
  go: true,
  rs: true,
  java: true,
  c: true,
  h: true,
  cpp: true,
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  zip: "application/zip",
  json: "application/json",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/plain",
};

/** バイト数を人間向けに整形する（1024 進）。 */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** URL のパスから拡張子（小文字）。取れなければ空文字。 */
export function extensionOfUrl(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? "";
  const base = clean.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 添付の表示種別。contentType → 拡張子の順で判定する。 */
export function attachmentKindOf(url: string, contentType?: string | null): AttachmentKind {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("text/") || TEXT_APPLICATION_TYPES[ct]) return "text";

  const ext = extensionOfUrl(url);
  if (MIME_BY_EXTENSION[ext]?.startsWith("image/")) return "image";
  if (MIME_BY_EXTENSION[ext]?.startsWith("video/")) return "video";
  if (MIME_BY_EXTENSION[ext]?.startsWith("audio/")) return "audio";
  if (TEXT_EXTENSIONS[ext]) return "text";
  return "file";
}

/** 種別に対応する表示ラベル。 */
export function kindLabel(kind: AttachmentKind): string {
  switch (kind) {
    case "image":
      return "画像";
    case "video":
      return "動画";
    case "audio":
      return "音声";
    case "text":
      return "テキスト";
    default:
      return "ファイル";
  }
}

/** 添付に保存されている MIME（不明時は拡張子から推定）。 */
export function guessedContentType(url: string, contentType?: string | null): string {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct) return ct;
  const ext = extensionOfUrl(url);
  return MIME_BY_EXTENSION[ext] ?? (TEXT_EXTENSIONS[ext] ? "text/plain" : "application/octet-stream");
}

/** Unix 秒を `YYYY/MM/DD HH:mm` にする（ローカル時刻）。 */
export function formatDateTime(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "-";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** ファイル名の拡張子（小文字）。 */
export function extensionOfName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 拡張子や MIME がアップローダの許可パターンに合うか（`image/*` を許容）。 */
export function contentTypeMatches(contentType: string, patterns: readonly string[]): boolean {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  return patterns.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    if (normalized === "*" || normalized === "*/*") return true;
    if (normalized.endsWith("/*")) return ct.startsWith(normalized.slice(0, -1));
    return ct === normalized;
  });
}

/** 表示用の短い添付名。 */
export function attachmentLabel(name: string | undefined, url: string): string {
  if (name && name.trim().length > 0) return name.trim();
  const base = url.split(/[?#]/)[0]!.split("/").pop();
  return base && base.length > 0 ? decodeURIComponent(base) : "添付ファイル";
}