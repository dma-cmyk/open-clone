// プラグインの宣言的レンダー規則が有効でも、レス本文の基本描画（安価・URL・AA）が壊れず、
// 規則由来の文字列が HTML として解釈されないことを実ブラウザで検証する（回帰テスト）。
import { expect, test, type BrowserContext } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

// owner ではなくテスト用一般アカウントを使う。レンダー規則は導入したアカウントにだけ効くため、
// 万一後始末に失敗しても他の spec（owner セッション）の描画へ影響しない。
const USER_SESSION = "e2e-user-session-token";

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

async function loginAsTestUser(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3107");
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

const SPOILER_RULE = {
  pattern: "\\[spoiler\\]([\\s\\S]*?)\\[/spoiler\\]",
  flags: "g",
  template: "$1",
  kind: "spoiler" as const,
};

const EVIL_RULE = {
  pattern: "\\[x\\]([\\s\\S]*?)\\[/x\\]",
  flags: "g",
  template: '<img src=x onerror="window.__xss=1">$1',
  kind: "text" as const,
};

test.describe("プラグインのレンダー規則と本文描画", () => {
  test("規則が有効でも安価・URL・AA が動作し、規則由来の HTML は文字列として描画される", async ({
    page,
    context,
    request,
  }) => {
    await loginAsTestUser(context);

    const slug = unique("render").toLowerCase();
    const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
      headers: userHeaders(),
      data: {
        slug,
        name: `描画規則板${slug.slice(-4)}`,
        category: "E2E",
        description: "レンダー規則の回帰検証用",
        settings: { turnstile: "off" },
      },
    });
    expect(boardResponse.status(), await boardResponse.text()).toBe(201);

    const threadTitle = `レンダー規則スレ ${slug}`;
    const threadBody = [
      "1げっと >>2",
      "https://example.com/path",
      "[spoiler]秘密 https://example.org/inner >>2[/spoiler]",
      "[x]悪意[/x]",
    ].join("\n");
    const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: userHeaders(),
      data: { title: threadTitle, body: threadBody, turnstileToken: "1x00000000000000000000AA" },
    });
    expect(threadResponse.status(), await threadResponse.text()).toBe(201);
    const thread = await readEnvelope<{ threadId: number }>(threadResponse);
    if (!thread || !thread.ok) throw new Error("スレ作成の応答が不正です");

    const replyResponse = await request.post(`${API_BASE}/v1/threads/${thread.data.threadId}/posts`, {
      headers: userHeaders(),
      data: { body: "2げっと", turnstileToken: "1x00000000000000000000AA" },
    });
    expect(replyResponse.status(), await replyResponse.text()).toBe(201);

    const name = unique("render-rules");
    const createResponse = await request.post(`${API_BASE}/v1/plugins`, {
      headers: userHeaders(),
      data: {
        manifest: {
          name,
          version: "1.0.0",
          summary: "レンダー規則の回帰検証",
          scope: ["personal"],
          permissions: [],
          connectAllowlist: [],
          entry: "plugin.js",
          slots: [],
          hooks: [],
          render: { post: [SPOILER_RULE, EVIL_RULE] },
        },
        code: "register({});",
        visibility: "private",
        changelog: "e2e",
      },
    });
    expect(createResponse.status(), await createResponse.text()).toBe(201);
    const created = await readEnvelope<{ id: string }>(createResponse);
    if (!created || !created.ok) throw new Error("プラグイン作成に失敗");
    const pluginId = created.data.id;

    const installResponse = await request.post(`${API_BASE}/v1/plugins/${pluginId}/install`, {
      headers: userHeaders(),
      data: { scope: "personal" },
    });
    expect(installResponse.status(), await installResponse.text()).toBe(201);

    try {
      // AA 設定を有効にして、規則が有効でも AA のコンテナ・改行が維持されることを見る。
      await page.addInitScript(() => {
        window.localStorage.setItem("oc.settings.v1", JSON.stringify({ display: { aa: true } }));
      });

      await page.goto("/");
      await page.getByRole("link", { name: new RegExp(`描画規則板${slug.slice(-4)}`) }).first().click();
      await page.getByRole("link", { name: new RegExp(threadTitle) }).first().click();
      await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });

      // 安価: 規則の外と内（spoiler のキャプチャ内）の両方がボタンとして描画される。
      const anchors = page.locator("#p1 .oc-anchor");
      await expect(anchors).toHaveCount(2);
      await anchors.first().click();
      const popup = page.getByRole("dialog", { name: "安価のプレビュー" });
      await expect(popup).toBeVisible();
      await expect(popup).toContainText(">>2");
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();

      // URL: 規則の外と内の両方がリンクとして残る。
      await expect(page.locator('#p1 a[href="https://example.com/path"]')).toBeVisible();
      const spoiler = page.locator("#p1 .oc-plugin-render-spoiler").first();
      await expect(spoiler).toContainText("秘密");
      await expect(spoiler.locator('a[href="https://example.org/inner"]')).toHaveCount(1);

      // XSS: テンプレートの <img onerror> は文字列として表示され、要素にはならない。
      const evil = page.locator("#p1 .oc-plugin-render-text").first();
      await expect(evil).toContainText('<img src=x onerror="window.__xss=1">');
      await expect(evil.locator("img")).toHaveCount(0);
      await expect(page.locator('#p1 img[src="x"]')).toHaveCount(0);
      const xssFlag = await page.evaluate(() => {
        const value: unknown = Reflect.get(window, "__xss");
        return typeof value === "number" ? value : null;
      });
      expect(xssFlag).toBeNull();

      // AA: 本文コンテナが oc-aa のまま（規則 span を含む）で、改行が保持されている。
      const main = page.locator("#p1 .oc-post-main").first();
      await expect(main).toHaveClass(/oc-aa/);
      await expect(main.locator(".oc-plugin-render-spoiler")).toHaveCount(1);
    } finally {
      await request.post(`${API_BASE}/v1/plugins/${pluginId}/uninstall`, {
        headers: userHeaders(),
        data: { scope: "personal" },
      });
      await request.delete(`${API_BASE}/v1/plugins/${pluginId}`, { headers: userHeaders() });
    }
  });

  test("静的判定を無効化しても危険な規則でメインスレッドが止まらない（Worker 実行）", async ({
    page,
    context,
    request,
  }) => {
    await loginAsTestUser(context);

    const slug = unique("redos-worker").toLowerCase();
    const boardResponse = await request.post(`${API_BASE}/v1/boards`, {
      headers: userHeaders(),
      data: {
        slug,
        name: `ReDoS Worker 板${slug.slice(-4)}`,
        category: "E2E",
        description: "Worker 実行の回帰検証用",
        settings: { turnstile: "off" },
      },
    });
    expect(boardResponse.status(), await boardResponse.text()).toBe(201);

    // 1 レス目: `(?:a|\w)+x` が指数的にバックトラックする 29 文字。
    // 2 レス目: `(a+)+b` が指数的にバックトラックする約 2,000 文字（表示上限 2,048 以内）。
    const shortAttack = `${"a".repeat(28)}!`;
    const longAttack = `${"a".repeat(2_000)}!`;
    const threadBody = `[spoiler]秘密[/spoiler] >>2\n${shortAttack}`;
    const threadResponse = await request.post(`${API_BASE}/v1/boards/${slug}/threads`, {
      headers: userHeaders(),
      data: { title: `ReDoS Worker スレ ${slug}`, body: threadBody, turnstileToken: "1x00000000000000000000AA" },
    });
    expect(threadResponse.status(), await threadResponse.text()).toBe(201);
    const thread = await readEnvelope<{ threadId: number }>(threadResponse);
    if (!thread || !thread.ok) throw new Error("スレ作成の応答が不正です");
    const threadId = thread.data.threadId;

    const replyResponse = await request.post(`${API_BASE}/v1/threads/${threadId}/posts`, {
      headers: userHeaders(),
      data: { body: longAttack, turnstileToken: "1x00000000000000000000AA" },
    });
    expect(replyResponse.status(), await replyResponse.text()).toBe(201);

    // `/v1/plugins/active` の応答に、静的検査を通らない危険な規則を差し込む
    // （既に導入済み・旧検証をすり抜けた規則を再現する。API の検証経路は変えない）。
    const manifestBase = {
      name: "e2e-redos-worker",
      version: "1.0.0",
      summary: "Worker 実行の回帰検証",
      scope: ["personal"],
      permissions: [],
      connectAllowlist: [],
      entry: "plugin.js",
      slots: [],
      hooks: [],
    };
    const activeItems = [
      {
        installId: "e2e-spoiler",
        pluginId: "e2e-spoiler",
        name: "e2e-spoiler",
        version: "1.0.0",
        scope: "personal",
        scopeRef: USER_SESSION,
        stopped: false,
        status: "published",
        codeUrl: "",
        pinned: false,
        config: null,
        manifest: { ...manifestBase, render: { post: [SPOILER_RULE] } },
      },
      {
        installId: "e2e-redos-worker",
        pluginId: "e2e-redos-worker",
        name: "e2e-redos-worker",
        version: "1.0.0",
        scope: "personal",
        scopeRef: USER_SESSION,
        stopped: false,
        status: "published",
        codeUrl: "",
        pinned: false,
        config: null,
        manifest: {
          ...manifestBase,
          render: {
            post: [
              { pattern: "(?:a|\\w)+x", flags: "g", template: "$1", kind: "text" },
              { pattern: "(a+)+b", flags: "g", template: "$1", kind: "text" },
            ],
          },
        },
      },
    ];
    await page.route("**/api/v1/plugins/active*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { items: activeItems } }),
      });
    });

    // 静的判定の無効化は開発ビルド + localStorage のフラグでのみ有効（本番では無視される）。
    // 併せて rAF のフレーム間隔を記録し、メインスレッドが止まっていないことを測る。
    await page.addInitScript(() => {
      window.localStorage.setItem("oc.e2e.disable-regex-static", "1");
      const probe = { maxGap: 0, frames: 0 };
      Reflect.set(window, "__ocFrameProbe", probe);
      let last = performance.now();
      const tick = (): void => {
        const current = performance.now();
        const gap = current - last;
        if (gap > probe.maxGap) probe.maxGap = gap;
        probe.frames += 1;
        last = current;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const startedAt = Date.now();
    await page.goto(`/b/${encodeURIComponent(slug)}/t/${threadId}`);
    await expect(page.locator("#p1")).toBeVisible({ timeout: 15_000 });
    // 未対策なら 1 レス目の exec だけで数秒、2 レス目は実質停止する。15 秒以内に描画されれば
    // メインスレッドはブロックされていない。
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    // 危険な規則は Worker 内で時間切れになり、その規則だけが無効化される。
    // 同じ規則集合にある公式サンプル（spoiler）は従来どおり変換される。
    const spoiler = page.locator("#p1 .oc-plugin-render-spoiler").first();
    await expect(spoiler).toContainText("秘密", { timeout: 15_000 });
    await expect(page.locator("#p1 .oc-plugin-render-text")).toHaveCount(0);
    await expect(page.locator("#p1 .oc-post-main")).toContainText("a".repeat(28));

    // 開発ビルド専用の観測カウンタで、危険な規則が実際に Worker へ渡り、
    // 時間切れで terminate されたこと（= 静的判定の無効化が効いていること）を確認する。
    const workerStats = await page.evaluate(() => {
      const value: unknown = Reflect.get(window, "__ocRenderWorkerStats");
      if (!value || typeof value !== "object") return { requests: 0, ruleTimeouts: 0 };
      const requests = Reflect.get(value, "requests");
      const ruleTimeouts = Reflect.get(value, "ruleTimeouts");
      return {
        requests: typeof requests === "number" ? requests : 0,
        ruleTimeouts: typeof ruleTimeouts === "number" ? ruleTimeouts : 0,
      };
    });
    expect(workerStats.requests).toBeGreaterThan(0);
    expect(workerStats.ruleTimeouts).toBeGreaterThanOrEqual(2);

    const probe = await page.evaluate(() => {
      const value: unknown = Reflect.get(window, "__ocFrameProbe");
      if (!value || typeof value !== "object") return { maxGap: Number.POSITIVE_INFINITY, frames: 0 };
      const maxGap = Reflect.get(value, "maxGap");
      const frames = Reflect.get(value, "frames");
      return {
        maxGap: typeof maxGap === "number" ? maxGap : Number.POSITIVE_INFINITY,
        frames: typeof frames === "number" ? frames : 0,
      };
    });
    expect(probe.frames).toBeGreaterThan(10);
    expect(probe.maxGap).toBeLessThan(1_500);

    // クリックも即座に反応する（安価プレビューの開閉）。
    await page.locator("#p1 .oc-anchor").first().click();
    const popup = page.getByRole("dialog", { name: "安価のプレビュー" });
    await expect(popup).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
  });

  test("危険な正規表現を含むレンダー規則は作成時に拒否される", async ({ request }) => {
    // (a+)+b に加え、第2回 M-2 の「可変長を含む並びの繰り返し」と、
    // 第3回 M-3 の「繰り返すグループ本体の lookaround」も拒否する。
    for (const pattern of [
      "(a+)+b",
      "(a+[ab])+x",
      "(\\w+a)+x",
      "(?:a+[b])+x",
      "(?=(a+[ab])+)",
      "((?=a+)a)+x",
      "((?=\\w+)\\w)+x",
      "((?=(a+))a)+x",
      "(?:a|\\w)+x",
      "(a|\\w)+x",
      "(?:a|[ab])+x",
      "(?:[ab]|a)+x",
      "(?:\\d|1)+x",
      "(?:a|[a-z])+x",
    ]) {
      const name = unique("redos").toLowerCase();
      const response = await request.post(`${API_BASE}/v1/plugins`, {
        headers: userHeaders(),
        data: {
          manifest: {
            name,
            version: "1.0.0",
            summary: "ReDoS の回帰検証",
            scope: ["personal"],
            permissions: [],
            connectAllowlist: [],
            entry: "plugin.js",
            slots: [],
            hooks: [],
            render: { post: [{ pattern, flags: "g", template: "$1", kind: "text" }] },
          },
          code: "register({});",
          visibility: "private",
          changelog: "e2e",
        },
      });
      expect(response.status(), `${pattern}: ${await response.text()}`).toBe(400);
      const body = await readEnvelope<{ code?: string }>(response);
      if (body && !body.ok) expect(body.code, pattern).toBe("VALIDATION");
    }
  });
});