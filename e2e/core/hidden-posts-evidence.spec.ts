// 「非表示のレス」の証拠スクリーンショット（通常のテスト実行では skip）。
// 使い方:
//   E2E_EVIDENCE=1 E2E_EVIDENCE_DIR=/path/to/10_証拠 \
//   pnpm exec playwright test core/hidden-posts-evidence.spec.ts --project=pc --project=mobile --workers=1
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OUT_DIR = process.env.E2E_EVIDENCE_DIR ?? "";

test.skip(!process.env.E2E_EVIDENCE, "E2E_EVIDENCE=1 のときだけ実行する");

const OWNER_COOKIE = "e2e-owner-session-token";
/** trev-deputy はツアーの spec が「最初の担当板」を前提に使うので、trev-moderator を使う。 */
const BOARD_ADMIN_COOKIE = "e2e-tour-moderator-session-token";

function authHeaders(cookie: string): Record<string, string> {
  return {
    Origin: process.env.E2E_ALLOWED_ORIGIN ?? process.env.E2E_WEB_URL ?? "http://localhost:3450",
    "content-type": "application/json",
    cookie: `oc_sess=${cookie}`,
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

function cookieDomain(): string {
  return new URL(process.env.E2E_WEB_URL ?? "http://localhost:3450").hostname;
}

async function useSession(context: BrowserContext, token: string): Promise<void> {
  await context.clearCookies();
  await context.addCookies([
    { name: "oc_sess", value: token, domain: cookieDomain(), path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function createWorld(request: APIRequestContext): Promise<{ slug: string; threadId: number; postId: number }> {
  const slug = unique("hpost").toLowerCase();
  const board = await request.post(apiUrl("/v1/boards"), {
    headers: authHeaders(OWNER_COOKIE),
    data: {
      slug,
      name: `非表示証拠 ${slug.slice(-4)}`,
      category: "E2E",
      description: "証拠用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(board.status(), await board.text()).toBe(201);

  const thread = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: authHeaders(OWNER_COOKIE),
    data: { title: `非表示証拠スレ ${slug}`, body: "1げっと" },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const threadBody = await readEnvelope<{ threadId: number }>(thread);
  if (!threadBody?.ok) throw new Error("スレ作成の応答が不正です");

  const staff = await request.post(apiUrl(`/v1/boards/${slug}/staff`), {
    headers: authHeaders(OWNER_COOKIE),
    data: { accountName: "trev-moderator", level: "admin" },
  });
  expect(staff.status(), await staff.text()).toBe(200);

  const reply = await request.post(apiUrl(`/v1/threads/${threadBody.data.threadId}/posts`), {
    headers: authHeaders(OWNER_COOKIE),
    data: { body: `全員から非表示にした証拠の本文です（${slug}）。管理画面から再表示できます。` },
  });
  expect(reply.status(), await reply.text()).toBe(201);
  const replyBody = await readEnvelope<{ post: { id: number } }>(reply);
  if (!replyBody?.ok) throw new Error("レス作成の応答が不正です");

  const hide = await request.post(apiUrl(`/v1/posts/${replyBody.data.post.id}/hide`), {
    headers: authHeaders(OWNER_COOKIE),
  });
  expect(hide.status(), await hide.text()).toBe(200);
  return { slug, threadId: threadBody.data.threadId, postId: replyBody.data.post.id };
}

function acceptNextDialog(page: Page, messages: string[]): void {
  page.once("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
}

test.describe("非表示レスの証拠", () => {
  test("板の管理画面とサイト管理画面の一覧・再表示", async ({ page, context, request }) => {
    const PROJECT = test.info().project.name === "mobile" ? "mobile" : "pc";
    const { slug } = await createWorld(request);

    // 板の管理画面「非表示のレス」タブ
    await useSession(context, BOARD_ADMIN_COOKIE);
    await page.goto(`/b/${slug}/manage/hidden`);
    await expect(page.getByRole("tab", { name: "非表示のレス" })).toHaveAttribute("aria-selected", "true", {
      timeout: 20_000,
    });
    const boardRow = page.locator(".oc-surface").filter({ hasText: `全員から非表示にした証拠の本文です（${slug}）` });
    await expect(boardRow).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${OUT_DIR}/01_${PROJECT}_board_manage_hidden_list.png`, fullPage: true });

    // サイト管理画面（板で絞り込み）
    await useSession(context, OWNER_COOKIE);
    await page.goto("/admin/hidden-posts");
    await page.getByLabel("板 slug").fill(slug);
    await page.getByRole("button", { name: "絞り込む" }).click();
    const adminRow = page.locator(".oc-surface").filter({ hasText: `全員から非表示にした証拠の本文です（${slug}）` });
    await expect(adminRow).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${OUT_DIR}/02_${PROJECT}_admin_hidden_posts_list.png`, fullPage: true });

    // 再表示後の一覧
    const dialogs: string[] = [];
    acceptNextDialog(page, dialogs);
    await adminRow.getByRole("button", { name: "再表示", exact: true }).click();
    await expect(page.locator(".oc-toast").filter({ hasText: "再表示しました" })).toBeVisible();
    await expect(adminRow).toHaveCount(0);
    await page.screenshot({ path: `${OUT_DIR}/03_${PROJECT}_admin_hidden_posts_after_restore.png`, fullPage: true });
    expect(dialogs[0]).toContain("再表示しますか");
  });
});