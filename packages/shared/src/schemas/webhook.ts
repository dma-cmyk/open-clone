// Webhook（out）のイベント定義・HMAC 署名・検証（DESIGN §10.1）。
// 署名形式: `x-openclone-signature: t=<unix>,v1=<hex(hmac_sha256(secret, "<t>.<raw body>"))>`
// 受信側は `verifyWebhookSignature()` を使う（タイムスタンプ許容 ±300 秒、定数時間比較）。

import { z } from "zod";
import { hmacSha256Hex, timingSafeEqual } from "../lib/hmac";

export const WEBHOOK_EVENT_TYPES = [
  "webhook.test",
  "report.created",
  "queue.pending",
  "queue.decided",
  "agent.suspended",
  "agent.resumed",
  "ai.stopped",
  "ai.resumed",
  "plugin.review.requested",
  "anomaly.detected",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

/** 配信ペイロードの envelope。data の中身はイベントごとに変わる（untrusted を含む場合がある）。 */
export const webhookEventSchema = z.object({
  id: z.string(),
  type: webhookEventTypeSchema,
  createdAt: z.number().int(),
  owner: z.object({
    type: z.enum(["site", "board", "account"]),
    id: z.string(),
  }),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const webhookSchema = z.object({
  id: z.string(),
  ownerType: z.enum(["site", "board", "account"]),
  ownerId: z.string(),
  url: z.string(),
  events: z.array(webhookEventTypeSchema),
  description: z.string().nullable(),
  active: z.boolean(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastDeliveryAt: z.number().int().nullable(),
  lastStatus: z.number().int().nullable(),
  failureCount: z.number().int(),
});
export type Webhook = z.infer<typeof webhookSchema>;

/** 作成時のみ secret を平文で返す（以降は再表示しない）。 */
export const webhookWithSecretSchema = webhookSchema.extend({
  secret: z.string(),
  secretWarning: z.string(),
});
export type WebhookWithSecret = z.infer<typeof webhookWithSecretSchema>;

const httpsUrlSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => /^https:\/\/[^\s]+$/.test(value), "https:// URL のみ登録できます");

export const createWebhookInputSchema = z.strictObject({
  url: httpsUrlSchema,
  events: z.array(webhookEventTypeSchema).min(1),
  description: z.string().max(500).optional(),
  /** site/board 所有者は配信先スコープを指定できる（既定は自分のスコープ） */
  ownerType: z.enum(["site", "board", "account"]).optional(),
  ownerId: z.string().max(64).optional(),
});
export type CreateWebhookInput = z.infer<typeof createWebhookInputSchema>;

export const updateWebhookInputSchema = z.strictObject({
  url: httpsUrlSchema.optional(),
  events: z.array(webhookEventTypeSchema).min(1).optional(),
  description: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
});
export type UpdateWebhookInput = z.infer<typeof updateWebhookInputSchema>;

export const webhookDeliverySchema = z.object({
  id: z.string(),
  webhookId: z.string(),
  event: webhookEventTypeSchema,
  status: z.enum(["pending", "delivered", "failed", "exhausted"]),
  attempts: z.number().int(),
  nextAttemptAt: z.number().int().nullable(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const WEBHOOK_SIGNATURE_HEADER = "x-openclone-signature";
export const WEBHOOK_TIMESTAMP_HEADER = "x-openclone-timestamp";
export const WEBHOOK_EVENT_HEADER = "x-openclone-event";
export const WEBHOOK_ID_HEADER = "x-openclone-webhook-id";
export const WEBHOOK_DELIVERY_HEADER = "x-openclone-delivery-id";

/** 最大試行回数（初回 + 再送 2 回）。 */
export const WEBHOOK_MAX_ATTEMPTS = 3;
/** 再送間隔（秒）。指数バックオフ。 */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 300] as const;
/** 署名タイムスタンプの許容ずれ（秒）。 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
/** 1 リクエストのタイムアウト（ミリ秒）。 */
export const WEBHOOK_TIMEOUT_MS = 5000;

export const webhookSecretSchema = z.object({
  secret: z.string(),
});
export type WebhookSecret = z.infer<typeof webhookSecretSchema>;

/** HMAC 署名（hex）を計算する。 */
export async function computeWebhookSignature(secret: string, timestamp: number, body: string): Promise<string> {
  return hmacSha256Hex(secret, `${timestamp}.${body}`);
}

/** 送信ヘッダ用の署名値（`t=<ts>,v1=<hex>`）を組み立てる。 */
export async function buildWebhookSignatureHeader(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const signature = await computeWebhookSignature(secret, timestamp, body);
  return `t=${timestamp},v1=${signature}`;
}

export interface VerifyWebhookSignatureInput {
  secret: string;
  body: string;
  /** x-openclone-signature ヘッダの値 */
  signatureHeader: string;
  /** 現在時刻（テストで固定するため注入可能） */
  now?: number;
  toleranceSeconds?: number;
  /** 別ヘッダで t を渡す場合 */
  timestampHeader?: string | null;
}

export interface VerifyWebhookSignatureResult {
  ok: boolean;
  reason?: "malformed" | "timestamp_out_of_range" | "mismatch";
}

/** 署名を検証する。破り方のヒントを返さないよう boolean ではなく理由コードのみ返す。 */
export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<VerifyWebhookSignatureResult> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;

  const parts = input.signatureHeader.split(",").reduce<Record<string, string>>((acc, part) => {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq > 0) acc[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    return acc;
  }, {});

  const timestampRaw = parts.t ?? input.timestampHeader ?? "";
  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return { ok: false, reason: "malformed" };
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "timestamp_out_of_range" };

  const provided = parts.v1 ?? "";
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: "malformed" };

  const expected = await computeWebhookSignature(input.secret, timestamp, input.body);
  return timingSafeEqual(expected, provided.toLowerCase()) ? { ok: true } : { ok: false, reason: "mismatch" };
}