// プラグイン RPC `notify` が、スレ・板の画面でも既存のトースト（toast.show）に
// つながっていることを確認する。メッセージは文字で出し、500 文字を超える分は切り捨てる。

import { expect, test, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";

const PLUGIN_CODE = `register({
  slots: {
    "thread-bottom": function ({ api, root }) {
      var normal = document.createElement("button");
      normal.id = "oc-notify";
      normal.textContent = "通知を出す";
      normal.addEventListener("click", function () {
        api.notify.show("プラグインからのお知らせ");
      });
      root.appendChild(normal);

      var long = document.createElement("button");
      long.id = "oc-notify-long";
      long.textContent = "長い通知を出す";
      long.addEventListener("click", function () {
        api.notify.show("長い通知:" + new Array(594).join("あ"));
      });
      root.appendChild(long);
    }
  }
});`;

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

async function login(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3410");
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

test.describe("プラグインの通知（notify）", () => {
  // 作ったプラグイン（同じ e2e-user の個人導入）を消す。残すと、同じ利用者で
  // thread-bottom を数える別の spec に iframe が増える。
  const createdPluginIds: string[] = [];
  test.afterEach(async ({ request }) => {
    for (const id of createdPluginIds.splice(0)) {
      await request.delete(apiUrl(`/v1/plugins/${id}`), { headers: userHeaders() });
    }
  });

  test("スレ画面のトーストに文字で出て、500 文字で切られる", async ({ page, context }) => {
    await login(context);

    const slug = unique("notify").toLowerCase();
    const board = await page.request.post(apiUrl("/v1/boards"), {
      headers: userHeaders(),
      data: {
        slug,
        name: `通知板${slug.slice(-4)}`,
        category: "E2E",
        settings: { turnstile: "off", cooldownSeconds: 0 },
      },
    });
    expect(board.status(), await board.text()).toBe(201);
    const thread = await page.request.post(apiUrl(`/v1/boards/${slug}/threads`), {
      headers: userHeaders(),
      data: { title: `通知スレ ${slug}`, body: "通知の確認", turnstileToken: "1x00000000000000000000AA" },
    });
    expect(thread.status(), await thread.text()).toBe(201);
    const threadBody = await readEnvelope<{ threadId: number }>(thread);
    if (!threadBody?.ok) throw new Error("スレ作成に失敗しました");

    const name = unique("notify-plugin").toLowerCase().slice(0, 40);
    const created = await page.request.post(apiUrl("/v1/plugins"), {
      headers: userHeaders(),
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "通知の確認",
          scope: ["personal"],
          permissions: ["ui:slot", "notify"],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: ["thread-bottom"],
          hooks: [],
        },
        code: PLUGIN_CODE,
        visibility: "private",
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const createdBody = await readEnvelope<{ id: string }>(created);
    if (!createdBody?.ok) throw new Error("プラグイン作成に失敗しました");
    createdPluginIds.push(createdBody.data.id);
    const installed = await page.request.post(apiUrl(`/v1/plugins/${createdBody.data.id}/install`), {
      headers: userHeaders(),
      data: { scope: "personal" },
    });
    expect(installed.status(), await installed.text()).toBe(201);

    await page.goto(`/b/${slug}/t/${threadBody.data.threadId}`);
    const frame = page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
    await expect(frame.getByRole("button", { name: "通知を出す", exact: true })).toBeVisible({ timeout: 20_000 });

    await frame.getByRole("button", { name: "通知を出す", exact: true }).click();
    await expect(page.locator(".oc-toast").filter({ hasText: "プラグインからのお知らせ" })).toBeVisible();

    await frame.getByRole("button", { name: "長い通知を出す", exact: true }).click();
    const longToast = page.locator(".oc-toast").filter({ hasText: "長い通知:" });
    await expect(longToast).toHaveCount(1);
    await expect(longToast).toBeVisible();
    const text = (await longToast.textContent()) ?? "";
    expect(text.startsWith("長い通知:")).toBe(true);
    expect(text).toHaveLength(500);

    const dir = path.join(process.env.E2E_OUTPUT_DIR ?? "test-results", "plugin-label-shots");
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: path.join(dir, `notify-toast-${test.info().project.name}.png`),
      fullPage: false,
    });
  });
});