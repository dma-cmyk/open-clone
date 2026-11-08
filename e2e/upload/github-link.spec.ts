// GitHub 連携の E2E。
// GitHub API へは直接アクセスしない:
//  - 未連携時の 403 + 連携誘導、連携ページの描画は通常実行
//  - fine-grained PAT 登録 → Gist 作成は、API をスタブ（GITHUB_API_BASE 等）に向けた環境で
//    E2E_GITHUB_STUB=1 を付けたときだけ実行する（実 GitHub への誤操作を防ぐ）
import { expect, test } from "@playwright/test";
import { ALLOWED_ORIGIN, apiUrl, readEnvelope } from "../helpers/api";

const USER_COOKIE = "oc_sess=e2e-user-session-token";
const GITHUB_STUB = process.env.E2E_GITHUB_STUB === "1";
const STUB_TOKEN = "gho_e2e_dummy_token_1234567890";

async function headers(): Promise<Record<string, string>> {
  return { Origin: ALLOWED_ORIGIN, cookie: USER_COOKIE };
}

test.describe("GitHub 連携", () => {
  test("未連携ユーザーの Gist 操作は 403 + 連携誘導", async ({ request }) => {
    const response = await request.post(apiUrl("/v1/github/files/gists"), {
      headers: await headers(),
      data: { public: false, files: { "a.txt": { content: "x" } } },
    });
    expect(response.status()).toBe(403);
    const body = await readEnvelope<unknown>(response);
    expect(body && !body.ok).toBe(true);
    if (body && !body.ok) {
      expect(body.code).toBe("FORBIDDEN");
      expect(body.details).toMatchObject({ linkRequired: true, linkUrl: "/account/github" });
    }
  });

  test("連携ページが描画され、連携状態（未連携なら OAuth / PAT の案内）を表示する", async ({ page, context }) => {
    await context.addCookies([
      { name: "oc_sess", value: "e2e-user-session-token", domain: "localhost", path: "/" },
    ]);
    await page.goto("/account/github/");
    await expect(page.getByRole("heading", { name: "GitHub 連携" })).toBeVisible();

    // 連携済み（別テストの後始末前）でも未連携でもパネルが壊れないことを確認する
    const linked = page.getByText("連携中").first();
    const patSection = page.getByText("fine-grained PAT を持ち込んで連携する").first();
    await expect(linked.or(patSection)).toBeVisible();

    // 連携していない場合は、連携解除ボタンが出ていないこと
    const status = await page.request.get(apiUrl("/v1/github/link"), { headers: await headers() });
    const body = await readEnvelope<{ linked: boolean }>(status);
    if (body?.ok && !body.data.linked) {
      await expect(page.getByRole("button", { name: "連携解除" })).toHaveCount(0);
    }
  });
});

test.describe("GitHub 連携（スタブ設定時のみ）", () => {
  test.skip(!GITHUB_STUB, "GITHUB_API_BASE 等をスタブに向けた環境（E2E_GITHUB_STUB=1）でのみ実行");

  test("PAT 登録 → 状態表示 → Gist 作成 → 解除", async ({ page, request, context }) => {
    await context.addCookies([
      { name: "oc_sess", value: "e2e-user-session-token", domain: "localhost", path: "/" },
    ]);

    const linked = await request.post(apiUrl("/v1/github/link/pat"), {
      headers: await headers(),
      data: { token: STUB_TOKEN },
    });
    if (linked.status() !== 200) throw new Error(`PAT 連携失敗: ${await linked.text()}`);

    const status = await request.get(apiUrl("/v1/github/link"), { headers: await headers() });
    const statusBody = await readEnvelope<{ linked: boolean; login: string; method: string }>(status);
    expect(statusBody?.ok && statusBody.data.linked).toBe(true);
    if (statusBody?.ok && statusBody.data.linked) {
      expect(statusBody.data.method).toBe("pat");
      expect(statusBody.data.login).toBe("e2e-user");
    }

    const gist = await request.post(apiUrl("/v1/github/files/gists"), {
      headers: await headers(),
      data: { description: "e2e", public: false, files: { "e2e.txt": { content: "hello" } } },
    });
    if (gist.status() !== 201) throw new Error(`Gist 作成失敗: ${await gist.text()}`);
    const gistBody = await readEnvelope<{ id: string; htmlUrl: string }>(gist);
    expect(gistBody?.ok && gistBody.data.htmlUrl).toContain("gist.github.com");

    // パネルに連携済みが表示される
    await page.goto("/account/github/");
    await expect(page.getByText("@e2e-user")).toBeVisible();

    const unlink = await request.delete(apiUrl("/v1/github/link"), { headers: await headers() });
    expect(unlink.status()).toBe(200);
    const after = await readEnvelope<{ linked: boolean }>(
      await request.get(apiUrl("/v1/github/link"), { headers: await headers() }),
    );
    expect(after?.ok && after.data.linked).toBe(false);
  });
});