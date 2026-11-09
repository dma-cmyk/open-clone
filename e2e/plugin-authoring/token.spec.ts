// WP-A E2E: 個人用プラグイン作成トークン + `/mcp-plugin`。
//
// 1. 画面で発行（step-up は TOTP をその場で計算 = スタブ相当）→ 平文 1 回 → 一覧は prefix のみ → 失効
// 2. 実際の MCP クライアントで list_templates → create_draft → check → add_version → publish(personal)
//    → install_self → スレ画面で本人にだけ効く → 失効後 401
// 3. TOTP 未設定アカウントでは発行導線の代わりに設定誘導を表示する
//
// トークンはテスト用アカウントに発行する（DB を本番に使わない E2E 専用）。外部サービスへは接続しない。

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { ALLOWED_ORIGIN, API_BASE, WEB_BASE, apiUrl, readEnvelope } from "../helpers/api";
import { fakeIp, unique } from "../helpers/ids";
import { stableTotpCode } from "../account/totp";

const PASSWORD = "e2e-pass-1234";

test.describe.configure({ mode: "serial" });

interface AccountWithTotp {
  cookie: string;
  cookieValue: string;
  secret: string;
}

function originHeaders(cookie?: string): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    ...(cookie ? { cookie } : {}),
  };
}

async function registerWithTotp(request: APIRequestContext): Promise<AccountWithTotp> {
  const email = `${unique("wpa").toLowerCase()}@example.com`;
  const response = await request.post(`${API_BASE}/v1/auth/register`, {
    headers: { ...originHeaders(), "x-real-ip": fakeIp() },
    data: { name: unique("WPA"), email, password: PASSWORD },
  });
  expect(response.status(), await response.text()).toBe(201);
  const cookieValue = /oc_sess=([^;]+)/.exec(response.headers()["set-cookie"] ?? "")?.[1];
  expect(cookieValue, "登録 API のセッション Cookie").toBeTruthy();
  const cookie = `oc_sess=${cookieValue}`;

  const setup = await request.post(`${API_BASE}/v1/auth/totp/setup`, { headers: originHeaders(cookie), data: {} });
  expect(setup.status(), await setup.text()).toBe(200);
  const setupBody = await readEnvelope<{ secret: string }>(setup);
  if (!setupBody?.ok) throw new Error(`TOTP setup failed: ${JSON.stringify(setupBody)}`);
  const secret = setupBody.data.secret;

  const enable = await request.post(`${API_BASE}/v1/auth/totp/enable`, {
    headers: originHeaders(cookie),
    data: { code: await stableTotpCode(secret) },
  });
  expect(enable.status(), await enable.text()).toBe(200);
  return { cookie, cookieValue: cookieValue!, secret };
}

async function issueTokenViaApi(request: APIRequestContext, account: AccountWithTotp, name: string): Promise<string> {
  const stepUp = await request.post(`${API_BASE}/v1/auth/step-up`, {
    headers: originHeaders(account.cookie),
    data: { code: await stableTotpCode(account.secret) },
  });
  expect(stepUp.status(), await stepUp.text()).toBe(200);
  const created = await request.post(`${API_BASE}/v1/me/plugin-tokens`, {
    headers: originHeaders(account.cookie),
    data: { name },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await readEnvelope<{ token: string; prefix: string }>(created);
  if (!body?.ok) throw new Error(`token issue failed: ${JSON.stringify(body)}`);
  return body.data.token;
}

async function setSessionCookie(context: BrowserContext, cookieValue: string): Promise<void> {
  const { hostname } = new URL(WEB_BASE);
  await context.addCookies([
    { name: "oc_sess", value: cookieValue, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function connectMcp(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${API_BASE}/mcp-plugin`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: "open-clone-wp-a-e2e", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return client;
}

function toolJson<T>(result: { content: unknown }): T {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text) as T;
}

const SPOILER_RULE = {
  pattern: "\\[sp\\]([\\s\\S]*?)\\[/sp\\]",
  flags: "g",
  template: "$1",
  kind: "spoiler",
};

test("画面で発行: step-up → 平文は 1 回だけ → 一覧は prefix のみ → 接続手順 → 失効", async ({
  page,
  context,
  request,
}) => {
  const account = await registerWithTotp(request);
  await setSessionCookie(context, account.cookieValue);
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/account/plugin-tokens/");
  await expect(page.getByRole("heading", { name: "プラグイン作成トークン" })).toBeVisible();
  await expect(page.getByText("まだトークンがありません")).toBeVisible();
  await expect(page.getByText("トークン発行には二段階認証（TOTP）が必要です")).toHaveCount(0);

  await page.locator("#token-name").fill("E2E 用トークン");
  await page.getByRole("button", { name: "発行する" }).click();

  // step-up ダイアログ（TOTP コードはテスト側で計算する）
  await expect(page.getByRole("dialog", { name: "TOTP 再認証" })).toBeVisible();
  await page.locator('[role="dialog"] input').fill(await stableTotpCode(account.secret));
  await page.getByRole("button", { name: "認証して実行" }).click();

  const panel = page.locator(".oc-warn-box", { hasText: "このトークンは再表示できません" });
  await expect(panel).toBeVisible();
  const token = (await panel.locator("pre").first().textContent())?.trim() ?? "";
  expect(token).toMatch(/^ocp_[A-Za-z0-9_-]{43}$/);
  const prefix = token.slice(0, 12);

  await page.screenshot({ path: test.info().outputPath("token-issued.png"), fullPage: true });

  // 接続手順は実際の API オリジン + /mcp-plugin を表示する（決定9）
  await expect(page.getByText(`${API_BASE}/mcp-plugin/legacy`).first()).toBeVisible();
  await page.getByRole("button", { name: "ChatGPT" }).click();
  await expect(page.getByText("現在は未対応です。")).toBeVisible();

  // 閉じると平文は消え、一覧には prefix のみ
  await page.getByRole("button", { name: "保存したので閉じる" }).click();
  await expect(page.getByText(token)).toHaveCount(0);
  const row = page.locator("tr", { hasText: "E2E 用トークン" });
  await expect(row).toContainText(`${prefix}…`);
  await expect(row).not.toContainText(token);

  // 個別失効
  await expect(row.getByText("有効")).toBeVisible();
  await row.getByRole("button", { name: "失効" }).click();
  await expect(row.getByText("失効済み")).toBeVisible();
  await expect(page.getByText("「E2E 用トークン」を失効しました。")).toBeVisible();
});

test("MCP ライフサイクル: 下書き作成 → 個人公開 → 個人導入 → 本人にだけ表示 → 失効後 401", async ({
  page,
  context,
  browser,
  request,
}) => {
  const account = await registerWithTotp(request);
  const token = await issueTokenViaApi(request, account, "E2E MCP トークン");
  const name = unique("wpa-spoiler").replaceAll("_", "-").slice(0, 41);

  const client = await connectMcp(token);
  try {
    const templates = await client.callTool({ name: "authoring.list_templates", arguments: {} });
    expect(templates.isError).toBeFalsy();
    expect(toolJson<{ templates: { id: string }[] }>(templates).templates).toHaveLength(7);

    const checked = await client.callTool({ name: "authoring.check", arguments: { code: "eval('1')" } });
    expect(toolJson<{ checks: { allowed: boolean } }>(checked).checks.allowed).toBe(false);

    const createInput = {
      manifest: {
        name,
        version: "1.0.0",
        summary: "E2E のネタバレ伏せ（WP-A）",
        scope: ["personal"],
        permissions: [],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: [],
        hooks: [],
        render: { post: [SPOILER_RULE] },
      },
      code: "register({});",
      changelog: "E2E 初版",
      templateId: "spoiler",
    };
    const created = await client.callTool({ name: "authoring.create_draft", arguments: createInput });
    expect(created.isError).toBeFalsy();
    const pluginId = toolJson<{ pluginId: string }>(created).pluginId;
    expect(pluginId).toBeTruthy();

    const added = await client.callTool({
      name: "authoring.add_version",
      arguments: { pluginId, code: "register({});", changelog: "E2E 修正版" },
    });
    expect(added.isError).toBeFalsy();
    expect(toolJson<{ version: string }>(added).version).toBe("1.0.1");

    const preview = await client.callTool({ name: "authoring.preview", arguments: { pluginId } });
    expect(preview.isError).toBeFalsy();
    expect(toolJson<{ previewUrl: string }>(preview).previewUrl).toBe(`/plugins/new?id=${pluginId}`);

    const published = await client.callTool({
      name: "authoring.publish",
      arguments: { pluginId, scopes: ["personal"] },
    });
    expect(published.isError).toBeFalsy();
    expect(toolJson<{ status: string }>(published).status).toBe("published");

    const installed = await client.callTool({ name: "authoring.install_self", arguments: { pluginId } });
    expect(installed.isError).toBeFalsy();
    expect(toolJson<{ installed: boolean; scope: string }>(installed)).toMatchObject({
      installed: true,
      scope: "personal",
    });
  } finally {
    await client.close();
  }

  // スレを作る（投稿本文は [sp]...[/sp]）
  const slug = unique("wpa").toLowerCase();
  const board = await request.post(apiUrl("/v1/boards"), {
    headers: originHeaders(account.cookie),
    data: {
      slug,
      name: `WPA板${slug.slice(-4)}`,
      category: "E2E",
      description: "WP-A E2E",
      settings: { turnstile: "off" },
    },
  });
  expect(board.status(), await board.text()).toBe(201);
  const thread = await request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: originHeaders(account.cookie),
    data: {
      title: `WPA スレ ${slug}`,
      body: "これは [sp]本人にだけ伏せられる秘密[/sp] です。",
      turnstileToken: "1x00000000000000000000AA",
    },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const threadBody = await readEnvelope<{ threadId: number }>(thread);
  if (!threadBody?.ok) throw new Error("スレ作成の応答が不正です");

  await setSessionCookie(context, account.cookieValue);
  await page.goto(`/b/${encodeURIComponent(slug)}/t/${threadBody.data.threadId}`);
  await expect(page.getByText("本人にだけ伏せられる秘密")).toBeVisible();
  await expect(page.locator(".oc-plugin-render-spoiler").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("thread-personal.png"), fullPage: true });

  // 未ログインの閲覧者には適用されない（personal 導入）
  const anonymous = await browser.newContext();
  try {
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(`/b/${encodeURIComponent(slug)}/t/${threadBody.data.threadId}`);
    await expect(anonymousPage.getByText("本人にだけ伏せられる秘密")).toBeVisible();
    await expect(anonymousPage.locator(".oc-plugin-render-spoiler")).toHaveCount(0);
    await expect(anonymousPage.getByText("[sp]本人にだけ伏せられる秘密[/sp]")).toBeVisible();
  } finally {
    await anonymous.close();
  }

  // 失効後は 401（tools/call も接続自体も拒否される）
  const listed = await request.get(apiUrl("/v1/me/plugin-tokens"), { headers: originHeaders(account.cookie) });
  const listBody = await readEnvelope<{ items: { id: string }[] }>(listed);
  if (!listBody?.ok) throw new Error("トークン一覧の応答が不正です");
  const tokenId = listBody.data.items[0]!.id;
  const revoked = await request.delete(apiUrl(`/v1/me/plugin-tokens/${tokenId}`), {
    headers: originHeaders(account.cookie),
  });
  expect(revoked.status(), await revoked.text()).toBe(200);

  const raw = await request.post(apiUrl("/mcp-plugin"), {
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "authoring.list", arguments: {} } },
  });
  expect(raw.status()).toBe(401);
  await expect(connectMcp(token)).rejects.toBeTruthy();
});

test("TOTP 未設定では発行前に設定を促す（発行ボタンは無効）", async ({ page, context }) => {
  // seed の一般ユーザー（TOTP 未登録）
  await setSessionCookie(context, "e2e-user-session-token");
  await page.goto("/account/plugin-tokens/");
  await expect(page.getByText("トークン発行には二段階認証（TOTP）が必要です")).toBeVisible();
  await expect(page.getByRole("link", { name: "TOTP を設定する" })).toHaveAttribute("href", "/account/totp");
  await expect(page.getByRole("button", { name: "発行する" })).toBeDisabled();
});