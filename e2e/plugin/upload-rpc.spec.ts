// プラグイン RPC `upload.start` の実 UI 配線。
// プラグインから呼ぶとホストのアップロードダイアログが開き、キャンセル結果が返ることを実ブラウザで検証する。

import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

const CODE = `register({
  slots: {
    "thread-head": async function ({ api, root }) {
      var button = document.createElement("button");
      button.id = "oc-upload-start";
      button.textContent = "アップロード開始";
      button.addEventListener("click", async function () {
        var result = document.createElement("pre");
        result.id = "oc-upload-result";
        try {
          var value = await api.upload.start();
          result.textContent = JSON.stringify(value);
        } catch (error) {
          result.textContent = JSON.stringify({ error: String(error.code || error.message) });
        }
        root.appendChild(result);
      });
      root.appendChild(button);
    }
  }
});`;

test.describe("プラグイン upload.start", () => {
  test("ホストのアップロードダイアログが開き、キャンセル結果が返る", async ({ page }) => {
    const name = unique("upload-rpc");
    const createResponse = await page.request.post(apiUrl("/v1/plugins"), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "upload.start の配線確認",
          scope: ["personal"],
          permissions: ["ui:slot", "upload:start"],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: ["thread-head"],
          hooks: [],
        },
        code: CODE,
        visibility: "private",
      },
    });
    expect(createResponse.status(), await createResponse.text()).toBe(201);
    const created = await readEnvelope<{ id: string }>(createResponse);
    if (!created || !created.ok) throw new Error("プラグイン作成に失敗");
    const pluginId = created.data.id;

    const installResponse = await page.request.post(apiUrl(`/v1/plugins/${pluginId}/install`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: { scope: "personal" },
    });
    expect(installResponse.status(), await installResponse.text()).toBe(201);

    await page.context().addCookies([
      { name: "oc_sess", value: "e2e-owner-session-token", domain: "localhost", path: "/" },
    ]);
    await page.goto("/plugins/demo/");

    const frame = page.frameLocator(`iframe[title="${name} プラグイン"]`).first();
    await expect(frame.locator("#oc-upload-start")).toBeVisible({ timeout: 15_000 });
    await frame.locator("#oc-upload-start").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("のアップロード");
    await expect(dialog.getByLabel("アップロードするファイル")).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toBeHidden();

    await expect(frame.locator("#oc-upload-result")).toHaveText('{"started":false}');

    // 後始末
    await page.request.post(apiUrl(`/v1/plugins/${pluginId}/uninstall`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE, "content-type": "application/json" },
      data: { scope: "personal" },
    });
    await page.request.delete(apiUrl(`/v1/plugins/${pluginId}`), {
      headers: { Origin: ALLOWED_ORIGIN, cookie: OWNER_COOKIE },
    });
  });
});