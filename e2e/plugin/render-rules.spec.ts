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