// ロール別のサーバ側強制（DESIGN §5.4）。
// 固定 E2E セッション（e2e/fixtures/seed.sql）で anon / user / owner を比較する。
// 板スタッフ行（board_admin/deputy/moderator）は板データが必要なため、
// API 統合テストと e2e/core で検証する（ここでは全体ロールのみ）。
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope, skipIfUnimplemented } from "../helpers/api";

const SESSION = {
  owner: "e2e-owner-session-token",
  user: "e2e-user-session-token",
} as const;

async function fetchAs(
  request: APIRequestContext,
  role: keyof typeof SESSION | "anon",
  method: "GET" | "POST" | "PATCH",
  path: string,
): Promise<APIResponse> {
  return request.fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      ...(role === "anon" ? {} : { Cookie: `oc_sess=${SESSION[role]}` }),
    },
    ...(method === "GET" ? {} : { data: {} }),
  });
}

test.describe("権限マトリクス: owner 専用", () => {
  test("GET /v1/admin/invites: anon=401, user=403, owner=200", async ({ request }) => {
    const anon = await fetchAs(request, "anon", "GET", "/v1/admin/invites");
    if (await skipIfUnimplemented(anon)) return;
    expect(anon.status()).toBe(401);

    const user = await fetchAs(request, "user", "GET", "/v1/admin/invites");
    expect(user.status()).toBe(403);

    const owner = await fetchAs(request, "owner", "GET", "/v1/admin/invites");
    expect(owner.status()).toBe(200);
    const body = await readEnvelope(owner);
    expect(body?.ok).toBe(true);
  });

  test("POST /v1/admin/invites: user は 403", async ({ request }) => {
    const user = await fetchAs(request, "user", "POST", "/v1/admin/invites");
    if (await skipIfUnimplemented(user)) return;
    expect(user.status()).toBe(403);
  });

  test("GET /v1/admin/audit: user は 403", async ({ request }) => {
    const user = await fetchAs(request, "user", "GET", "/v1/admin/audit");
    if (await skipIfUnimplemented(user)) return;
    expect(user.status()).toBe(403);
  });
});

test.describe("権限マトリクス: 一般ユーザー", () => {
  test("GET /v1/accounts/me: user は自分の情報を取得できる", async ({ request }) => {
    const user = await fetchAs(request, "user", "GET", "/v1/accounts/me");
    if (await skipIfUnimplemented(user)) return;
    expect(user.status()).toBe(200);
    const body = await readEnvelope<{ profile: { name: string; role: string }; totp: { enabled: boolean } }>(user);
    expect(body?.ok).toBe(true);
    if (body?.ok) {
      expect(body.data.profile.name).toBe("test-user");
      expect(body.data.profile.role).toBe("user");
      expect(body.data.totp.enabled).toBe(false);
    }
  });

  test("GET /v1/accounts/me: owner セッションが owner として解決される", async ({ request }) => {
    const owner = await fetchAs(request, "owner", "GET", "/v1/accounts/me");
    if (await skipIfUnimplemented(owner)) return;
    expect(owner.status()).toBe(200);
    const body = await readEnvelope<{ profile: { role: string } }>(owner);
    if (body?.ok) expect(body.data.profile.role).toBe("owner");
  });
});