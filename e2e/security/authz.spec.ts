// 未認証アクセス制御（DESIGN §5.4 サーバ側強制）。
// 公開エンドポイントは 200、保護エンドポイントは 401 UNAUTHORIZED を返す。
import { expect, test } from "@playwright/test";
import {
  ALLOWED_ORIGIN,
  API_BASE,
  expectUnauthorized,
  readEnvelope,
  skipIfUnimplemented,
  type ProtectedEndpoint,
} from "../helpers/api";

// 認証必須のエンドポイント（実装の `requireAuth` / `requireRole` と一致させる）。
// 投稿系（POST /v1/posts, POST /v1/boards/:slug/threads）と GET /v1/uploads/history は
// 匿名利用が仕様（DESIGN §6.2 / §9.1）のため、ここには含めない（下の「匿名投稿」テストで確認）。
const PROTECTED: ProtectedEndpoint[] = [
  { method: "GET", path: "/v1/accounts/me" },
  { method: "PATCH", path: "/v1/accounts/me" },
  { method: "GET", path: "/v1/accounts/me/sessions" },
  { method: "GET", path: "/v1/admin/invites" },
  { method: "POST", path: "/v1/admin/invites" },
  { method: "GET", path: "/v1/admin/audit" },
  { method: "GET", path: "/v1/admin/suspensions" },
  { method: "GET", path: "/v1/ai/agents" },
  { method: "POST", path: "/v1/ai/agents" },
  { method: "GET", path: "/v1/ai/audit" },
  { method: "GET", path: "/v1/ai/policies" },
  { method: "GET", path: "/v1/ai/status" },
  { method: "GET", path: "/v1/github/link" },
  { method: "GET", path: "/v1/plugins/mine" },
  { method: "GET", path: "/v1/plugins/reviews" },
  { method: "POST", path: "/v1/plugins" },
  { method: "GET", path: "/v1/reports" },
  { method: "POST", path: "/v1/boards" },
];

test.describe("未認証アクセス", () => {
  for (const endpoint of PROTECTED) {
    test(`${endpoint.method} ${endpoint.path} は 401`, async ({ request }) => {
      await expectUnauthorized(request, endpoint);
    });
  }

  test("公開: GET /v1/health は認証不要", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/health`);
    expect(response.status()).toBe(200);
  });

  test("公開: GET /v1/meta/usage は認証不要", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/meta/usage`);
    if (await skipIfUnimplemented(response)) return;
    expect(response.status()).toBe(200);
    const body = await readEnvelope<{ freeTierBudget: unknown }>(response);
    expect(body?.ok).toBe(true);
    if (body?.ok) expect(body.data.freeTierBudget).toBeTruthy();
  });

  test("公開: GET /v1/boards は未認証で一覧を返す", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/boards`);
    if (await skipIfUnimplemented(response)) return;
    expect(response.status()).toBe(200);
    const body = await readEnvelope<{ items: unknown[] }>(response);
    expect(body?.ok).toBe(true);
    if (body?.ok) expect(Array.isArray(body.data.items)).toBe(true);
  });

  test("存在しないルートは 404 envelope", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/definitely-not-a-route`);
    expect(response.status()).toBe(404);
    const body = await readEnvelope(response);
    expect(body?.ok).toBe(false);
    if (body && !body.ok) expect(body.code).toBe("NOT_FOUND");
  });

  test("匿名投稿は認証不要（401 ではなく入力検証で 400）", async ({ request }) => {
    const response = await request.post(`${API_BASE}/v1/posts`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
      data: {},
    });
    if (await skipIfUnimplemented(response)) return;
    expect(response.status()).not.toBe(401);
    expect(response.status()).toBe(400);
    const body = await readEnvelope(response);
    if (body && !body.ok) expect(body.code).toBe("VALIDATION");
  });

  test("匿名でも端末スコープのアップロード履歴は 200（空配列）", async ({ request }) => {
    const response = await request.get(`${API_BASE}/v1/uploads/history`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    if (await skipIfUnimplemented(response)) return;
    expect(response.status()).toBe(200);
    const body = await readEnvelope<{ items: unknown[] }>(response);
    expect(body?.ok).toBe(true);
    if (body?.ok) expect(Array.isArray(body.data.items)).toBe(true);
  });
});