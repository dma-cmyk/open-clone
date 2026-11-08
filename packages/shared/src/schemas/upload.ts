// 添付ファイル（アップローダ）の公開契約（WORKPACKAGES §3.4）。
// 添付の**本体は Cloudflare に保存しない**。D1 に保存するのは URL とメタデータのみ（DESIGN §9.1）。
// WP0 の `types/uploader-adapter.ts`（アダプタ IF）はそのまま使い、ここでは API の入出力と検証ヘルパを定義する。

import { z } from "zod";
import {
  UPLOAD_CLOUDINARY_MAX_BYTES,
  UPLOAD_PROXY_MAX_BYTES,
} from "../constants";

// ───────────────────────── アダプタ識別子 ─────────────────────────

/** 組み込みアダプタ ID。追加アダプタは任意の ID（`[a-z0-9_-]`）を使う。 */
export const BUILTIN_UPLOADER_ADAPTER_IDS = [
  "catbox",
  "litterbox",
  "cloudinary",
  "gist",
  "github",
  "mock",
] as const;

export type BuiltinUploaderAdapterId = (typeof BUILTIN_UPLOADER_ADAPTER_IDS)[number];

/** アダプタ ID の書式（`uploader_adapters.id` / プラグイン登録拡張点の共通制約） */
export const uploaderAdapterIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "アダプタ ID は英小文字・数字・_・- のみ使用できます");

/** サイト既定アダプタ（Catbox。DESIGN §9.1） */
export const DEFAULT_UPLOADER_ADAPTER_ID: BuiltinUploaderAdapterId = "catbox";

// ───────────────────────── 添付種別・MIME 検証 ─────────────────────────

export const attachmentKinds = ["image", "video", "audio", "text", "file"] as const;
export type AttachmentKind = (typeof attachmentKinds)[number];

const TEXTUAL_APPLICATION_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/x-sh",
]);

/** MIME タイプから表示種別を決める（ビューアの出し分けに使用）。 */
export function attachmentKindOf(contentType: string): AttachmentKind {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("text/") || TEXTUAL_APPLICATION_TYPES.has(ct)) return "text";
  return "file";
}

/** 実行ファイル系（Catbox の禁止拡張子 + 一般的な危険拡張子）。 */
export const BLOCKED_UPLOAD_EXTENSIONS = [
  "exe",
  "scr",
  "cpl",
  "doc",
  "docm",
  "docx",
  "xls",
  "xlsm",
  "xlsx",
  "ppt",
  "pptm",
  "pptx",
  "jar",
  "msi",
  "bat",
  "cmd",
  "com",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "ps1",
  "apk",
  "dmg",
  "iso",
  "lnk",
  "reg",
  "hta",
] as const;

/** ファイル名の拡張子（小文字・拡張子なしは空文字）。 */
export function uploadExtensionOf(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 拡張子が禁止リストに該当するか。 */
export function isBlockedUploadFilename(filename: string): boolean {
  return (BLOCKED_UPLOAD_EXTENSIONS as readonly string[]).includes(uploadExtensionOf(filename));
}

/**
 * 先頭バイトから実 MIME を推定する（マジックバイト検証）。
 * 判定できない場合は null（テキスト等）。宣言 MIME との食い違い検出に使う。
 */
export function sniffContentType(head: Uint8Array): string | null {
  const b = head;
  const has = (offset: number, bytes: number[]): boolean =>
    b.length >= offset + bytes.length && bytes.every((v, i) => b[offset + i] === v);
  const ascii = (offset: number, length: number): string => {
    let s = "";
    for (let i = offset; i < Math.min(offset + length, b.length); i += 1) s += String.fromCharCode(b[i]!);
    return s;
  };

  if (has(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (has(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && ascii(8, 4) === "WEBP") return "image/webp";
  if (has(0, [0x42, 0x4d])) return "image/bmp";
  if (has(0, [0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (has(0, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (has(0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (has(0, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  if (has(0, [0x66, 0x74, 0x79, 0x70]) || ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1")) return "image/heic";
    return "video/mp4";
  }
  if (has(0, [0x49, 0x44, 0x33]) || has(0, [0xff, 0xfb]) || has(0, [0xff, 0xf3]) || has(0, [0xff, 0xf2])) {
    return "audio/mpeg";
  }
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && ascii(8, 4) === "WAVE") return "audio/wav";
  return null;
}

/** 宣言 MIME がアダプタの許可パターンに合致するか（`image/*` 形式を許容）。 */
export function contentTypeMatches(contentType: string, patterns: readonly string[]): boolean {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (p === "*" || p === "*/*") return true;
    if (p.endsWith("/*")) return ct.startsWith(p.slice(0, -1));
    return ct === p;
  });
}

// ───────────────────────── アダプタ公開情報 ─────────────────────────

export const uploaderAdapterInfoSchema = z.object({
  id: z.string(),
  mode: z.enum(["direct", "proxy-stream"]),
  /** このアダプタが受け付ける最大バイト数 */
  maxBytes: z.number().int().positive(),
  /** 許可 MIME パターン（`image/*` 等） */
  types: z.array(z.string()),
  /** UI 表示名 */
  label: z.string(),
  /** この環境で実際に使えるか（設定不足なら false + reason） */
  available: z.boolean(),
  reason: z.string().optional(),
  /** このアダプタが添付を保持する期間（秒）。恒久は null */
  retentionSeconds: z.number().int().positive().nullable(),
  /** 連携ユーザーの GitHub が必須か（gist/github） */
  requiresGithub: z.boolean(),
});
export type UploaderAdapterInfo = z.infer<typeof uploaderAdapterInfoSchema>;

export const uploaderAdapterListSchema = z.object({
  items: z.array(uploaderAdapterInfoSchema),
  defaultAdapter: z.string(),
});

// ───────────────────────── prepare ─────────────────────────

export const uploadPrepareSchema = z.object({
  /** 省略時は板/サイト既定 */
  adapter: uploaderAdapterIdSchema.optional(),
  contentType: z
    .string()
    .min(1)
    .max(120)
    .transform((value) => value.split(";")[0]!.trim().toLowerCase()),
  size: z.number().int().min(1).max(UPLOAD_PROXY_MAX_BYTES),
  filename: z.string().min(1).max(200),
  boardId: z.number().int().positive().nullable().optional(),
  /** 任意の用途ラベル（post / plugin / profile 等。監査・履歴用） */
  purpose: z.string().max(32).optional(),
});
export type UploadPrepareInput = z.infer<typeof uploadPrepareSchema>;

const directPlanSchema = z.object({
  mode: z.literal("direct"),
  url: z.string().min(1),
  method: z.enum(["POST", "PUT"]),
  headers: z.record(z.string(), z.string()).optional(),
  formFields: z.record(z.string(), z.string()).optional(),
  fileField: z.string().optional(),
  /** 応答の解釈方法（Cloudinary=json / Litterbox=text） */
  resultType: z.enum(["json", "text"]).optional(),
});

const proxyPlanSchema = z.object({
  mode: z.literal("proxy-stream"),
  proxyPath: z.string().min(1),
});

export const uploadPlanSchema = z.discriminatedUnion("mode", [directPlanSchema, proxyPlanSchema]);
export type UploadPlanPayload = z.infer<typeof uploadPlanSchema>;

/** prepare の応答。ticketId は proxy/commit で使う一度きりのアップロード許可証。 */
export const uploadPrepareResultSchema = z.object({
  ticketId: z.string(),
  adapter: z.string(),
  mode: z.enum(["direct", "proxy-stream"]),
  plan: uploadPlanSchema,
  maxBytes: z.number().int().positive(),
  contentType: z.string(),
  /** proxy 用の一度きりトークン（`x-upload-token` ヘッダで送る。URL には載せない） */
  uploadToken: z.string().optional(),
  /** 有効期限（Unix seconds） */
  expiresAt: z.number().int(),
});
export type UploadPrepareResult = z.infer<typeof uploadPrepareResultSchema>;

/** proxy-stream 中継が成功したときの応答（この後 commit する）。 */
export const uploadProxyResultSchema = z.object({
  ticketId: z.string(),
  externalUrl: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  kind: z.enum(attachmentKinds),
  expiresAt: z.number().int().nullable(),
});
export type UploadProxyResult = z.infer<typeof uploadProxyResultSchema>;

// ───────────────────────── commit / history ─────────────────────────

export const uploadCommitSchema = z.object({
  ticketId: z.string().min(1).max(64),
  /** direct アダプタでは必須。proxy アダプタでは応答 URL が既に確定しているため省略可 */
  externalUrl: z.string().min(1).max(2048).optional(),
  /** direct アダプタの応答本文（Cloudinary の JSON 等） */
  response: z.unknown().optional(),
  /** direct アダプタが返した削除用トークン等 */
  deleteUrl: z.string().max(2048).optional(),
});
export type UploadCommitInput = z.infer<typeof uploadCommitSchema>;

export const uploadHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  boardId: z.coerce.number().int().positive().optional(),
  /** 未投稿の添付だけを返す */
  unattached: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((value) => value === true || value === "true"),
});
export type UploadHistoryQuery = z.infer<typeof uploadHistoryQuerySchema>;

export const attachmentSchema = z.object({
  id: z.string(),
  postId: z.number().int().nullable(),
  adapter: z.string(),
  url: z.string(),
  contentType: z.string(),
  kind: z.enum(attachmentKinds),
  size: z.number().int(),
  filename: z.string(),
  createdAt: z.number().int(),
  expiresAt: z.number().int().nullable(),
  status: z.enum(["active", "dead", "deleted"]),
  /** 閲覧者がこの添付を削除できるか（投稿者/管理人判定のヒント。最終判定はサーバ） */
  canDelete: z.boolean().optional(),
});
export type AttachmentDto = z.infer<typeof attachmentSchema>;

export const uploadHistoryResultSchema = z.object({
  items: z.array(attachmentSchema),
  limitReached: z.boolean(),
});

// ───────────────────────── 種別ごとの既定上限 ─────────────────────────

export const UPLOAD_ADAPTER_LIMITS = {
  /** Catbox（Worker プロキシ中継。CF Free の受信 100MB 制限より安全側） */
  catbox: { maxBytes: UPLOAD_PROXY_MAX_BYTES, types: ["image/*", "video/*", "audio/*", "text/*", "application/pdf", "application/json"] as string[] },
  /** Litterbox（一時。Worker 中継は行わず 95MB に揃える） */
  litterbox: { maxBytes: UPLOAD_PROXY_MAX_BYTES, types: ["image/*", "video/*", "audio/*", "text/*", "application/pdf", "application/json"] as string[] },
  /** Cloudinary direct（署名付き。25 credits/月のため強いレート制限が前提） */
  cloudinary: { maxBytes: UPLOAD_CLOUDINARY_MAX_BYTES, types: ["image/*", "video/*"] as string[] },
  /** Gist（テキスト/コード。API 1MB/ファイル） */
  gist: { maxBytes: 1024 * 1024, types: ["text/*", "application/json", "application/javascript"] as string[] },
  /** GitHub リポジトリ（Contents API は base64 送信のため 1MB を上限に運用） */
  github: { maxBytes: 1024 * 1024, types: ["text/*", "application/json", "application/javascript"] as string[] },
  /** テスト/ローカルスタブ */
  mock: { maxBytes: UPLOAD_PROXY_MAX_BYTES, types: ["*/*"] as string[] },
} as const;