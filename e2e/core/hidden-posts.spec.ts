// 全員から非表示にしたレスを管理画面から戻せることの E2E（pc / mobile 共通）。
//  1. 板スタッフがレスのメニューから「全員から非表示」→ 一般の人には見えない
//     → 板の管理画面「非表示のレス」に出る → 再表示 → 一般の人に見える
//  2. サイト管理画面「/admin/hidden-posts」から再表示できる（板の絞り込みも使える）

import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";
import { collectPageErrors, hideNextDevOverlay } from "../tour/dev-overlay";

const OWNER_COOKIE = "e2e-owner-session-token";
/** seed の trev-deputy。この板では管理人（admin）として任せ、レス操作の UI を出す。 */
const BOARD_ADMIN_COOKIE = "e2e-tour-deputy-session-token";

function authHeaders(cookie: string): Record<string, string> {
  return {
    Origin: process.env.E2E_ALLOWED_ORIGIN ?? process.env.E2E_WEB_URL ?? "http://localhost:3450",
    "content-type": "application/json",
    cookie: `oc_sess=${cookie}`,
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("hidden").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: authHeaders(OWNER_COOKIE),
    data: {
      slug,
      name: `非表示E2E ${slug.slice(-4)}`,
      category: "E2E",
      description: "非表示レスの再表示の検証用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThread(request: APIRequestContext, slug: string): Promise<number> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: authHeaders(OWNER_COOKIE),
    data: { title: `非表示E2E スレ ${Date.now()}`, body: "1げっと" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = await readEnvelope<{ threadId: number }>(response);
  if (!body?.ok) throw new Error("スレ作成の応答が不正です");
  return body.data.threadId;
}

async function reply(request: APIRequestContext, threadId: number, text: string): Promise<{ id: number; num: number }> {
  const response = await request.post(apiUrl(`/v1/threads/${threadId}/posts`), {
    headers: authHeaders(OWNER_COOKIE),
    data: { body: text },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = await readEnvelope<{ post: { id: number; num: number } }>(response);
  if (!body?.ok) throw new Error("レス作成の応答が不正です");
  return { id: body.data.post.id, num: body.data.post.num };
}

async function setStaff(
  request: APIRequestContext,
  slug: string,
  accountName: string,
  level: "admin" | "deputy" | "moderator",
): Promise<void> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/staff`), {
    headers: authHeaders(OWNER_COOKIE),
    data: { accountName, level },
  });
  expect(response.status(), await response.text()).toBe(200);
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

/** 次の confirm() だけを許可する（ハンドラを残すと 2 回目のダイアログで二重に処理される）。 */
function acceptNextDialog(page: Page, messages: string[]): void {
  page.once("dialog", (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
}

test("板スタッフが全員から非表示 → 管理画面の一覧 → 再表示で一般の人にも戻る", async ({
  page,
  context,
  request,
}) => {
  const pageErrors = collectPageErrors(page);
  await hideNextDevOverlay(page);

  const slug = await createBoard(request);
  const threadId = await createThread(request, slug);
  const target = await reply(request, threadId, `全員から非表示にする本文 ${slug}`);
  await setStaff(request, slug, "trev-deputy", "admin");

  // 一般の人（セッションなし）には見えている
  await page.goto(`/b/${slug}/t/${threadId}?r=all`);
  await expect(page.locator(`#p${target.num}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`#p${target.num}`)).toContainText("全員から非表示にする本文");

  // 板スタッフとしてレスのメニューから「全員から非表示」
  await useSession(context, BOARD_ADMIN_COOKIE);
  await page.goto(`/b/${slug}/t/${threadId}?r=all`);
  const post = page.locator(`#p${target.num}`);
  await expect(post).toBeVisible({ timeout: 20_000 });
  const dialogs: string[] = [];
  acceptNextDialog(page, dialogs);
  await post.getByRole("button", { name: "全員から非表示", exact: true }).click();
  await expect(page.locator(".oc-toast").filter({ hasText: "全員から非表示にしました" })).toBeVisible();
  expect(dialogs[0]).toContain("全員から見えなくなります");
  expect(dialogs[0]).toContain("「非表示のレス」から戻せます");
  await expect(page.locator(`#p${target.num}`)).toHaveCount(0);

  // 一般の人には見えない
  await context.clearCookies();
  await page.goto(`/b/${slug}/t/${threadId}?r=all`);
  await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`#p${target.num}`)).toHaveCount(0);

  // 板の管理画面「非表示のレス」タブに出る
  await useSession(context, BOARD_ADMIN_COOKIE);
  await page.goto(`/b/${slug}/manage/hidden`);
  await expect(page.getByRole("tab", { name: "非表示のレス" })).toHaveAttribute("aria-selected", "true", {
    timeout: 20_000,
  });
  const row = page.locator(".oc-surface").filter({ hasText: `全員から非表示にする本文 ${slug}` });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(`レス ${target.num}`);
  await expect(row).toContainText("非表示にした人: trev-deputy");

  // 再表示
  acceptNextDialog(page, dialogs);
  await row.getByRole("button", { name: "再表示", exact: true }).click();
  await expect(page.locator(".oc-toast").filter({ hasText: "再表示しました" })).toBeVisible();
  expect(dialogs[1]).toContain("再表示しますか");
  await expect(row).toHaveCount(0);

  // 一般の人に見えるようになる
  await context.clearCookies();
  await page.goto(`/b/${slug}/t/${threadId}?r=all`);
  await expect(page.locator(`#p${target.num}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`#p${target.num}`)).toContainText("全員から非表示にする本文");

  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("サイト管理画面の「非表示のレス」から再表示でき、板で絞り込める", async ({ page, context, request }) => {
  const pageErrors = collectPageErrors(page);
  await hideNextDevOverlay(page);

  const slug = await createBoard(request);
  const threadId = await createThread(request, slug);
  const target = await reply(request, threadId, `サイト管理から戻す本文 ${slug}`);

  // サイト管理者として非表示にする（API。ボタンの経路は 1 本目のテストで確認済み）
  const hide = await request.post(apiUrl(`/v1/posts/${target.id}/hide`), {
    headers: authHeaders(OWNER_COOKIE),
  });
  expect(hide.status(), await hide.text()).toBe(200);

  await useSession(context, OWNER_COOKIE);
  await page.goto("/admin/hidden-posts");
  // 管理メニューに載っている
  const navLink = page.locator('nav[aria-label="管理メニュー"] a[href="/admin/hidden-posts"]');
  await expect(navLink).toBeVisible({ timeout: 20_000 });
  await expect(navLink).toHaveText("非表示のレス");

  // 板スラッグで絞り込む
  await page.getByLabel("板 slug").fill(slug);
  await page.getByRole("button", { name: "絞り込む" }).click();
  const row = page.locator(".oc-surface").filter({ hasText: `サイト管理から戻す本文 ${slug}` });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText(slug);

  // 再表示
  const dialogs: string[] = [];
  acceptNextDialog(page, dialogs);
  await row.getByRole("button", { name: "再表示", exact: true }).click();
  await expect(page.locator(".oc-toast").filter({ hasText: "再表示しました" })).toBeVisible();
  expect(dialogs[0]).toContain("再表示しますか");
  await expect(row).toHaveCount(0);

  // API 上も一覧から消え、スレでは見える
  const listed = await request.get(apiUrl(`/v1/admin/hidden-posts?board=${slug}`), {
    headers: authHeaders(OWNER_COOKIE),
  });
  const envelope = await readEnvelope<{ items: Array<{ postId: number }> }>(listed);
  expect(envelope?.ok).toBe(true);
  if (envelope?.ok) expect(envelope.data.items.some((item) => item.postId === target.id)).toBe(false);

  await context.clearCookies();
  await page.goto(`/b/${slug}/t/${threadId}?r=all`);
  await expect(page.locator(`#p${target.num}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`#p${target.num}`)).toContainText("サイト管理から戻す本文");

  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});