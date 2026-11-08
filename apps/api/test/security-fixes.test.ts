// セキュリティレビューで指摘された事項の回帰テスト。
// H-1 就任キー総当たり / H-2 Webhook SSRF / H-3 IP 単位レート制限 / M-1 監視フィードの板スコープ /
// L-2 投稿入力契約 / L-3 監査ログの query 除去 / L-6 LIKE ワイルドカード無害化。

import { SELF, env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { generateTotp, generateTotpSecret, ulid } from "shared";
import { network } from "./network";
import { issueInvite } from "../src/services/account/invite";
import { logNetAttempt } from "../src/services/plugins/net";
import { sendTestEvent } from "../src/services/ai/webhook";
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
import { createAccount, createBoard, createThread, TestClient } from "./wp1/helpers";

const ORIGIN = "http://localhost:3000";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webhooks"),
    env.DB.prepare("DELETE FROM webhook_deliveries"),
    env.DB.prepare("DELETE FROM plugin_net_log"),
  ]);
});

function ipHeaders(ip: string): Record<string, string> {
  return {
    origin: ORIGIN,
    "content-type": "application/json",
    "cf-connecting-ip": ip,
  };
}

async function inviteRejectBody(key: string): Promise<{ secret: string; body: Record<string, unknown> }> {
  const secret = generateTotpSecret();
  const code = await generateTotp(secret, { time: Math.floor(Date.now() / 1000) });
  const wrong = `${code.slice(0, 5)}${String((Number(code[5]) + 1) % 10)}`;
  return {
    secret,
    body: {
      key,
      name: "招待テスト",
      email: `${ulid().toLowerCase()}@example.com`,
      password: "password-1234",
      totpSecret: secret,
      totpCode: wrong,
    },
  };
}

describe("H-1: 就任キー accept の TOTP 総当たり対策", () => {
  it("5 回失敗するとキーが失効し、以後の試行は INVITE_INVALID", async () => {
    const ownerId = await makeAccount({ role: "user" });
    const invite = await issueInvite(env.DB, "special_admin", ownerId);
    const { body } = await inviteRejectBody(invite.key);
    const ip = `198.51.100.${Math.floor(Math.random() * 100) + 1}`;

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await SELF.fetch("http://worker.test/v1/admin/invites/accept", {
        method: "POST",
        headers: ipHeaders(ip),
        body: JSON.stringify(body),
      });
      expect(response.status, `attempt ${attempt}`).toBe(400);
      const parsed = await json<{ ok: boolean; code?: string }>(response);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("TOTP_INVALID");
    }

    const fifth = await SELF.fetch("http://worker.test/v1/admin/invites/accept", {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify(body),
    });
    expect(fifth.status).toBe(400);
    const fifthBody = await json<{ ok: boolean; code?: string }>(fifth);
    expect(fifthBody.code).toBe("INVITE_INVALID");

    const row = await env.DB.prepare("SELECT revoked_at FROM invites WHERE id = ?")
      .bind(invite.id)
      .first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).not.toBeNull();

    const after = await SELF.fetch("http://worker.test/v1/admin/invites/accept", {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify(body),
    });
    expect(after.status).toBe(400);
    expect((await json<{ code?: string }>(after)).code).toBe("INVITE_INVALID");
  });

  it("prepare-totp はキー単位で発行回数を制限する", async () => {
    const ownerId = await makeAccount({ role: "user" });
    const invite = await issueInvite(env.DB, "special_admin", ownerId);
    const ip = `198.51.100.${Math.floor(Math.random() * 100) + 1}`;

    for (let i = 0; i < 5; i += 1) {
      const response = await SELF.fetch("http://worker.test/v1/admin/invites/prepare-totp", {
        method: "POST",
        headers: ipHeaders(ip),
        body: JSON.stringify({ key: invite.key }),
      });
      expect(response.status).toBe(200);
    }
    const limited = await SELF.fetch("http://worker.test/v1/admin/invites/prepare-totp", {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify({ key: invite.key }),
    });
    expect(limited.status).toBe(429);
    expect((await json<{ code?: string }>(limited)).code).toBe("RATE_LIMITED");
  });
});

describe("H-2: Webhook の SSRF 防御", () => {
  async function userCookie(): Promise<string> {
    const accountId = await makeAccount({ role: "user" });
    return makeSession(accountId);
  }

  it("登録時に内部・メタデータ・単一ラベル宛先を拒否する", async () => {
    const cookie = await userCookie();
    const urls = [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://foo.internal/x",
      "https://example.localhost/x",
      "https://10.0.0.1/x",
      "http://hooks.example.com/oc",
    ];
    for (const url of urls) {
      const response = await api("/v1/ai/webhooks", {
        method: "POST",
        cookie,
        body: { url, events: ["queue.pending"] },
      });
      expect([400, 403], `${url} should be rejected`).toContain(response.status);
    }
  });

  it("公開 https URL は登録でき、配信時にも再検証して内部宛先へ送らない", async () => {
    const cookie = await userCookie();
    const created = await api("/v1/ai/webhooks", {
      method: "POST",
      cookie,
      body: { url: "https://hooks.example.com/oc", events: ["queue.pending"] },
    });
    expect(created.status).toBe(201);
    const webhook = await json<{ data: { id: string } }>(created);

    let internalCalled = false;
    network.use(
      http.post("https://169.254.169.254/internal", () => {
        internalCalled = true;
        return new HttpResponse(null, { status: 200 });
      }),
    );

    // DB を直接書き換えて「登録後に URL が差し替えられた」状況を再現する。
    await env.DB.prepare("UPDATE webhooks SET url = ? WHERE id = ?")
      .bind("https://169.254.169.254/internal", webhook.data.id)
      .run();
    await sendTestEvent(env, webhook.data.id);

    expect(internalCalled).toBe(false);
    const delivery = await env.DB.prepare(
      "SELECT status, error FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(webhook.data.id)
      .first<{ status: string; error: string | null }>();
    expect(delivery?.status).toBe("exhausted");
    expect(delivery?.error).toContain("blocked target");
  });

  it("配信は 3xx を追跡しない（公開 URL からの内部リダイレクト）", async () => {
    const cookie = await userCookie();
    const created = await api("/v1/ai/webhooks", {
      method: "POST",
      cookie,
      body: { url: "https://hooks.example.com/redirect", events: ["queue.pending"] },
    });
    expect(created.status).toBe(201);
    const webhook = await json<{ data: { id: string } }>(created);

    let internalCalled = false;
    network.use(
      http.post("https://hooks.example.com/redirect", () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/internal" },
        }),
      ),
      http.post("https://169.254.169.254/internal", () => {
        internalCalled = true;
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await sendTestEvent(env, webhook.data.id);
    expect(internalCalled).toBe(false);
    const delivery = await env.DB.prepare(
      "SELECT response_status FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(webhook.data.id)
      .first<{ response_status: number | null }>();
    expect(delivery?.response_status).toBe(302);
  });
});

describe("H-3: IP 単位のレート制限と compat キャッシュ", () => {
  it("Cookie を保存しない投稿でも同一 IP の上限で 429 になる", async () => {
    const owner = await createAccount({ role: "user" });
    const client = new TestClient();
    client.setCookie("oc_sess", owner.token);
    const board = await createBoard(client, { settings: { turnstile: "off" } });
    const thread = await createThread(client, board.board.slug);
    const ip = `203.0.113.${Math.floor(Math.random() * 100) + 1}`;

    const statuses: number[] = [];
    for (let i = 0; i < 41; i += 1) {
      const response = await SELF.fetch("http://worker.test/v1/posts", {
        method: "POST",
        headers: ipHeaders(ip),
        body: JSON.stringify({ threadId: thread.threadId, body: `cookie なし ${i}` }),
      });
      statuses.push(response.status);
      if (response.status === 429) break;
    }
    expect(statuses.slice(0, 40).every((status) => status === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("/v1/search は同一 IP の連続呼び出しで 429 になる", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 100) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const response = await SELF.fetch("http://worker.test/v1/search?q=abc&type=thread", {
        headers: { origin: ORIGIN, "cf-connecting-ip": ip },
      });
      statuses.push(response.status);
      if (response.status === 429) break;
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("/v1/rt/ticket は同一 IP の連続発行で 429 になる", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 100) + 1}`;
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const response = await SELF.fetch("http://worker.test/v1/rt/ticket", {
        method: "POST",
        headers: ipHeaders(ip),
        body: JSON.stringify({ channels: ["board:1"] }),
      });
      statuses.push(response.status);
      if (response.status === 429) break;
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("subject.txt は ETag / If-Modified-Since で 304 を返す", async () => {
    const owner = await createAccount({ role: "user" });
    const client = new TestClient();
    client.setCookie("oc_sess", owner.token);
    const board = await createBoard(client, { settings: { turnstile: "off" } });
    await createThread(client, board.board.slug);
    const ip = `203.0.113.${Math.floor(Math.random() * 100) + 1}`;
    const url = `http://worker.test/compat/${board.board.slug}/subject.txt`;
    const headers = { origin: ORIGIN, "cf-connecting-ip": ip };

    const first = await SELF.fetch(url, { headers });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    const lastModified = first.headers.get("last-modified");
    expect(etag).toBeTruthy();
    expect(lastModified).toBeTruthy();

    const byEtag = await SELF.fetch(url, { headers: { ...headers, "if-none-match": etag! } });
    expect(byEtag.status).toBe(304);
    const byModified = await SELF.fetch(url, { headers: { ...headers, "if-modified-since": lastModified! } });
    expect(byModified.status).toBe(304);
  });
});

describe("H-3 追補: 一覧系の IP 窓（readList）", () => {
  /** 120 回までは 200、121 回目は 429 RATE_LIMITED。 */
  async function expectReadListLimit(path: string, ip: string, extraHeaders: Record<string, string> = {}) {
    const url = `http://worker.test${path}`;
    const headers = { ...ipHeaders(ip), ...extraHeaders };
    const statuses: number[] = [];
    for (let i = 0; i < 121; i += 1) {
      const response = await SELF.fetch(url, { headers });
      statuses.push(response.status);
      if (response.status === 429) break;
    }
    expect(statuses.slice(0, 120).every((status) => status === 200), statuses.join(",")).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses).toHaveLength(121);

    const denied = await SELF.fetch(url, { headers });
    expect(denied.status).toBe(429);
    expect((await json<{ code?: string }>(denied)).code).toBe("RATE_LIMITED");
  }

  it("GET /v1/boards は同一 IP の 121 回目で 429", { timeout: 60_000 }, async () => {
    await expectReadListLimit("/v1/boards?limit=10", "198.18.0.11");
  });

  it("GET /v1/threads?board= は同一 IP の 121 回目で 429", { timeout: 60_000 }, async () => {
    const owner = await createAccount({ role: "user" });
    const client = new TestClient();
    client.setCookie("oc_sess", owner.token);
    const board = await createBoard(client);
    await expectReadListLimit(`/v1/threads?board=${encodeURIComponent(board.board.slug)}`, "198.18.1.12");
  });

  it("GET /v1/plugins（一覧）は同一 IP の 121 回目で 429", { timeout: 60_000 }, async () => {
    await expectReadListLimit("/v1/plugins?limit=10", "198.18.2.13");
  });

  it("ログイン済みでも既存の読み取り系 IP 窓と同じく上限が適用される", { timeout: 60_000 }, async () => {
    const account = await createAccount({ role: "user" });
    await expectReadListLimit("/v1/boards?limit=10", "198.18.3.14", {
      cookie: `oc_sess=${account.token}`,
    });
  });
});

describe("M-1: monitor.feed の担当板スコープ", () => {
  it("担当板限定 agent は boardId 省略の全板監視を拒否される", async () => {
    const adminId = await makeAccount({ role: "special_admin" });
    const cookie = await makeSession(adminId);
    const boardA = await makeBoard();
    const boardB = await makeBoard();
    const threadB = await makeThread({ boardId: boardB });
    const postId = await makePost({ boardId: boardB, threadId: threadB, body: "板Bの投稿" });
    expect(postId).toBeGreaterThan(0);

    const agent = await createAgent(cookie, {
      name: "monitor-limited",
      ownerType: "site",
      allowedBoards: [boardA],
      riskCap: "low",
    });

    const all = await api("/v1/ai/act", {
      method: "POST",
      key: agent.apiKey,
      body: { action: "monitor.feed", params: {} },
    });
    expect(all.status).toBe(403);
    expect((await json<{ code?: string }>(all)).code).toBe("FORBIDDEN");

    const scoped = await api("/v1/ai/act", {
      method: "POST",
      key: agent.apiKey,
      body: { action: "monitor.feed", params: { boardId: boardA } },
    });
    expect(scoped.status).toBe(200);
  });
});

describe("L-2: 投稿ボディの入力契約", () => {
  it("添付 ID が上限 10 件を超える投稿は 400", async () => {
    const owner = await createAccount({ role: "user" });
    const client = new TestClient();
    client.setCookie("oc_sess", owner.token);
    const board = await createBoard(client, { settings: { turnstile: "off" } });
    const thread = await createThread(client, board.board.slug);
    const attachments = Array.from({ length: 11 }, (_, index) => `att-${index}`);

    for (const path of [`/v1/posts`, `/v1/threads/${thread.threadId}/posts`]) {
      const response = await SELF.fetch(`http://worker.test${path}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({
          threadId: thread.threadId,
          body: "添付上限テスト",
          attachments,
        }),
      });
      expect(response.status, path).toBe(400);
    }
  });
});

describe("L-3: plugin_net_log は URL の query を保存しない", () => {
  it("query 付き URL を記録しても token が残らない", async () => {
    await logNetAttempt(env.DB, {
      pluginId: "p1",
      version: "1.0.0",
      installId: null,
      scope: "personal",
      caller: { accountId: null, deviceHash: "dev1", installId: null },
      url: "https://api.example.com/v1/items?token=secret123",
      method: "GET",
      status: 200,
      bytes: 10,
      allowed: true,
      reason: null,
    });
    const row = await env.DB.prepare("SELECT url, host FROM plugin_net_log ORDER BY created_at DESC LIMIT 1")
      .first<{ url: string; host: string }>();
    expect(row?.host).toBe("api.example.com");
    expect(row?.url).toBe("https://api.example.com/v1/items");
    expect(row?.url).not.toContain("secret123");
  });
});

describe("L-6: LIKE ワイルドカードの無害化", () => {
  it("板検索の % は全件マッチにならない", async () => {
    await makeBoard({ name: "通常の板A" });
    await makeBoard({ name: "通常の板B" });
    const response = await api("/v1/boards?q=%25");
    expect(response.status).toBe(200);
    const body = await json<{ data: { items: unknown[] } }>(response);
    expect(body.data.items).toHaveLength(0);
  });

  it("スレ検索の _ は任意 1 文字マッチにならない", async () => {
    const boardId = await makeBoard();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO threads (board_id, title, title_flags, live, post_count, max_posts, last_post_at, bump_at, pinned, status, created_at)
       VALUES (?, 'abc', '{}', 0, 0, 1000, ?, ?, 0, 'active', ?)`,
    )
      .bind(boardId, now, now, now)
      .run();

    const response = await api("/v1/search?q=_&type=thread");
    expect(response.status).toBe(200);
    const body = await json<{ data: { items: unknown[] } }>(response);
    expect(body.data.items).toHaveLength(0);
  });
});