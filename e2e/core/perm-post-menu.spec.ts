// F6: スレッド画面のレス操作ボタンの権限別表示（モデレーター・副管理人・一般利用者）の E2E。
// pc / mobile 共通・並列実行（--workers=2）対応。

import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { ALLOWED_ORIGIN, WEB_BASE, apiUrl, readEnvelope } from "../helpers/api";
import { fakeIp, unique } from "../helpers/ids";
import { collectPageErrors, hideNextDevOverlay } from "../tour/dev-overlay";

const OWNER_COOKIE = "oc_sess=e2e-owner-session-token";
const MODERATOR_SESSION = "e2e-tour-moderator-session-token";
const PLAIN_USER_SESSION = "e2e-user-session-token";

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    cookie: OWNER_COOKIE,
    "x-turnstile-token": "1x00000000000000000000AA",
  };
}

async function createBoard(request: APIRequestContext): Promise<string> {
  const slug = unique("f6menu").toLowerCase();
  const response = await request.post(apiUrl("/v1/boards"), {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `権限UI板 ${slug.slice(-6)}`,
      category: "テスト",
      description: "F6 権限ボタン表示検証",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return slug;
}

async function createThreadAndReply(
  request: APIRequestContext,
  slug: string,
): Promise<{ threadId: number; replyNum: number }> {
  const threadRes = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: ownerHeaders(),
    data: { title: `権限UIスレ ${slug}`, body: ">>1 権限検証スレ本文" },
  });
  expect(threadRes.status(), await threadRes.text()).toBe(201);
  const threadEnv = await readEnvelope<{ threadId: number }>(threadRes);
  if (!threadEnv || !threadEnv.ok) throw new Error(`unexpected thread response: ${JSON.stringify(threadEnv)}`);

  const replyRes = await request.post(apiUrl(`/v1/threads/${threadEnv.data.threadId}/posts`), {
    headers: ownerHeaders(),
    data: { body: `>>2 操作ボタン確認用レス ${slug}` },
  });
  expect(replyRes.status(), await replyRes.text()).toBe(201);
  const replyEnv = await readEnvelope<{ post: { num: number } }>(replyRes);
  if (!replyEnv || !replyEnv.ok) throw new Error(`unexpected reply response: ${JSON.stringify(replyEnv)}`);

  return { threadId: threadEnv.data.threadId, replyNum: replyEnv.data.post.num };
}

async function setStaff(
  request: APIRequestContext,
  slug: string,
  accountName: string,
  level: "admin" | "deputy" | "moderator",
): Promise<void> {
  const response = await request.post(apiUrl(`/v1/boards/${slug}/staff`), {
    headers: ownerHeaders(),
    data: { accountName, level },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function registerAccount(
  request: APIRequestContext,
  prefix: string,
): Promise<{ name: string; sessionToken: string }> {
  const suffix = unique(prefix);
  const name = `deputy-${suffix}`;
  const email = `${name}@example.com`;
  const response = await request.post(apiUrl("/v1/auth/register"), {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "content-type": "application/json",
      "x-real-ip": fakeIp(Math.floor(Math.random() * 50_000) + 10_000),
    },
    data: { name, email, password: "perm-menu-pass-1234" },
  });
  expect(response.status(), await response.text()).toBe(201);
  const token = /oc_sess=([^;]+)/.exec(response.headers()["set-cookie"] ?? "")?.[1];
  expect(token, "登録後のセッション Cookie").toBeTruthy();
  return { name, sessionToken: token! };
}

async function useSession(context: BrowserContext, sessionToken: string): Promise<void> {
  const { hostname } = new URL(WEB_BASE);
  await context.clearCookies();
  await context.addCookies([
    { name: "oc_sess", value: sessionToken, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

let pageErrors: string[] = [];

test.beforeEach(({ page }) => {
  pageErrors = collectPageErrors(page);
});

test.afterEach(() => {
  expect(pageErrors, `ページ内で例外が発生しました: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("F6: モデレーターは非表示のみ・副管理人は両方・一般利用者はどちらも出ない", async ({
  page,
  context,
  request,
}) => {
  await hideNextDevOverlay(page);

  const slug = await createBoard(request);
  const { threadId, replyNum } = await createThreadAndReply(request, slug);
  await setStaff(request, slug, "trev-moderator", "moderator");
  const deputy = await registerAccount(request, "f6dep");
  await setStaff(request, slug, deputy.name, "deputy");

  const boardResponseMatcher = (url: string, status: number) => {
    try {
      return new URL(url).pathname === `/api/v1/boards/${slug}` && status === 200;
    } catch {
      return false;
    }
  };

  // 1. モデレーター (trev-moderator): 「全員から非表示」だけ出て、「削除」は出ない
  await useSession(context, MODERATOR_SESSION);
  await Promise.all([
    page.waitForResponse((res) => boardResponseMatcher(res.url(), res.status()), { timeout: 20_000 }),
    page.goto(`/b/${slug}/t/${threadId}?r=all`),
  ]);
  const modPost = page.locator(`#p${replyNum}`);
  await expect(modPost).toBeVisible({ timeout: 20_000 });
  await expect(modPost.getByRole("button", { name: "全員から非表示", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(modPost.getByRole("button", { name: "削除", exact: true })).toHaveCount(0);

  // 2. 副管理人: 「全員から非表示」と「削除」の両方が出る
  await useSession(context, deputy.sessionToken);
  await Promise.all([
    page.waitForResponse((res) => boardResponseMatcher(res.url(), res.status()), { timeout: 20_000 }),
    page.goto(`/b/${slug}/t/${threadId}?r=all`),
  ]);
  const deputyPost = page.locator(`#p${replyNum}`);
  await expect(deputyPost).toBeVisible({ timeout: 20_000 });
  await expect(deputyPost.getByRole("button", { name: "全員から非表示", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(deputyPost.getByRole("button", { name: "削除", exact: true })).toBeVisible({ timeout: 20_000 });

  // 3. 一般利用者 (test-user): どちらも出ない
  await useSession(context, PLAIN_USER_SESSION);
  await Promise.all([
    page.waitForResponse((res) => boardResponseMatcher(res.url(), res.status()), { timeout: 20_000 }),
    page.goto(`/b/${slug}/t/${threadId}?r=all`),
  ]);
  const userPost = page.locator(`#p${replyNum}`);
  await expect(userPost).toBeVisible({ timeout: 20_000 });
  await expect(userPost.getByRole("button", { name: "通報", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(userPost.getByRole("button", { name: "全員から非表示", exact: true })).toHaveCount(0);
  await expect(userPost.getByRole("button", { name: "削除", exact: true })).toHaveCount(0);
});
