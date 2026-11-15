// rv-core A7/A8/A12: スレ画面の細かな状態と狭幅のタップ領域。
// 回帰対象: F-09（新着後に「最終◯分前」と安価の被参照表示が古い）、
//           F-10 / museAI #7（スレ内検索を解除しても入力欄が残る）、
//           F-11（板一覧・検索・逆順・引用・通報などの操作領域が 17〜32px と小さい）。
import { expect, test, type Locator } from "@playwright/test";
import { createBoard, createThread, expandPostForm, postForm, postReply } from "./rv-core-helpers";

test.describe("rv-core A8: スレ内検索の解除", () => {
  test("「解除」で入力欄も空になる", async ({ page, request }) => {
    const slug = await createBoard(request);
    const threadId = await createThread(request, slug, { body: "検索対象の本文です" });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });

    const input = page.getByLabel("スレ内検索");
    await input.fill("検索対象");
    await page.locator(".oc-thread-head form").getByRole("button", { name: "検索" }).click();
    await expect(page).toHaveURL(/[?&]q=/, { timeout: 20_000 });
    await expect(page.locator(".oc-badge", { hasText: "スレ内検索:" })).toBeVisible();

    await page.getByRole("button", { name: "解除" }).click();
    await expect(page.locator(".oc-badge", { hasText: "スレ内検索:" })).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(page).not.toHaveURL(/[?&]q=/);
  });
});

test.describe("rv-core A7: 新着・自分の投稿後の表示更新", () => {
  test("自分の投稿に含めた安価が、再読み込みなしで相手レスに出る", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "1番目のレス" });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expandPostForm(page);

    const form = postForm(page);
    await form.locator("textarea").fill(">>1 への返信です");
    const posted = page.waitForResponse(
      (response) =>
        new RegExp(`/api/v1/threads/${threadId}/posts$`).test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "投稿する" }).click();
    expect((await posted).status()).toBe(201);

    // レス1 の被参照表示（安価）が、リロードせずに 2 を指す
    await expect(page.locator("#p1 .oc-backlinks")).toContainText("安価 2", { timeout: 20_000 });

    // 「最終◯分前」は最後のレス時刻を指す（投稿直後なので「たった今」）
    await expect(page.locator(".oc-range-nav")).toContainText("最終 たった今");
  });

  test("新着（実況）で届いたレスでも安価と最終時刻が更新される", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "1番目のレス" });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#p1 .oc-backlinks")).toHaveCount(0);

    // 実況を ON にして外部（API）から返信を足し、受信で本文・安価が更新されることを見る
    await page.getByRole("button", { name: /実況/ }).click();
    await postReply(request, threadId, ">>1 新着の安価テスト");

    await expect(page.locator(".oc-post", { hasText: "新着の安価テスト" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#p1 .oc-backlinks")).toContainText("安価 2", { timeout: 20_000 });
  });

  test("相対時刻は時間経過で更新される（時計を進めて確認）", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug);
    await page.clock.install();
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    const nav = page.locator(".oc-range-nav");
    await expect(nav).toContainText("最終 たった今");

    // 30 秒ごとの再計算 + 経過時間で「分前」に変わる
    await page.clock.fastForward("02:10");
    await expect(nav).toContainText("最終 2分前", { timeout: 20_000 });
  });
});

test.describe("rv-core A12: 狭幅（360px）の操作領域", () => {
  test("板一覧・スレ内検索・逆順・引用・通報・最新50 が 44px 前後になる", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "狭幅タップ領域の確認" });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });

    const boxes: Array<{ label: string; height: number }> = [];
    const measure = async (label: string, locator: Locator) => {
      const box = await locator.first().boundingBox();
      expect(box, `${label} の位置が取れません`).not.toBeNull();
      boxes.push({ label, height: box?.height ?? 0 });
    };

    await measure("スレ内検索ボタン", page.locator(".oc-thread-head form button"));
    await measure("逆順", page.getByRole("button", { name: "逆順" }));
    await measure("レス操作（引用）", page.locator("#p1 .oc-post-actions button", { hasText: "引用" }));
    await measure("レス操作（通報）", page.locator("#p1 .oc-post-actions button", { hasText: "通報" }));
    await measure("最新50へ", page.getByRole("button", { name: "最新50へ" }));
    await measure("スレナビ（全部）", page.locator(".oc-sp-threadnav a").first());
    await measure("板名リンク", page.locator(".oc-sp-maintitle a").first());

    for (const box of boxes) {
      expect(box.height, `${box.label} の高さが ${box.height}px（44px 未満）`).toBeGreaterThanOrEqual(42);
    }
  });
});

test.describe("rv-core R2: 最終時刻は表示範囲に巻き戻らない", () => {
  test("古い 1 件だけを見せても、スレ全体の最新時刻を「最終」に出す", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "1番目のレス" });
    await postReply(request, threadId, "最新のレス");
    const now = Math.floor(Date.now() / 1000);
    // スレ全体は「たった今」更新、表示対象のレスだけ 1 時間前に差し替える
    await page.route(new RegExp(`/api/v1/threads/${threadId}(\\?|$)`), async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      try {
        const response = await route.fetch();
        const data = (await response.json()) as {
          ok: boolean;
          data: { thread: { lastPostAt: number }; posts: Array<{ createdAt: number }> };
        };
        data.data.thread.lastPostAt = now;
        data.data.posts = data.data.posts.map((post) => ({ ...post, createdAt: now - 3600 }));
        await route.fulfill({ response, json: data });
      } catch {
        // ページ遷移でリクエストが破棄された場合は何もしない（初回応答の描画結果だけを検証する）。
      }
    });

    await page.goto(`/b/${slug}/t/${threadId}?r=1`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    // 表示レスは 1 時間前でも、最終はスレ全体の最新（たった今）
    await expect(page.locator(".oc-range-nav")).toContainText("最終 たった今");

    // 検索・ID 抽出で絞っても巻き戻らない
    await page.getByLabel("スレ内検索").fill("1番目のレス");
    await page.locator(".oc-thread-head form").getByRole("button", { name: "検索" }).click();
    await expect(page.locator(".oc-range-nav")).toContainText("最終 たった今", { timeout: 20_000 });
  });

  test("新着受信後は再読み込みなしで進む（範囲表示中でも）", async ({ page, request }) => {
    const slug = await createBoard(request, { turnstile: "off" });
    const threadId = await createThread(request, slug, { body: "1番目のレス" });
    await page.goto(`/b/${slug}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-range-nav")).toContainText("最終 たった今");
    const before = await page.locator(".oc-range-nav").innerText();

    // 実況 ON で新着を 1 件受け取ると、最終時刻が最新レスに追従する
    await page.getByRole("button", { name: /実況/ }).click();
    await postReply(request, threadId, ">>1 新着のレス");
    await expect(page.locator(".oc-post", { hasText: "新着のレス" })).toBeVisible({ timeout: 30_000 });
    // 時刻は「たった今」のまま（新しい方が勝つ）＋レス数表示は進む
    await expect(page.locator(".oc-range-nav")).toContainText("最終 たった今");
    expect(before).toContain("最終");
  });
});

test.describe("rv-core R2b: スレを移ったら最終時刻をそのスレの値へ切り替える", () => {
  test("古いスレ→新しいスレ、新しいスレ→古いスレの両方向で巻き戻らない", async ({ page, request }) => {
    // 時計を固定して秒境界の揺れを避ける（Sol の指摘）。
    const fixed = new Date("2026-11-15T12:00:00+09:00");
    await page.clock.setFixedTime(fixed);
    const fixedSeconds = Math.floor(fixed.getTime() / 1000);

    const slug = await createBoard(request, { turnstile: "off" });
    const freshThread = await createThread(request, slug, { title: "rvcore 新しいスレ", body: "新しいスレの 1" });
    const oldThread = await createThread(request, slug, { title: "rvcore 古いスレ", body: "古いスレの 1" });

    // 新しいスレは「たった今」、古いスレは「1時間前」として返す（サーバー時刻を差し替える）。
    await page.route(/\/api\/v1\/threads\/\d+(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const target = new URL(route.request().url()).pathname.split("/").pop();
      try {
        const response = await route.fetch();
        const data = (await response.json()) as {
          ok: boolean;
          data: { thread: { id: number; lastPostAt: number } };
        };
        data.data.thread.lastPostAt = target === String(freshThread) ? fixedSeconds : fixedSeconds - 3600;
        await route.fulfill({ response, json: data });
      } catch {
        // 遷移でリクエストが破棄された場合は何もしない。
      }
    });

    await page.goto(`/b/${slug}/t/${freshThread}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-range-nav")).toContainText("最終 たった今");

    // 新しいスレ → 古いスレ（板へ戻ってから入る = SPA 遷移。ThreadView は同じインスタンスのまま）
    await page.locator(".oc-thread-sub a:visible, .oc-sp-maintitle a:visible").first().click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}$`), { timeout: 20_000 });
    await page.getByRole("link", { name: /rvcore 古いスレ/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}/t/${oldThread}`), { timeout: 20_000 });
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    // 前スレの「たった今」を持ち越さず、このスレの 1 時間前になる
    await expect(page.locator(".oc-range-nav")).toContainText("最終 1時間前", { timeout: 20_000 });

    // 古いスレ → 新しいスレ（逆方向）
    await page.locator(".oc-thread-sub a:visible, .oc-sp-maintitle a:visible").first().click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}$`), { timeout: 20_000 });
    await page.getByRole("link", { name: /rvcore 新しいスレ/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/b/${slug}/t/${freshThread}`), { timeout: 20_000 });
    await expect(page.locator("#p1")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".oc-range-nav")).toContainText("最終 たった今", { timeout: 20_000 });
  });
});
