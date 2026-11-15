// レビュー修正 B1/B2 の E2E（おーぷんクローン実利用レビュー修正）。
// - B1: 板内スレタイ検索＋全並び替え（勢い/新レス/新スレ/レス数・既定）で一致スレが同じ
// - B2: スレ一覧プレビューでレス1が二重表示されない
// PC（project=pc）と 360px（project=mobile）の両方で実行する。
// この spec は 360px 検証を含むため mobile プロジェクトで実行する。

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_SESSION = "e2e-owner-session-token";

function ownerHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${OWNER_SESSION}`,
  };
}

const SORTS = [
  { key: "speed", label: "勢い" },
  { key: "bump", label: "新レス" },
  { key: "created", label: "新スレ" },
  { key: "posts", label: "レス数" },
] as const;

async function seedBoardWithThreads(request: APIRequestContext): Promise<{
  slug: string;
  qaTitles: string[];
}> {
  const slug = unique("search").toLowerCase();
  const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `検索E2E板${slug.slice(-4)}`,
      category: "E2E",
      description: "B1/B2 の回帰検証用",
      settings: { turnstile: "off" },
    },
  });
  expect(boardResponse.status(), await boardResponse.text()).toBe(201);

  // 3 スレ: 2 件が「QA」を含むタイトル、1 件は含まない。レス数を変えて順位を分ける。
  const threads = [
    { title: `QA動作確認 ${slug}`, replies: 2 },
    { title: `QA板内検索 ${slug}`, replies: 1 },
    { title: `雑談 ${slug}`, replies: 5 },
  ];
  for (const thread of threads) {
    const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: ownerHeaders(),
      data: {
        title: thread.title,
        body: "1げっと\nこれは本文です",
        turnstileToken: "1x00000000000000000000AA",
      },
    });
    expect(threadResponse.status(), await threadResponse.text()).toBe(201);
    for (let index = 0; index < thread.replies; index++) {
      const threadEnvelope = await readEnvelope<{ threadId: number }>(threadResponse);
      if (!threadEnvelope || !threadEnvelope.ok) throw new Error("threadId の取得に失敗");
      const replyResponse = await request.post(
        `${API_BASE}/v1/threads/${threadEnvelope.data.threadId}/posts`,
        {
          headers: ownerHeaders(),
          data: { body: `レス${index + 2}`, turnstileToken: "1x00000000000000000000AA" },
        },
      );
      expect(replyResponse.status()).toBe(201);
    }
  }
  return { slug, qaTitles: [threads[0]!.title, threads[1]!.title] };
}

/** 板ページを開く（シェルルーター経由でリンクから入る） */
async function openBoard(page: Page, slug: string, name: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(name) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/b/${slug}`), { timeout: 15_000 });
  await expect(
    page.locator(".oc-board-title, .oc-sp-maintitle").filter({ hasText: name }).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
}

test.describe("板内検索と並び替え（B1）", () => {
  test("全ソートで検索語に一致する同じ 2 スレが返る（勢いで 0 件にならない）", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const { slug, qaTitles } = await seedBoardWithThreads(request);
    const boardName = `検索E2E板${slug.slice(-4)}`;

    // 既定ソート（勢い）で検索
    await openBoard(page, slug, boardName);
    await page.getByLabel("板内スレタイ検索").fill("QA");
    await page.locator("form.oc-sp-search").getByRole("button", { name: "検索", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}\\?q=QA`), { timeout: 15_000 });

    // 既定（sort 無し = speed）で QA 2 件が見える
    for (const title of qaTitles) {
      await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: 15_000 });
    }
    await page.screenshot({ path: "test-results-rv-plugins/shots/b1-search-speed-after-pc.png" });
    await expect(page.getByText("検索語「QA」に一致するスレがありません")).toHaveCount(0);

    // 各ソートに切り替えても同じ 2 スレが見える
    for (const sort of SORTS) {
      await page.getByRole("button", { name: sort.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`sort=${sort.key}`), { timeout: 15_000 });
      for (const title of qaTitles) {
        await expect(page.getByRole("link", { name: title })).toBeVisible({ timeout: 15_000 });
      }
      // 雑談スレは検索語に一致しないため出ない
      await expect(page.getByRole("link", { name: `雑談 ${slug}` })).toHaveCount(0);
    }

    // 0 件のときは「検索に一致するスレがありません」（板が空の案内と区別される）
    await page.getByLabel("板内スレタイ検索").fill("zzz-no-match");
    await page.locator("form.oc-sp-search").getByRole("button", { name: "検索", exact: true }).click();
    await expect(page.getByText("検索語「zzz-no-match」に一致するスレがありません")).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: "test-results-rv-plugins/shots/b1-search-zero-message-pc.png" });
    // 検索解除ボタンで戻る
    await page.getByRole("button", { name: "検索を解除" }).click();
    await expect(page).not.toHaveURL(/q=zzz/);
  });

  test("API 直接でも全ソート×検索語で一致数が同じ（ブラウザの URL 整合の裏付け）", async ({ request }) => {
    const { slug } = await seedBoardWithThreads(request);
    const sorts = [undefined, "speed", "bump", "posts", "created"];
    for (const sort of sorts) {
      const query = new URLSearchParams({ q: "QA", limit: "100" });
      if (sort) query.set("sort", sort);
      const response = await request.get(
        `${API_BASE}/v1/boards/${slug}/threads?${query.toString()}`,
        { headers: { Origin: ALLOWED_ORIGIN, Cookie: `oc_sess=${OWNER_SESSION}` } },
      );
      const body = await readEnvelope<{ items: Array<{ title: string }> }>(response);
      expect(body?.ok, `sort=${sort ?? "(指定なし)"}`).toBe(true);
      const items = body && body.ok ? body.data.items : [];
      expect(items, `sort=${sort ?? "(指定なし)"} で 2 件`).toHaveLength(2);
    }
  });
});

test.describe("スレ一覧プレビューのレス重複（B2）", () => {
  test("少ないレスのスレでレス1が 2 回表示されない", async ({ page, request }) => {
    test.setTimeout(120_000);
    const { slug } = await seedBoardWithThreads(request);
    const boardName = `検索E2E板${slug.slice(-4)}`;

    await openBoard(page, slug, boardName);

    // QA動作確認スレ（3 レス）のプレビュー: レス1 は「1 ：」として 1 回だけ現れる
    const threadRow = page.locator(".oc-thread-row").filter({ hasText: `QA動作確認 ${slug}` }).first();
    await expect(threadRow).toBeVisible({ timeout: 15_000 });

    // プレビューのレス番号収集（1 行 = .oc-preview-post / OP 抜粋 = .oc-thread-excerpt 内の .oc-preview-num）
    await expect
      .poll(
        async () => {
          const nums = await threadRow.locator(".oc-preview-num").allTextContents();
          return nums.map((text) => text.trim());
        },
        { timeout: 20_000 },
      )
      .toEqual(["1 ：", "2 ：", "3 ："]);
    await page.screenshot({ path: "test-results-rv-plugins/shots/b2-preview-nodup-pc.png" });

    // レス1が 2 回現れないこと（出現回数 1）
    const oneCounts = await threadRow.locator(".oc-preview-num", { hasText: "1 ：" }).count();
    expect(oneCounts).toBe(1);
  });
});
