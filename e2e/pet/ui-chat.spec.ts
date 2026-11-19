// AI ペットの会話の e2e（中継は page.route の代役）。設計書 §7「会話の進行」の画面側を確かめる。
//  - ツールの往復（ツールの行 → 結果を AI に返す → 返事）
//  - Enter で送る / Shift+Enter で改行 / 変換中の Enter では送らない
//  - 中継のエラーは日本語で出る
//  - 「止める」で待ちを中断できる
//  - 会話がリロード後も残り、「消去」で消える
//  - ペットの返事の同じサイト内パスだけがリンクになる

import { expect, test } from "@playwright/test";
import { configurePet, installRelayStub, openPet, sendPetMessage } from "./helpers";

test.describe("AI ペットの会話", () => {
  test("ツールを呼び、結果を AI に返して続きを表示する", async ({ page }) => {
    const logs = await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    await sendPetMessage(page, "#tool get_page_context {}");

    // ツールの行（何をしたか）が出る。
    const toolLine = page.getByTestId("pet-tool-line").first();
    await expect(toolLine).toContainText("今の画面を確認しています");
    await expect(toolLine).toContainText("完了");
    // 2 回目の要求にツールの結果が入り、その返事が出る（代役は設計書 §5.1 のとおり「ツール結果(...)」）。
    await expect(page.getByText("ツール結果(get_page_context):", { exact: false })).toBeVisible();

    expect(logs.filter((log) => log.path.endsWith("/pet/chat"))).toHaveLength(2);
    const second = logs.filter((log) => log.path.endsWith("/pet/chat"))[1];
    const messages = Array.isArray(second?.body?.messages) ? (second.body.messages as unknown[]) : [];
    expect(JSON.stringify(messages)).toContain("get_page_context");
    // ツール一覧も送っている（サーバーが事業者の形に組み直す）。
    expect(Array.isArray(second?.body?.tools)).toBe(true);
    expect(JSON.stringify(second?.body?.tools)).toContain("get_page_context");
    // キーはヘッダーだけで送る。
    expect(second?.headers["x-pet-api-key"]).toBe("sk-test");
    expect(JSON.stringify(second?.body)).not.toContain("sk-test");
  });

  test("Enter で送り、Shift+Enter は改行、変換中の Enter では送らない", async ({ page }) => {
    const logs = await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    const input = page.getByTestId("pet-input");
    const userRows = page.locator(".oc-pet-row-user");

    // 変換中の Enter は送らない（Chrome の isComposing）。
    await input.fill("へんかんちゅう");
    await input.dispatchEvent("keydown", { key: "Enter", keyCode: 13, isComposing: true, bubbles: true });
    await expect(input).toHaveValue("へんかんちゅう");
    await expect(userRows).toHaveCount(0);
    expect(logs).toHaveLength(0);

    // Shift+Enter は改行。
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("へんかんちゅう\n");

    // Enter で送る。
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(userRows).toHaveCount(1);
    await expect(page.getByText("了解: へんかんちゅう", { exact: false })).toBeVisible();
    expect(logs).toHaveLength(1);
  });

  test("中継のエラーは日本語で案内する", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    await sendPetMessage(page, "#error");
    const notice = page.getByTestId("pet-notice").filter({ hasText: "モデル名と接続先を確かめてください" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("テスト用の事業者エラーです");
  });

  test("「止める」で待ちを中断する", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    await sendPetMessage(page, "#slow 8000 おそい返事");
    await expect(page.getByTestId("pet-send")).toHaveText("止める");
    await page.getByTestId("pet-send").click();
    await expect(page.getByTestId("pet-notice").filter({ hasText: "止めました" })).toBeVisible();
    await expect(page.getByTestId("pet-send")).toHaveText("送る");
  });

  test("会話はリロード後も残り、「消去」で消える", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    await sendPetMessage(page, "こんにちは");
    await expect(page.getByText("了解: こんにちは", { exact: false })).toBeVisible();

    await page.reload();
    await openPet(page);
    await expect(page.getByText("了解: こんにちは", { exact: false })).toBeVisible();

    await page.getByTestId("pet-clear").click();
    await expect(page.locator(".oc-pet-row-user")).toHaveCount(0);
    await expect(page.getByText("了解: こんにちは", { exact: false })).toHaveCount(0);
  });

  test("返事の中の同じサイト内のパスだけをリンクにする", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    await sendPetMessage(page, "板は /b/news です");
    const petLink = page.locator(".oc-pet-row-pet a[href='/b/news']").first();
    await expect(petLink).toBeVisible();
    await expect(petLink).toHaveText("/b/news");
  });
});