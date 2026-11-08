// WP6: 特別管理人の権限境界（所有者専用 API・秘密情報にアクセスできない）。

import { describe, expect, it } from "vitest";
import { bootstrapOwner, call, createSpecialAdmin } from "./wp6-helpers";

describe("特別管理人の権限境界", () => {
  it("所有者専用 API・秘密情報に一切アクセスできない", async () => {
    const owner = await bootstrapOwner("owner2-root@example.com");
    const sa = await createSpecialAdmin(owner, "special-admin2@example.com");

    const ownerOnly: [string, string][] = [
      ["GET", "/v1/admin/special-admins"],
      ["GET", "/v1/admin/invites"],
      ["PUT", "/v1/admin/site-config"],
      ["POST", "/v1/admin/special-admins/000000000000000000000000/stop"],
    ];
    for (const [method, path] of ownerOnly) {
      const result = await call(method, path, { cookie: sa.cookie, body: method === "GET" ? undefined : {} });
      expect(result.status, `${method} ${path}`).toBe(403);
    }

    // 存在しない秘密情報エンドポイント（UI/API から到達不能）
    expect((await call("GET", "/v1/admin/secrets", { cookie: sa.cookie })).status).toBe(404);

    // サイト設定は読み取りのみ可（提案用）
    expect((await call("GET", "/v1/admin/site-config", { cookie: sa.cookie })).status).toBe(200);

    // 所有者のアカウント詳細は参照できない
    expect((await call("GET", `/v1/admin/users/${owner.accountId}`, { cookie: sa.cookie })).status).toBe(403);
  });
});
