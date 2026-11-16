// 証拠スクリーンショット（通常実行では skip）。
// 使い方: E2E_EVIDENCE=1 E2E_EVIDENCE_DIR=.../81_証拠 E2E_TURNSTILE_STUB=1 \
//   pnpm exec playwright test core/turnstile-pass-evidence.spec.ts --project=pc
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl } from "../helpers/api";
import { unique } from "../helpers/ids";

const OUT_DIR = process.env.E2E_EVIDENCE_DIR ?? "";
test.skip(!process.env.E2E_EVIDENCE, "E2E_EVIDENCE=1 のときだけ実行する");

function shot(name: string): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return path.join(OUT_DIR, name);
}

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const apply = () => {
      if (document.getElementById("e2e-hide-next-dev-overlay")) return;
      const style = document.createElement("style");
      style.id = "e2e-hide-next-dev-overlay";
      style.textContent = "nextjs-portal,[data-nextjs-dev-overlay]{display:none !important}";
      document.head.appendChild(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
    else apply();
  });
  await page.addInitScript(() => {
    const widgets = new Map<string, { callback?: (token: string) => void }>();
    let seq = 0;
    (window as unknown as { turnstile: unknown }).turnstile = {
      render(_element: HTMLElement, options: { callback?: (token: string) => void }) {
        seq += 1;
        const id = `stub-${seq}`;
        widgets.set(id, options);
        const box = document.createElement("div");
        box.className = "stub-turnstile";
        box.textContent = "Turnstile（スタブ）";
        box.style.cssText = "width:300px;height:65px;background:#eef;border:1px dashed #88a";
        _element.appendChild(box);
        setTimeout(() => options.callback?.(`stub-token-${seq}`), 0);
        return id;
      },
      reset() {},
      remove(id: string) {
        document.getElementById(id)?.remove();
        widgets.delete(id);
      },
    };
  });
}

test("ロボット確認の省略の証拠", async ({ page, request }) => {
  await prepare(page);
  const slug = unique("tpev").toLowerCase();
  const headers = {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: "oc_sess=e2e-owner-session-token",
  };
  const board = await request.post(apiUrl("/v1/boards"), {
    headers,
    data: {
      slug,
      name: `省略の証拠 ${slug.slice(-4)}`,
      category: "E2E",
      settings: { turnstile: "anonymous", cooldownSeconds: 0, turnstilePassMinutes: 30 },
    },
  });
  expect(board.status(), await board.text()).toBe(201);
  const thread = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers,
    data: { title: "省略の証拠スレ", body: "1げっと", turnstileToken: "1x00000000000000000000AA" },
  });
  const threadId = ((await thread.json()) as { data: { threadId: number } }).data.threadId;

  await page.goto(`/b/${slug}/t/${threadId}`);
  await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
  const bar = page.locator(".oc-form-openbar").filter({ visible: true }).first();
  if ((await bar.count()) > 0) await bar.click();
  await page.locator(".oc-form textarea").fill("省略前: 1 回目はロボット確認が出る");
  await page.screenshot({ path: shot("01_pc_first_write_with_turnstile.png") });

  const posted = page.waitForResponse(
    (response) =>
      /\/api\/v1\/threads\/\d+\/posts$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "投稿する" }).click();
  expect((await posted).status()).toBe(201);
  await page.locator(".oc-form textarea").fill("省略後: 期限内は 2 回目以降ロボット確認が出ない");
  await expect(page.locator(".oc-form .oc-turnstile")).toHaveCount(0, { timeout: 20_000 });
  await page.screenshot({ path: shot("02_pc_second_write_without_turnstile.png") });
  void threadId;
});