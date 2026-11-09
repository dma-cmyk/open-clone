// core: 未ログインのつぶやき。
// 板設定 turnstile=anonymous で、ブラウザの Turnstile トークンがつぶやき API へ渡り 201 になることを検証する。
// Turnstile のスクリプト/検証はスタブ化し、外部サービスへは接続しない。

import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";

test.describe("core: 未ログイン つぶやき", () => {
  test("Turnstile トークンを渡して つぶやき が送信できる", async ({ page, request }) => {
    const slug = unique("tsubuyaki");
    const boardName = `つぶやき板${slug.slice(-4)}`;
    const board = await request.post(`${API_BASE}/v1/boards`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: OWNER_COOKIE },
      data: {
        slug,
        name: boardName,
        category: "E2E",
        description: "つぶやき E2E",
        settings: { turnstile: "anonymous", cooldownSeconds: 0 },
      },
    });
    expect(board.status(), await board.text()).toBe(201);

    const title = `つぶやきスレ ${slug}`;
    const created = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: OWNER_COOKIE },
      data: { title, body: "つぶやきのテスト" },
    });
    expect(created.status(), await created.text()).toBe(201);
    const envelope = await readEnvelope<{ threadId: number }>(created);
    if (!envelope || !envelope.ok) throw new Error("スレ作成の応答が不正です");
    const threadId = envelope.data.threadId;

    // Turnstile ウィジェットのスクリプトをスタブ化（render/ reset で即 callback）。
    await page.addInitScript(() => {
      const widgets = new Map<string, { callback?: (token: string) => void }>();
      let seq = 0;
      (window as unknown as { turnstile: unknown }).turnstile = {
        render(_element: HTMLElement, options: { callback?: (token: string) => void }) {
          seq += 1;
          const id = `stub-${seq}`;
          widgets.set(id, options);
          setTimeout(() => options.callback?.(`stub-token-${seq}`), 0);
          return id;
        },
        reset(id: string) {
          const options = widgets.get(id);
          if (options) setTimeout(() => options.callback?.(`stub-token-${Date.now()}`), 0);
        },
        remove(id: string) {
          widgets.delete(id);
        },
      };
    });

    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });

    const button = page.getByRole("button", { name: /つぶやき/ }).first();
    const panel = page.getByRole("complementary", { name: "つぶやき" });
    if (!(await panel.isVisible())) await button.click();
    await expect(panel).toBeVisible();

    const body = `未ログイン つぶやき ${Date.now()}`;
    await panel.getByLabel("つぶやき本文").fill(body);
    const posted = page.waitForResponse(
      (response) => /\/api\/v1\/threads\/\d+\/tsubuyaki$/.test(response.url()) && response.request().method() === "POST",
    );
    await panel.getByRole("button", { name: "送信" }).click();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(201);
    const sent: unknown = response.request().postDataJSON();
    expect(sent).toMatchObject({ body });
    const sentToken =
      sent && typeof sent === "object" && "turnstileToken" in sent ? sent.turnstileToken : undefined;
    if (typeof sentToken !== "string") throw new Error("つぶやきリクエストに turnstileToken がありません");
    expect(sentToken.length).toBeGreaterThan(0);

    await expect(panel.locator(".oc-tsubuyaki-log")).toContainText(body, { timeout: 15_000 });
  });
});