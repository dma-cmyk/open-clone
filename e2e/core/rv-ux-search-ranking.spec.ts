// rv-ux C1〜C3: サイト内検索のスニペット・空検索案内・種別切替と追加読込の世代管理。
// 実スタック（next dev + wrangler dev + D1）を webServer で起動する前提。
// C4（ランキングの空白）は事実確認01で本番再現なし・レビューでも修正不要のため対象外。
import fs from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type BrowserContext, type TestInfo } from "@playwright/test";
import { API_BASE, ALLOWED_ORIGIN } from "../helpers/api";
import { unique } from "../helpers/ids";

const OWNER_SESSION = "e2e-owner-session-token";

/** e2e の tsconfig（lib < es2024）に Promise.withResolvers が無いため executor 形で待つ。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * スクリーンショットの出力先。既定は Playwright のテスト出力ディレクトリで、
 * 証拠を残したいときだけ E2E_EVIDENCE_DIR で指定する（レビュー UX-M2: 個人の絶対パス固定を廃止）。
 */
function shotPath(info: TestInfo, name: string): string {
  const dir = process.env.E2E_EVIDENCE_DIR ?? info.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function ownerHeaders(): Record<string, string> {
  return { Origin: ALLOWED_ORIGIN, "content-type": "application/json", Cookie: `oc_sess=${OWNER_SESSION}` };
}

async function loginAsOwner(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3131");
  await context.addCookies([
    { name: "oc_sess", value: OWNER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

/** 伏せ字各種を含むスレを作り、検索語（マーカー）を返す。 */
async function seedSpoilerThread(request: APIRequestContext, marker: string): Promise<string> {
  const slug = unique("rvuxsp").toLowerCase();
  const board = await request.post(`${API_BASE}/v1/boards`, {
    headers: ownerHeaders(),
    data: {
      slug,
      name: `スニペット板${slug.slice(-4)}`,
      category: "E2E",
      description: "C1 スニペット検証用",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(board.status(), await board.text()).toBe(201);
  const thread = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
    headers: ownerHeaders(),
    data: {
      title: `伏せ字スレ ${marker}`,
      body: [
        `[sp]QA伏せ字表示テスト ${marker} の中身[/sp]`,
        `可見の文 ${marker} 外側`,
        `[sp]改行を含む伏せ字 ${marker}\n二行目も隠す[/sp]`,
        `[sp]角括弧[1]を含む伏せ字 ${marker}[/sp]`,
        `||組み込み伏せ字 ${marker}||`,
        `[b]通常の強調 ${marker}[/b]`,
      ].join("\n"),
      turnstileToken: "1x00000000000000000000AA",
    },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  return slug;
}

test.describe("rv-ux C1〜C3（検索）", () => {
  test("C1: スニペットの伏せ字は隠し、通常装飾の中身は残す", async ({ page, context, request }, info) => {
    const marker = unique("spmask");
    await seedSpoilerThread(request, marker);
    await loginAsOwner(context);

    await page.goto(`/search?q=${marker}&type=full`);
    const results = page.locator(".oc-panel", { hasText: "の検索結果" });
    await expect(results).toBeVisible({ timeout: 20_000 });
    await expect(results).toContainText(marker);

    // 生タグがそのまま見えていた不具合（museAI #9）の回帰: [sp] / [/sp] を出さない。
    const snippets = page.locator(".oc-post-main");
    await expect(snippets.first()).toBeVisible();
    for (let index = 0; index < (await snippets.count()); index += 1) {
      await expect(snippets.nth(index)).not.toContainText("[sp]");
      await expect(snippets.nth(index)).not.toContainText("[/sp]");
    }
    // 伏せ字記法の中身（1行・改行・角括弧・組み込み）は検索結果から読めない。
    const all = await results.innerText();
    expect(all).not.toContain("の中身");
    expect(all).not.toContain("二行目も隠す");
    expect(all).not.toContain("を含む伏せ字");
    expect(all).not.toContain("組み込み伏せ字");
    // 伏せ字として表示する。
    await expect(snippets.first()).toContainText("伏せ字");
    // 通常装飾 [b] の中身は消さない（レビュー UX-R1 の反例）。
    await expect(results).toContainText("通常の強調");

    await page.screenshot({ path: shotPath(info, "c1-after-pc.png") });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: shotPath(info, "c1-after-360.png") });
  });

  test("C2: 空のサイト内検索で案内を出す", async ({ page }, info) => {
    // ヘッダ検索を空欄で実行したときと同じ URL（/search?q=）。
    await page.goto("/search?q=");
    await expect(page.getByText("検索語を入力してください").first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shotPath(info, "c2-after-pc.png") });
    await page.setViewportSize({ width: 360, height: 740 });
    await page.screenshot({ path: shotPath(info, "c2-after-360.png") });
  });

  test("C3: 種別切替中は古い結果を新しい種別名と組にしない", async ({ page, context, request }, info) => {
    const marker = unique("switch");
    await seedSpoilerThread(request, marker);
    await loginAsOwner(context);

    await page.goto(`/search?q=${marker}&type=thread`);
    await expect(page.locator(".oc-panel", { hasText: "の検索結果" })).toContainText("種別: スレタイ", {
      timeout: 20_000,
    });

    // 全文の応答だけを遅延させ、切替直後の中間状態を観測する。
    await page.route("**/api/v1/search**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("type") === "full") {
        await sleep(4_000);
      }
      try {
        await route.continue();
      } catch {
        // リクエストがキャンセルされた場合は無視する
      }
    });

    await page.getByRole("tab", { name: "全文" }).click();
    // 取得中は結果パネル自体を出さない（新しい種別名＋古い結果の組合せを排除 / F-15）。
    await expect(page.locator(".oc-panel-title", { hasText: "種別: 全文" })).toBeHidden();
    await expect(page.getByText(/検索中…/).first()).toBeVisible();
    await page.screenshot({ path: shotPath(info, "c3-after-pc.png") });

    // 応答後は新しい種別の結果が表示される。
    await expect(page.locator(".oc-panel-title", { hasText: "種別: 全文" })).toBeVisible({ timeout: 20_000 });
    await page.unroute("**/api/v1/search**");
  });

  test("C3: 古い追加読込の応答が新しい検索結果へ混入しない（UX-R2）", async ({ page }, info) => {
    // 初回（スレタイ・2ページ目あり）→ 追加読込を保留 → 全文へ切替 → 全文を表示 →
    // 保留していた古い追加読込を解放しても、全文パネルへスレタイ項目が混ざらない。
    let staleRequested = false;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    await page.route("**/api/v1/search**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/suggest")) {
        try {
          await route.continue();
        } catch {
          // 無視
        }
        return;
      }
      if (url.searchParams.has("cursor")) {
        staleRequested = true;
        await gate;
        try {
          await route.fulfill({
            json: {
              ok: true,
              data: {
                type: "thread",
                items: [
                  {
                    type: "thread",
                    thread: {
                      id: 901,
                      title: "STALE_THREAD_LOAD_MORE",
                      postCount: 1,
                      lastPostAt: 1760000000,
                      createdAt: 1760000000,
                      boardSlug: "e2e",
                      boardName: "E2E",
                    },
                  },
                ],
                nextCursor: null,
              },
            },
          });
        } catch {
          // 無視
        }
        return;
      }
      if (url.searchParams.get("type") === "full") {
        try {
          await route.fulfill({
            json: {
              ok: true,
              data: {
                type: "full",
                items: [
                  {
                    type: "post",
                    post: {
                      id: 902,
                      threadId: 902,
                      num: 1,
                      name: "n",
                      body: "FRESH_FULL_BODY",
                      createdAt: 1760000000,
                      idHash: "RV32",
                    },
                    thread: { id: 902, title: "full thread", boardSlug: "e2e", boardName: "E2E" },
                  },
                ],
                nextCursor: null,
              },
            },
          });
        } catch {
          // 無視
        }
        return;
      }
      try {
        await route.fulfill({
          json: {
            ok: true,
            data: {
              type: "thread",
              items: [
                {
                  type: "thread",
                  thread: {
                    id: 903,
                    title: "FIRST_THREAD",
                    postCount: 1,
                    lastPostAt: 1760000000,
                    createdAt: 1760000000,
                    boardSlug: "e2e",
                    boardName: "E2E",
                  },
                },
              ],
              nextCursor: "old-page-two",
            },
          },
        });
      } catch {
        // 無視
      }
    });

    await page.goto("/search?q=stale-check&type=thread");
    await expect(page.getByText("FIRST_THREAD", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "さらに読み込む" }).click();
    await expect.poll(() => staleRequested).toBe(true);

    await page.getByRole("tab", { name: "全文", exact: true }).click();
    await expect(page.getByText("FRESH_FULL_BODY", { exact: true })).toBeVisible({ timeout: 20_000 });

    releaseGate();
    await sleep(500);
    // 全文パネルに古いスレタイ結果が混ざっていない。件数も1件のまま。
    await expect(page.getByText("STALE_THREAD_LOAD_MORE", { exact: true })).toHaveCount(0);
    await expect(page.locator(".oc-panel-title", { hasText: "種別: 全文" })).toContainText("1 件");
    await page.screenshot({ path: shotPath(info, "c3-after-loadmore-pc.png") });
    await page.unroute("**/api/v1/search**");
  });
});
