// Webhook の HMAC 署名・イベント購読・再送の統合テスト。

import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "shared";
import { network } from "./network";
import { retryPendingDeliveries } from "../src/services/ai/webhook";
import {
  api,
  createAgent,
  json,
  makeAccount,
  makeBoard,
  makePost,
  makeSession,
  makeThread,
} from "./ai-helpers";

/** waitUntil で遅延配信されるため、条件成立まで短時間ポーリングする。 */
async function waitFor(check: () => Promise<void> | void, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error("waitFor timeout");
}

beforeEach(async () => {
  // テスト間で Webhook 購読が混ざらないように消す（宛先 URL が同一のため）。
  await env.DB.prepare("DELETE FROM webhook_deliveries").run();
  await env.DB.prepare("DELETE FROM webhooks").run();
});

interface Captured {
  url: string;
  headers: Headers;
  body: string;
}

function captureHandler(captured: Captured[], status = 200) {
  return http.post("https://hooks.example.com/oc", async ({ request }) => {
    captured.push({
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });
    return new HttpResponse(null, { status });
  });
}

async function setupWebhook(events: string[]) {
  const adminId = await makeAccount({ role: "special_admin" });
  const cookie = await makeSession(adminId);
  const response = await api("/v1/ai/webhooks", {
    method: "POST",
    cookie,
    body: { url: "https://hooks.example.com/oc", events, description: "テスト" },
  });
  const body = await json<{ data: { id: string; secret: string; events: string[] } }>(response);
  expect(response.status).toBe(201);
  return { cookie, webhookId: body.data.id, secret: body.data.secret };
}

describe("Webhook 署名と配信", () => {
  it("queue.pending を HMAC 署名付きで配信し、受信側で検証できる", async () => {
    const captured: Captured[] = [];
    network.use(captureHandler(captured));
    const { cookie, secret } = await setupWebhook(["queue.pending"]);

    const boardId = await makeBoard();
    const threadId = await makeThread({ boardId });
    const postId = await makePost({ boardId, threadId, body: "承認待ちの対象" });
    const agent = await createAgent(cookie, {
      name: "webhook-agent",
      ownerType: "site",
      allowedBoards: "*",
      riskCap: "high",
    });
    const queued = await api(`/v1/ai/posts/${postId}/delete`, {
      method: "POST",
      key: agent.apiKey,
      body: { reason: "webhook テスト" },
    });
    expect(queued.status).toBe(202);

    await waitFor(() => {
      expect(captured).toHaveLength(1);
    });
    const delivery = captured[0]!;
    expect(delivery.headers.get("x-openclone-event")).toBe("queue.pending");
    const signature = delivery.headers.get("x-openclone-signature");
    expect(signature).toBeTruthy();

    const verified = await verifyWebhookSignature({
      secret,
      body: delivery.body,
      signatureHeader: signature!,
    });
    expect(verified.ok).toBe(true);

    const tampered = await verifyWebhookSignature({
      secret,
      body: `${delivery.body} `,
      signatureHeader: signature!,
    });
    expect(tampered.ok).toBe(false);

    const payload = JSON.parse(delivery.body) as { type: string; data: { action: string } };
    expect(payload.type).toBe("queue.pending");
    expect(payload.data.action).toBe("post.delete");

    await waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT status, attempts, response_status FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1",
      ).first<{ status: string; attempts: number; response_status: number }>();
      expect(row?.status).toBe("delivered");
      expect(row?.attempts).toBe(1);
      expect(row?.response_status).toBe(200);
    });
  });

  it("購読していないイベントは配信しない", async () => {
    const captured: Captured[] = [];
    network.use(captureHandler(captured));
    const { cookie } = await setupWebhook(["webhook.test"]);

    const boardId = await makeBoard();
    const threadId = await makeThread({ boardId });
    const postId = await makePost({ boardId, threadId, body: "購読外" });
    const agent = await createAgent(cookie, {
      name: "webhook-agent-2",
      ownerType: "site",
      allowedBoards: "*",
      riskCap: "high",
    });
    await api(`/v1/ai/posts/${postId}/delete`, {
      method: "POST",
      key: agent.apiKey,
      body: { reason: "購読外イベント" },
    });
    // 配信が走らないことを確定させるため、キュー行の作成を待ってから確認する
    await waitFor(async () => {
      const queued = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM ai_queue WHERE agent_id = ?",
      )
        .bind(agent.id)
        .first<{ count: number }>();
      expect(queued?.count).toBe(1);
    });
    expect(captured).toHaveLength(0);
  });

  it("失敗した配信は再送され、成功すると delivered になる", async () => {
    let calls = 0;
    network.use(
      http.post("https://hooks.example.com/oc", async ({ request }) => {
        calls += 1;
        await request.text();
        return new HttpResponse(null, { status: calls === 1 ? 500 : 200 });
      }),
    );
    const { cookie, webhookId } = await setupWebhook(["webhook.test"]);

    const test = await api(`/v1/ai/webhooks/${webhookId}/test`, { method: "POST", cookie });
    expect(test.status).toBe(200);
    await waitFor(() => {
      expect(calls).toBe(1);
    });

    const pending = await env.DB.prepare(
      "SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(webhookId)
      .first<{ status: string; attempts: number; next_attempt_at: number | null }>();
    expect(pending?.status).toBe("pending");
    expect(pending?.attempts).toBe(1);
    expect(pending?.next_attempt_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // 再送時刻を過去にして cron 相当の処理を実行
    await env.DB.prepare("UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE webhook_id = ?")
      .bind(webhookId)
      .run();
    const result = await retryPendingDeliveries(env, 10);
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(2);

    const delivered = await env.DB.prepare(
      "SELECT status, attempts FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(webhookId)
      .first<{ status: string; attempts: number }>();
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.attempts).toBe(2);
  });

  it("3 回失敗すると exhausted になり、それ以上再送しない", async () => {
    let calls = 0;
    network.use(
      http.post("https://hooks.example.com/oc", async ({ request }) => {
        calls += 1;
        await request.text();
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const { cookie, webhookId } = await setupWebhook(["webhook.test"]);
    await api(`/v1/ai/webhooks/${webhookId}/test`, { method: "POST", cookie });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await env.DB.prepare("UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE webhook_id = ?")
        .bind(webhookId)
        .run();
      await retryPendingDeliveries(env, 10);
    }

    const row = await env.DB.prepare(
      "SELECT status, attempts FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(webhookId)
      .first<{ status: string; attempts: number }>();
    expect(row?.status).toBe("exhausted");
    expect(row?.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("一覧に署名鍵は含まれない", async () => {
    const { cookie } = await setupWebhook(["webhook.test"]);
    const list = await api("/v1/ai/webhooks", { cookie });
    const body = await json<{ data: { items: Record<string, unknown>[] } }>(list);
    expect(body.data.items.length).toBeGreaterThan(0);
    for (const item of body.data.items) {
      expect(item.secret).toBeUndefined();
      expect(item.secret_enc).toBeUndefined();
    }
  });
});