// Webhook（out）配信（DESIGN §10.1）。
// 署名: `x-openclone-signature: t=<unix>,v1=<hex(HMAC-SHA256(secret, "<t>.<body>"))>`。
// 失敗時は指数バックオフ（60s / 300s）で cron（20 * * * *）が再送する。最大 3 試行で exhausted。

import {
  ApiError,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WEBHOOK_TIMEOUT_MS,
  buildWebhookSignatureHeader,
  ulid,
  webhookEventTypeSchema,
  type Webhook,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookWithSecret,
} from "shared";
import type { Env } from "../../lib/env";
import { assertPublicHttpsUrl } from "../../lib/url-safety";
import { randomToken } from "shared";
import { decryptSecret, encryptSecret } from "../account/crypto";

interface WebhookRow {
  id: string;
  owner_type: "site" | "board" | "account";
  owner_id: string;
  url: string;
  events: string;
  secret_enc: string;
  description: string | null;
  active: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_delivery_at: number | null;
  last_status: number | null;
  failure_count: number;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  status: "pending" | "delivered" | "failed" | "exhausted";
  attempts: number;
  next_attempt_at: number | null;
  response_status: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function parseEvents(raw: string): WebhookEventType[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const result = webhookEventTypeSchema.safeParse(value);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function mapWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    url: row.url,
    events: parseEvents(row.events),
    description: row.description,
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastDeliveryAt: row.last_delivery_at,
    lastStatus: row.last_status,
    failureCount: row.failure_count,
  };
}

const WEBHOOK_COLUMNS = `id, owner_type, owner_id, url, events, secret_enc, description, active,
  created_by, created_at, updated_at, last_delivery_at, last_status, failure_count`;

export async function listWebhooks(
  env: Env,
  ownerType: "site" | "board" | "account",
  ownerId: string,
): Promise<Webhook[]> {
  const rows = await env.DB.prepare(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC`,
  )
    .bind(ownerType, ownerId)
    .all<WebhookRow>();
  return (rows.results ?? []).map(mapWebhook);
}

/** 閲覧可能な全 Webhook（サイト管理者向け）。secret は返さない。 */
export async function listAllWebhooks(env: Env, limit = 100): Promise<Webhook[]> {
  const rows = await env.DB.prepare(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<WebhookRow>();
  return (rows.results ?? []).map(mapWebhook);
}

export async function getWebhook(env: Env, id: string): Promise<Webhook> {
  const row = await env.DB.prepare(`SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = ?`)
    .bind(id)
    .first<WebhookRow>();
  if (!row) throw ApiError.notFound("Webhook が見つかりません");
  return mapWebhook(row);
}

export async function createWebhook(
  env: Env,
  input: {
    ownerType: "site" | "board" | "account";
    ownerId: string;
    url: string;
    events: WebhookEventType[];
    description?: string;
    createdBy: string;
  },
): Promise<WebhookWithSecret> {
  // 登録時点で SSRF 宛先（内部・メタデータ・ローカル）を拒否する（H-2）。
  const targetUrl = assertPublicHttpsUrl(input.url).toString();
  const id = ulid();
  const secret = `whsec_${randomToken(32)}`;
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO webhooks
       (id, owner_type, owner_id, url, events, secret_enc, description, active, created_by,
        created_at, updated_at, last_delivery_at, last_status, failure_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, 0)`,
  )
    .bind(
      id,
      input.ownerType,
      input.ownerId,
      targetUrl,
      JSON.stringify(input.events),
      await encryptSecret(secret, env.ENC_KEY),
      input.description ?? null,
      input.createdBy,
      ts,
      ts,
    )
    .run();

  const webhook = await getWebhook(env, id);
  return {
    ...webhook,
    secret,
    secretWarning: "この署名鍵は再表示できません。安全な場所に保管してください。",
  };
}

export async function updateWebhook(
  env: Env,
  id: string,
  patch: {
    url?: string;
    events?: WebhookEventType[];
    description?: string | null;
    active?: boolean;
  },
): Promise<Webhook> {
  const current = await env.DB.prepare(`SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = ?`)
    .bind(id)
    .first<WebhookRow>();
  if (!current) throw ApiError.notFound("Webhook が見つかりません");
  // 更新時も登録時と同じ SSRF 検証を通す（H-2）。
  const nextUrl = patch.url === undefined ? current.url : assertPublicHttpsUrl(patch.url).toString();
  await env.DB.prepare(
    `UPDATE webhooks SET url = ?, events = ?, description = ?, active = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      nextUrl,
      JSON.stringify(patch.events ?? parseEvents(current.events)),
      patch.description === undefined ? current.description : patch.description,
      (patch.active ?? current.active === 1) ? 1 : 0,
      now(),
      id,
    )
    .run();
  return getWebhook(env, id);
}

export async function deleteWebhook(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(id).run();
}

// ─────────────────────────── 配信 ───────────────────────────

async function attemptDelivery(env: Env, delivery: DeliveryRow, webhook: WebhookRow): Promise<void> {
  const timestamp = now();
  let secret: string;
  try {
    secret = await decryptSecret(webhook.secret_enc, env.ENC_KEY);
  } catch (error) {
    console.error("WEBHOOK_SECRET_DECRYPT_FAILED", error);
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status = 'exhausted', error = ?, updated_at = ? WHERE id = ?",
    )
      .bind("secret decrypt failed", timestamp, delivery.id)
      .run();
    return;
  }

  const signature = await buildWebhookSignatureHeader(secret, timestamp, delivery.payload);

  // 配信時にも再検証する（登録後に DB の URL が書き換えられた場合の防御 / H-2）。
  let targetUrl: string;
  try {
    targetUrl = assertPublicHttpsUrl(webhook.url).toString();
  } catch (cause) {
    const reason = cause instanceof ApiError ? cause.message : "URL が許可されていません";
    await env.DB.prepare(
      "UPDATE webhook_deliveries SET status = 'exhausted', error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(`blocked target: ${reason}`.slice(0, 300), timestamp, delivery.id)
      .run();
    return;
  }

  let status: number | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "OpenClone-Webhook/1.0",
        "x-openclone-signature": signature,
        "x-openclone-timestamp": String(timestamp),
        "x-openclone-event": delivery.event,
        "x-openclone-webhook-id": webhook.id,
        "x-openclone-delivery-id": delivery.id,
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      // リダイレクトは追わない（公開 URL → 内部アドレスへの 302 迂回を防ぐ / H-2）。
      // 3xx は下の status 判定で失敗扱いになる。
      redirect: "manual",
    });
    status = response.status;
    // 2xx 以外は失敗（ボディは読まない。攻撃者の巨大応答でメモリを消費しない）。
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "network error";
  }

  const attempts = delivery.attempts + 1;
  const success = error === null;

  if (success) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, response_status = ?, error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
      ).bind(attempts, status, timestamp, delivery.id),
      env.DB.prepare(
        "UPDATE webhooks SET last_delivery_at = ?, last_status = ?, failure_count = 0, updated_at = ? WHERE id = ?",
      ).bind(timestamp, status, timestamp, webhook.id),
    ]);
    return;
  }

  if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE webhook_deliveries SET status = 'exhausted', attempts = ?, response_status = ?, error = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
      ).bind(attempts, status, error, timestamp, delivery.id),
      env.DB.prepare(
        "UPDATE webhooks SET last_delivery_at = ?, last_status = ?, failure_count = failure_count + 1, updated_at = ? WHERE id = ?",
      ).bind(timestamp, status, timestamp, webhook.id),
    ]);
    return;
  }

  const delay = WEBHOOK_RETRY_DELAYS_SECONDS[attempts - 1] ?? 300;
  await env.DB.prepare(
    "UPDATE webhook_deliveries SET status = 'pending', attempts = ?, response_status = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(attempts, status, error, timestamp + delay, timestamp, delivery.id)
    .run();
  await env.DB.prepare(
    "UPDATE webhooks SET last_delivery_at = ?, last_status = ?, failure_count = failure_count + 1, updated_at = ? WHERE id = ?",
  )
    .bind(timestamp, status, timestamp, webhook.id)
    .run();
}

async function deliver(env: Env, webhook: WebhookRow, event: WebhookEvent): Promise<void> {
  const payload = JSON.stringify(event);
  const ts = now();
  const deliveryId = ulid();
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event, payload, status, attempts, next_attempt_at, response_status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
  )
    .bind(deliveryId, webhook.id, event.type, payload, ts, ts)
    .run();

  const delivery: DeliveryRow = {
    id: deliveryId,
    webhook_id: webhook.id,
    event: event.type,
    payload,
    status: "pending",
    attempts: 0,
    next_attempt_at: null,
    response_status: null,
    error: null,
    created_at: ts,
    updated_at: ts,
  };
  await attemptDelivery(env, delivery, webhook);
}

/**
 * イベントを購読中の Webhook に配信する。
 * 対象: site 購読 + イベント所有者スコープ（board/account）の購読。
 * `waitUntil` があればレスポンスを待たせない。
 */
export async function emitWebhookEvent(
  env: Env,
  event: WebhookEvent,
  options: { waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT ${WEBHOOK_COLUMNS} FROM webhooks
     WHERE active = 1 AND (
       owner_type = 'site'
       OR (owner_type = ? AND owner_id = ?)
     )`,
  )
    .bind(event.owner.type, event.owner.id)
    .all<WebhookRow>();

  const targets = (rows.results ?? []).filter((row) => parseEvents(row.events).includes(event.type));
  if (targets.length === 0) return;
  const tasks = targets.map((row) => deliver(env, row, event));

  if (options.waitUntil) {
    options.waitUntil(Promise.all(tasks));
    return;
  }
  await Promise.all(tasks);
}

/** 再送期限が来た pending 配信を処理する（cron 20 * * * *）。 */
export async function retryPendingDeliveries(env: Env, limit = 20): Promise<{ processed: number }> {
  const ts = now();
  const rows = await env.DB.prepare(
    `SELECT d.*, w.owner_type, w.owner_id, w.url, w.events, w.secret_enc, w.description, w.active,
            w.created_by, w.created_at AS webhook_created_at, w.updated_at AS webhook_updated_at,
            w.last_delivery_at, w.last_status, w.failure_count
     FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
     ORDER BY d.next_attempt_at ASC LIMIT ?`,
  )
    .bind(ts, limit)
    .all<DeliveryRow & WebhookRow & { webhook_created_at: number; webhook_updated_at: number }>();

  let processed = 0;
  for (const row of rows.results ?? []) {
    const webhook: WebhookRow = {
      id: row.webhook_id,
      owner_type: row.owner_type,
      owner_id: row.owner_id,
      url: row.url,
      events: row.events,
      secret_enc: row.secret_enc,
      description: row.description,
      active: row.active,
      created_by: row.created_by,
      created_at: row.webhook_created_at,
      updated_at: row.webhook_updated_at,
      last_delivery_at: row.last_delivery_at,
      last_status: row.last_status,
      failure_count: row.failure_count,
    };
    await attemptDelivery(env, row, webhook);
    processed++;
  }
  return { processed };
}

/** テスト送信。購読イベントに関係なく 1 件届ける。 */
export async function sendTestEvent(env: Env, webhookId: string): Promise<{ deliveryId: string }> {
  const row = await env.DB.prepare(`SELECT ${WEBHOOK_COLUMNS} FROM webhooks WHERE id = ?`)
    .bind(webhookId)
    .first<WebhookRow>();
  if (!row) throw ApiError.notFound("Webhook が見つかりません");

  const event: WebhookEvent = {
    id: ulid(),
    type: "webhook.test",
    createdAt: now(),
    owner: { type: row.owner_type, id: row.owner_id },
    data: { message: "おーぷんクローン Webhook テスト配信です" },
  };
  const payload = JSON.stringify(event);
  const deliveryId = ulid();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event, payload, status, attempts, next_attempt_at, response_status, error, created_at, updated_at)
     VALUES (?, ?, 'webhook.test', ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
  )
    .bind(deliveryId, webhookId, payload, ts, ts)
    .run();
  await attemptDelivery(
    env,
    {
      id: deliveryId,
      webhook_id: webhookId,
      event: "webhook.test",
      payload,
      status: "pending",
      attempts: 0,
      next_attempt_at: null,
      response_status: null,
      error: null,
      created_at: ts,
      updated_at: ts,
    },
    row,
  );
  return { deliveryId };
}

/** 配信履歴（ダッシュボード表示用）。 */
export async function listDeliveries(
  env: Env,
  webhookId: string,
  limit = 20,
): Promise<
  {
    id: string;
    event: string;
    status: string;
    attempts: number;
    responseStatus: number | null;
    error: string | null;
    createdAt: number;
  }[]
> {
  const rows = await env.DB.prepare(
    `SELECT id, event, status, attempts, response_status, error, created_at
     FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(webhookId, limit)
    .all<{
      id: string;
      event: string;
      status: string;
      attempts: number;
      response_status: number | null;
      error: string | null;
      created_at: number;
    }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    event: row.event,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.response_status,
    error: row.error,
    createdAt: row.created_at,
  }));
}