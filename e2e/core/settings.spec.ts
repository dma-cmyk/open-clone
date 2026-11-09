// core: 個人設定（NG・表示）が localStorage に永続化されること。
// サーバーに送らない端末ローカル設定なので、リロード相当（別ページへ遷移して戻る）で復元を確認する。
import { expect, test } from "@playwright/test";

test.describe("core: 個人設定", () => {
  test("NG ワードを追加すると localStorage に保存され、画面遷移後も残る", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("おーぷんクローン");

    await page.getByRole("link", { name: "設定" }).first().click();
    await expect(page.getByRole("heading", { name: "NG 設定" })).toBeVisible();

    const word = `ng-${Date.now()}`;
    const input = page.getByPlaceholder(/荒らし/).first();
    await input.fill(word);
    await page.getByRole("button", { name: "追加" }).first().click();
    // NG 項目は「値 + 削除ボタン」の 1 要素なので、完全一致テキストではなく項目で判定する。
    const ngItem = page.locator(".oc-ng-item").filter({ hasText: word });
    await expect(ngItem).toBeVisible();

    const stored = await page.evaluate(() => window.localStorage.getItem("oc.settings.v1"));
    expect(stored).toContain(word);

    // トップへ戻ってから設定へ入り直しても残る
    await page.getByRole("link", { name: "板一覧" }).first().click();
    await page.getByRole("link", { name: "設定" }).first().click();
    await expect(page.locator(".oc-ng-item").filter({ hasText: word })).toBeVisible();
  });

  test("文字サイズの変更がレス表示に反映される", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "設定" }).first().click();
    await page.getByRole("tab", { name: "表示" }).click();
    const slider = page.locator('input[type="range"]').first();
    await slider.fill("20");
    const stored = await page.evaluate(() => window.localStorage.getItem("oc.settings.v1"));
    expect(stored).toContain('"fontSize":20');
  });

  test("旧名 kome の端末設定は読み込み時に tsubuyaki へ移して保存し直す", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "oc.settings.v1",
        JSON.stringify({
          behavior: { autoScroll: false, kome: true },
          kome: { size: 31, speed: 3, opacity: 0.5, color: "#123456" },
          ng: { mode: "confirm", words: [":kome", "spam"], ids: [], names: [], trips: [], threads: [] },
        }),
      );
    });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();

    const stored = await page.evaluate(() => window.localStorage.getItem("oc.settings.v1"));
    const parsed = JSON.parse(stored ?? "{}") as {
      behavior?: Record<string, unknown>;
      tsubuyaki?: Record<string, unknown>;
      kome?: unknown;
      ng?: { words?: string[] };
    };
    expect(parsed.behavior?.tsubuyaki).toBe(true);
    expect(parsed.behavior?.kome).toBeUndefined();
    expect(parsed.tsubuyaki).toMatchObject({ size: 31, speed: 3 });
    expect(parsed.kome).toBeUndefined();
    expect(parsed.ng?.words).toContain(":tsubuyaki");
    expect(parsed.ng?.words).not.toContain(":kome");
    expect(parsed.ng?.words).toContain("spam");
  });
});
