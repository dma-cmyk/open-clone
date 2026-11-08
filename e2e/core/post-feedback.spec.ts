// core: 投稿のフィードバック表示。
// 直前の投稿成功トースト（「投稿しました」）と、次の投稿のエラー（429）が併存して
// 状態が矛盾して見えないことを実ブラウザで検証する。
// 回帰: 送信開始時に前のトーストを消す（apps/web/src/features/board-ui/post-form.tsx）。
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { API_BASE, ALLOWED_ORIGIN, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_SESSION = "e2e-owner-session-token";

async function loginAsOwner(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await context.addCookies([
    { name: "oc_sess", value: OWNER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${OWNER_SESSION}`,
  };
}

async function expandPostForm(page: Page): Promise<void> {
  const bar = page.locator(".oc-form-openbar").filter({ visible: true }).first();
  if ((await bar.count()) > 0) await bar.click();
}

test.describe("投稿フィードバック: 成功トーストとエラーの併存を防ぐ", () => {
  test("連投で 429 になったとき、前回の「投稿しました」トーストは残らない", async ({ page, context, request }) => {
    await loginAsOwner(context);

    // 連投制限 10 秒の板とスレを API で用意する（UI 操作の検証に集中する）。
    const slug = unique("toast").toLowerCase();
    const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
      headers: ownerHeaders(),
      data: {
        slug,
        name: `トースト板${slug.slice(-4)}`,
        category: "E2E",
        description: "投稿フィードバック検証用",
        settings: { turnstile: "off", cooldownSeconds: 10 },
      },
    });
    expect(boardResponse.status(), await boardResponse.text()).toBe(201);

    const threadTitle = `トースト検証スレ ${slug}`;
    const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: ownerHeaders(),
      data: { title: threadTitle, body: "1げっと" },
    });
    expect(threadResponse.status(), await threadResponse.text()).toBe(201);
    const threadBody = await readEnvelope<{ threadId: number }>(threadResponse);
    if (!threadBody?.ok) throw new Error("スレ作成の応答が不正です");

    // クライアントルーティングなのでリンクで入る。
    await page.goto("/");
    await page.getByRole("link", { name: new RegExp(`トースト板${slug.slice(-4)}`) }).first().click();
    await page.getByRole("link", { name: new RegExp(threadTitle) }).first().click();
    await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });

    // 1 通目: 成功 → 「投稿しました」トーストが出る。
    await expandPostForm(page);
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: /^投稿する$/ }) }).first();
    await form.locator("textarea").first().fill(`1通目 ${Date.now()}`);
    const firstPost = page.waitForResponse(
      (response) => /\/api\/v1\/threads\/\d+\/posts$/.test(new URL(response.url()).pathname) && response.request().method() === "POST",
    );
    await form.getByRole("button", { name: /^投稿する$/ }).click();
    expect((await firstPost).status()).toBe(201);

    const successToast = page.locator(".oc-toast").filter({ hasText: "投稿しました" });
    await expect(successToast).toBeVisible({ timeout: 5_000 });

    // 2 通目: 連投制限で 429。送信開始時に前の成功トーストが消え、エラーだけが残る。
    await form.locator("textarea").first().fill(`2通目 ${Date.now()}`);
    const secondPost = page.waitForResponse(
      (response) => /\/api\/v1\/threads\/\d+\/posts$/.test(new URL(response.url()).pathname) && response.request().method() === "POST",
    );
    await form.getByRole("button", { name: /^投稿する$/ }).click();
    expect((await secondPost).status()).toBe(429);

    await expect(form.locator(".oc-error")).toBeVisible({ timeout: 5_000 });
    await expect(form.locator(".oc-error")).toContainText(/連投間隔/);
    // ここは「待って消えるのを許す」toHaveCount(0) ではなく即時評価にする。
    // トーストは 3.8 秒で自動消滅するため、待つと修正前でも通ってしまう。
    expect(await page.locator(".oc-toast").count()).toBe(0);
    // 併存しないことの追加確認: エラー表示中に成功文言が画面に無い。
    await expect(page.getByText("投稿しました")).toHaveCount(0);
  });
});