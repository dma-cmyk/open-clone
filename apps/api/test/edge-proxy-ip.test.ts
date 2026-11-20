// F1: 境界プロキシ（Vercel rewrites）経由の利用者 IP 検証（EDGE_PROXY_SECRET / x-oc-edge-secret）。
// 本番の Cloudflare Workers では `x-real-ip` が Cloudflare によって接続元（Vercel 中継サーバー）の IP で上書きされるため、
// 信頼されたプロキシからは `x-forwarded-for` の先頭のみを採用し、`x-real-ip` は使わない。

import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authedClient, createBoard, createThread, resetWorld, TestClient, type PostData } from "./wp1/helpers";

const ORIGIN = "http://localhost:3000";
const TEST_EDGE_SECRET = "test-edge-proxy-secret-value";

async function withEdgeEnv<T>(
  patch: { EDGE_PROXY_SECRET?: string; ENVIRONMENT?: string },
  run: () => Promise<T>,
): Promise<T> {
  const mutable = env as unknown as { EDGE_PROXY_SECRET?: string; ENVIRONMENT: string };
  const previous = {
    hasSecret: Object.prototype.hasOwnProperty.call(mutable, "EDGE_PROXY_SECRET"),
    EDGE_PROXY_SECRET: mutable.EDGE_PROXY_SECRET,
    ENVIRONMENT: mutable.ENVIRONMENT,
  };
  if (patch.EDGE_PROXY_SECRET === undefined) {
    delete mutable.EDGE_PROXY_SECRET;
  } else {
    mutable.EDGE_PROXY_SECRET = patch.EDGE_PROXY_SECRET;
  }
  if (patch.ENVIRONMENT !== undefined) {
    mutable.ENVIRONMENT = patch.ENVIRONMENT;
  }
  try {
    return await run();
  } finally {
    if (previous.hasSecret) {
      mutable.EDGE_PROXY_SECRET = previous.EDGE_PROXY_SECRET;
    } else {
      delete mutable.EDGE_PROXY_SECRET;
    }
    mutable.ENVIRONMENT = previous.ENVIRONMENT;
  }
}

/** Cloudflare Workers 本番相当の接続元ヘッダー（Cloudflare が x-real-ip も接続元 IP で上書きする）。 */
function cloudflareRelayHeaders(relayIp: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "cf-connecting-ip": relayIp,
    "x-real-ip": relayIp,
    ...extra,
  };
}

async function postWithHeaders(
  threadId: number,
  body: string,
  headers: Record<string, string>,
): Promise<string> {
  const client = new TestClient();
  const response = await client.fetch(`/v1/threads/${threadId}/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  expect(response.status, `POST /posts failed: ${response.status}`).toBe(201);
  const parsed = (await response.json()) as { ok: true; data: PostData };
  return parsed.data.post.idHash;
}

describe("F1: EDGE_PROXY_SECRET による利用者 IP 判定", () => {
  beforeEach(async () => {
    await resetWorld();
  });

  it("① x-real-ip を Cloudflare が上書きした状態でも、正しい秘密の値と x-forwarded-for で利用者の表示 ID が計算される", async () => {
    const owner = await authedClient({ name: "f1-id-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "F1 ID テスト", body: "本文" });

    await withEdgeEnv({ EDGE_PROXY_SECRET: TEST_EDGE_SECRET, ENVIRONMENT: "production" }, async () => {
      // 同じ中継 IP（cf-connecting-ip・x-real-ip ともに上書き値）でも、x-forwarded-for が違えば別 ID になる
      const userA = await postWithHeaders(
        thread.threadId,
        "利用者A",
        cloudflareRelayHeaders("198.51.100.50", {
          "x-forwarded-for": "203.0.113.10",
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        }),
      );
      const userB = await postWithHeaders(
        thread.threadId,
        "利用者B",
        cloudflareRelayHeaders("198.51.100.50", {
          "x-forwarded-for": "203.0.113.11",
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        }),
      );
      expect(userA).not.toBe(userB);

      // 中継 IP（cf-connecting-ip・x-real-ip）が変わっても、x-forwarded-for 先頭が同じなら同じ ID になる
      const userAFromOtherRelay = await postWithHeaders(
        thread.threadId,
        "利用者A2",
        cloudflareRelayHeaders("198.51.100.51", {
          "x-forwarded-for": "203.0.113.10, 198.51.100.51",
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        }),
      );
      expect(userAFromOtherRelay).toBe(userA);
    });
  });

  it("① x-real-ip が上書きされた状態でも、正しい秘密の値と x-forwarded-for 単位で回数制限（/v1/search 31 回目 429）される", async () => {
    await withEdgeEnv({ EDGE_PROXY_SECRET: TEST_EDGE_SECRET, ENVIRONMENT: "production" }, async () => {
      for (let i = 0; i < 30; i += 1) {
        const res = await SELF.fetch("http://worker.test/v1/search?q=abc&type=thread", {
          headers: cloudflareRelayHeaders(`198.51.101.${i + 1}`, {
            origin: ORIGIN,
            "x-forwarded-for": "203.0.113.20",
            "x-oc-edge-secret": TEST_EDGE_SECRET,
          }),
        });
        expect(res.status, `attempt ${i + 1}`).toBe(200);
      }

      // 31 回目は中継 IP（cf-connecting-ip / x-real-ip）が変わっても同一 x-forwarded-for なので 429
      const blocked = await SELF.fetch("http://worker.test/v1/search?q=abc&type=thread", {
        headers: cloudflareRelayHeaders("198.51.101.200", {
          origin: ORIGIN,
          "x-forwarded-for": "203.0.113.20, 198.51.101.200",
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        }),
      });
      expect(blocked.status).toBe(429);

      // 別利用者の x-forwarded-for は同じ中継 IP（198.51.101.1）からでも 200 で通る
      const otherUser = await SELF.fetch("http://worker.test/v1/search?q=abc&type=thread", {
        headers: cloudflareRelayHeaders("198.51.101.1", {
          origin: ORIGIN,
          "x-forwarded-for": "203.0.113.21",
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        }),
      });
      expect(otherUser.status).toBe(200);
    });
  });

  it("① IPv6 の x-forwarded-for を受理し、不正な形式または欠落時は x-real-ip を使わず cf-connecting-ip に戻す", async () => {
    const owner = await authedClient({ name: "f1-fmt-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "F1 IP形式", body: "本文" });

    await withEdgeEnv({ EDGE_PROXY_SECRET: TEST_EDGE_SECRET, ENVIRONMENT: "production" }, async () => {
      const cfIp = "198.51.100.60";
      const directId = await postWithHeaders(thread.threadId, "直接", cloudflareRelayHeaders(cfIp));
      const ipv6Id = await postWithHeaders(
        thread.threadId,
        "IPv6",
        cloudflareRelayHeaders(cfIp, {
          "x-forwarded-for": "2001:db8::1",
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        }),
      );
      expect(ipv6Id).not.toBe(directId);

      const ipv4MappedId = await postWithHeaders(
        thread.threadId,
        "IPv4-mapped",
        cloudflareRelayHeaders(cfIp, {
          "x-forwarded-for": "::ffff:203.0.113.5",
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        }),
      );
      expect(ipv4MappedId).not.toBe(directId);

      for (const badIp of ["not-an-ip", "999.999.999.999", "203.0.113.5:8080", "2001::db8::1"]) {
        const fallbackId = await postWithHeaders(thread.threadId, `不正:${badIp}`, {
          "cf-connecting-ip": cfIp,
          // x-real-ip が別の有効な IP であっても、信頼判定には使わず cf-connecting-ip に戻す
          "x-real-ip": "203.0.113.99",
          "x-forwarded-for": badIp,
          "x-oc-edge-secret": TEST_EDGE_SECRET,
        });
        expect(fallbackId, `bad x-forwarded-for (${badIp}) should fall back to cf-connecting-ip`).toBe(directId);
      }

      // x-forwarded-for 自体が無い場合も x-real-ip を使わず cf-connecting-ip に戻す
      const missingXffId = await postWithHeaders(thread.threadId, "XFF欠落", {
        "cf-connecting-ip": cfIp,
        "x-real-ip": "203.0.113.99",
        "x-oc-edge-secret": TEST_EDGE_SECRET,
      });
      expect(missingXffId).toBe(directId);
    });
  });

  it("② 秘密の値が違う・空・未設定のときは cf-connecting-ip が使われ、x-forwarded-for 偽装が効かない（ID と回数制限）", async () => {
    const owner = await authedClient({ name: "f1-spoof-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "F1 偽装防止", body: "本文" });

    const cases: Array<{ label: string; secret?: string; header?: string }> = [
      { label: "秘密の値が違う", secret: TEST_EDGE_SECRET, header: "wrong-edge-secret" },
      { label: "秘密ヘッダーが空", secret: TEST_EDGE_SECRET, header: "" },
      { label: "EDGE_PROXY_SECRET が未設定", secret: undefined, header: TEST_EDGE_SECRET },
      { label: "EDGE_PROXY_SECRET が空文字かつヘッダーも空", secret: "", header: "" },
    ];

    for (const [idx, c] of cases.entries()) {
      const cfIp = `198.51.102.${idx + 10}`;
      const spoofedIp = `203.0.113.${idx + 100}`;
      await withEdgeEnv({ EDGE_PROXY_SECRET: c.secret, ENVIRONMENT: "development" }, async () => {
        const directId = await postWithHeaders(thread.threadId, `直接:${c.label}`, cloudflareRelayHeaders(cfIp));
        const spoofHeaders = cloudflareRelayHeaders(cfIp, {
          "x-forwarded-for": spoofedIp,
          ...(c.header !== undefined ? { "x-oc-edge-secret": c.header } : {}),
        });
        const spoofedId = await postWithHeaders(thread.threadId, `偽装:${c.label}`, spoofHeaders);
        expect(spoofedId, c.label).toBe(directId);

        // 回数制限も cf-connecting-ip で数えられ、31 回目に x-forwarded-for を偽装しても 429 になる
        for (let i = 0; i < 30; i += 1) {
          const res = await SELF.fetch("http://worker.test/v1/search?q=abc&type=thread", {
            headers: cloudflareRelayHeaders(cfIp, { origin: ORIGIN }),
          });
          expect(res.status, `${c.label} attempt ${i + 1}`).toBe(200);
        }
        const bypassAttempt = await SELF.fetch("http://worker.test/v1/search?q=abc&type=thread", {
          headers: {
            origin: ORIGIN,
            ...spoofHeaders,
          },
        });
        expect(bypassAttempt.status, `${c.label} bypass`).toBe(429);
      });
    }
  });

  it("開発環境では cf-connecting-ip 無しで x-real-ip / x-forwarded-for が維持され、本番環境では無検証ヘッダーを信じない", async () => {
    const owner = await authedClient({ name: "f1-env-owner" });
    const board = await createBoard(owner.client, { settings: { turnstile: "off", cooldownSeconds: 0 } });
    const thread = await createThread(owner.client, board.board.slug, { title: "F1 環境分岐", body: "本文" });

    // 開発環境（cf-connecting-ip なし）: 従来の x-real-ip → x-forwarded-for フォールバックが効く（既存テスト互換）
    await withEdgeEnv({ EDGE_PROXY_SECRET: undefined, ENVIRONMENT: "development" }, async () => {
      const a = await postWithHeaders(thread.threadId, "dev-a", { "x-real-ip": "203.0.113.40" });
      const b = await postWithHeaders(thread.threadId, "dev-b", { "x-real-ip": "203.0.113.41" });
      expect(a).not.toBe(b);
      const c = await postWithHeaders(thread.threadId, "dev-c", { "x-forwarded-for": "203.0.113.40" });
      expect(c).toBe(a);
    });

    // 本番環境（cf-connecting-ip なし・secret なし）: x-real-ip / x-forwarded-for を偽装しても 127.0.0.1 扱いで同一 ID
    await withEdgeEnv({ EDGE_PROXY_SECRET: undefined, ENVIRONMENT: "production" }, async () => {
      const a = await postWithHeaders(thread.threadId, "prod-a", {
        "x-real-ip": "203.0.113.40",
        "x-forwarded-for": "203.0.113.40",
      });
      const b = await postWithHeaders(thread.threadId, "prod-b", {
        "x-real-ip": "203.0.113.41",
        "x-forwarded-for": "203.0.113.41",
      });
      expect(a).toBe(b);
    });
  });
});
