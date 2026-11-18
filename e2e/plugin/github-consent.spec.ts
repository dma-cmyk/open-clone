// GitHub 権限（github:gist）の「その都度確認」の E2E。
//
// - プラグインが Gist へ書き込もうとすると、ホストが書き込み先・大きさ・内容の先頭を見せる
// - 「やめる」では API を呼ばない（プラグインには CANCELED が返る）
// - 「書き込む」で、表示した値と同じ内容が送られる
//
// GitHub API へは直接アクセスしない。E2E_GITHUB_STUB=1（スタブ）でのみ実行する。

import fs from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";
import { unique } from "../helpers/ids";

const USER_SESSION = "e2e-user-session-token";
const STUB_TOKEN = "gho_e2e_dummy_token_1234567890";
const GITHUB_STUB = process.env.E2E_GITHUB_STUB === "1";

const GIST_CONTENT = "1行目のテキスト\n2行目のテキスト\n3行目のテキスト\n4行目のテキスト";

const PLUGIN_CODE = `register({
  slots: {
    "thread-bottom": function ({ api, root }) {
      var button = document.createElement("button");
      button.id = "oc-gist-write";
      button.textContent = "Gist に保存";
      button.addEventListener("click", async function () {
        var out = document.createElement("pre");
        out.id = "oc-gist-result";
        try {
          var result = await api.github.createGist({
            filename: "note.txt",
            content: ${JSON.stringify(GIST_CONTENT)},
            description: "E2E consent",
            public: false
          });
          out.textContent = "OK:" + result.htmlUrl;
        } catch (error) {
          out.textContent = "ERR:" + (error && (error.code || error.message));
        }
        root.appendChild(out);
      });
      root.appendChild(button);
    }
  }
});`;

function userHeaders(): Record<string, string> {
  return {
    Origin: ALLOWED_ORIGIN,
    "content-type": "application/json",
    Cookie: `oc_sess=${USER_SESSION}`,
  };
}

function shotPath(name: string): string {
  const dir = path.join(process.env.E2E_OUTPUT_DIR ?? "test-results", "plugin-label-shots");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}-${test.info().project.name}.png`);
}

async function login(context: BrowserContext): Promise<void> {
  const { hostname } = new URL(process.env.E2E_WEB_URL ?? "http://localhost:3410");
  await context.addCookies([
    { name: "oc_sess", value: USER_SESSION, domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
}

async function prepare(page: Page): Promise<{ threadPath: string; name: string }> {
  // スタブの GitHub に PAT で連携する（アカウントは e2e-user）。
  const linked = await page.request.post(apiUrl("/v1/github/link/pat"), {
    headers: userHeaders(),
    data: { token: STUB_TOKEN },
  });
  if (linked.status() !== 200) throw new Error(`PAT 連携失敗: ${await linked.text()}`);

  const slug = unique("ghconsent").toLowerCase();
  const board = await page.request.post(apiUrl("/v1/boards"), {
    headers: userHeaders(),
    data: {
      slug,
      name: `GitHub 確認板${slug.slice(-4)}`,
      category: "E2E",
      settings: { turnstile: "off", cooldownSeconds: 0 },
    },
  });
  expect(board.status(), await board.text()).toBe(201);

  const thread = await page.request.post(apiUrl(`/v1/boards/${slug}/threads`), {
    headers: userHeaders(),
    data: {
      title: `GitHub 確認スレ ${slug}`,
      body: "確認の窓を出すスレです",
      turnstileToken: "1x00000000000000000000AA",
    },
  });
  expect(thread.status(), await thread.text()).toBe(201);
  const threadBody = await readEnvelope<{ threadId: number }>(thread);
  if (!threadBody?.ok) throw new Error("スレ作成に失敗しました");

  const name = unique("ghconsent-plugin").toLowerCase().slice(0, 40);
  const created = await page.request.post(apiUrl("/v1/plugins"), {
    headers: userHeaders(),
    data: {
      manifest: {
        name,
        version: "1.0.0",
        summary: "GitHub 書き込みの確認",
        scope: ["personal"],
        permissions: ["ui:slot", "github:gist"],
        connectAllowlist: [],
        entry: "plugin.js",
        slots: ["thread-bottom"],
        hooks: [],
      },
      code: PLUGIN_CODE,
      visibility: "private",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const createdBody = await readEnvelope<{ id: string }>(created);
  if (!createdBody?.ok) throw new Error("プラグイン作成に失敗しました");

  const installed = await page.request.post(apiUrl(`/v1/plugins/${createdBody.data.id}/install`), {
    headers: userHeaders(),
    data: { scope: "personal" },
  });
  expect(installed.status(), await installed.text()).toBe(201);

  return { threadPath: `/b/${slug}/t/${threadBody.data.threadId}`, name };
}

test.describe("GitHub 書き込みの直前確認", () => {
  test.skip(!GITHUB_STUB, "E2E_GITHUB_STUB=1（GitHub スタブ）でのみ実行");

  // 後続の GitHub 連携 spec（未連携の 403 を確認する）に影響しないよう解除する。
  test.afterEach(async ({ request }) => {
    await request.delete(apiUrl("/v1/github/link"), { headers: userHeaders() });
  });

  test("やめるでは送信せず、書き込むで表示した内容だけを送る", async ({ page, context }) => {
    await login(context);
    const { threadPath, name } = await prepare(page);
    await page.goto(threadPath);

    const frame = page.frameLocator(`[data-plugin-slot="thread-bottom"] iframe[title="${name} プラグイン"]`);
    const button = frame.getByRole("button", { name: "Gist に保存" });
    await expect(button).toBeVisible({ timeout: 20_000 });

    let gistRequests = 0;
    const gistBodies: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/v1/github/files/gists")) {
        gistRequests += 1;
        try {
          gistBodies.push(request.postDataJSON());
        } catch {
          gistBodies.push(null);
        }
      }
    });

    // 1 回目: 確認の窓が出る → やめる
    await button.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("GitHub への書き込み");
    await expect(dialog).toContainText("プラグイン「ghconsent-plugin");
    await expect(page.getByTestId("plugin-github-consent-destination")).toHaveText("Gist「note.txt」（非公開）");
    await expect(page.getByTestId("plugin-github-consent-size")).toContainText("4 行");
    await expect(page.getByTestId("plugin-github-consent-preview")).toContainText("1行目のテキスト");
    await page.screenshot({ path: shotPath("github-consent-dialog") });
    await dialog.getByRole("button", { name: "やめる" }).click();
    await expect(page.getByTestId("plugin-github-consent")).toHaveCount(0);
    await expect(frame.locator("#oc-gist-result").last()).toHaveText("ERR:CANCELED");
    expect(gistRequests, "「やめる」では Gist API を呼ばない").toBe(0);

    // 2 回目: 確認の窓 → 書き込む
    await button.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const posted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/v1/github/files/gists"),
    );
    await page.getByRole("dialog").getByRole("button", { name: "書き込む" }).click();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(201);
    await expect(frame.locator("#oc-gist-result").last()).toContainText("OK:https://gist.github.com/");
    expect(gistRequests).toBe(1);
    // 窓に表示した filename・content・公開/非公開がそのまま送られる
    expect(gistBodies[0]).toMatchObject({
      public: false,
      files: { "note.txt": { content: GIST_CONTENT } },
    });
  });
});