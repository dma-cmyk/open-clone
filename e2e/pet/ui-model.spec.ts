// モデル一覧の画面の e2e（設計書 §10.2）。中継 `POST /api/v1/pet/models` は page.route の代役。
//  - 「モデル一覧を取得」を押したときだけキーを送る（自動では取らない）
//  - 3 件から `large` で絞って `stub-large` をキーボードで選び、保存できる
//  - 失敗（bad-key）は理由を出し、自由入力のまま保存できる

import { expect, test } from "@playwright/test";
import { installRelayStub, openPet } from "./helpers";

test.describe("AI ペットのモデル一覧", () => {
  test("押したときだけ取得し、絞り込んでキーボードで選べる", async ({ page }) => {
    const logs = await installRelayStub(page);
    await page.goto("/");
    await openPet(page);

    await page.getByTestId("pet-provider").selectOption("openai");
    await page.getByTestId("pet-api-key").fill("sk-test");
    // 押す前は取りに行かない。
    expect(logs).toHaveLength(0);

    await page.getByTestId("pet-model-fetch").click();
    const list = page.getByTestId("pet-model-list");
    await expect(list).toBeVisible();
    await expect(list.locator("[role='option']")).toHaveCount(3);
    // 表示名も並べる。
    await expect(list).toContainText("Stub Large");

    const request = logs[0];
    expect(request?.path).toBe("/api/v1/pet/models");
    expect(request?.headers["x-pet-api-key"]).toBe("sk-test");
    expect(request?.body).toMatchObject({ provider: "openai" });

    // 部分一致（大文字小文字を区別しない）で絞る。
    const input = page.getByTestId("pet-model-input");
    await input.fill("LARGE");
    await expect(list.locator("[role='option']")).toHaveCount(1);
    await expect(list.locator("[role='option']")).toHaveAttribute("data-model-id", "stub-large");

    // ↑↓ で選び、Enter で決める。
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(input).toHaveValue("stub-large");
    await expect(list).toHaveCount(0);

    await page.getByTestId("pet-save").click();
    await expect(page.getByTestId("pet-input")).toBeVisible();

    // 保存したモデルが残る。
    await page.getByTestId("pet-open-settings").click();
    await expect(page.getByTestId("pet-model-input")).toHaveValue("stub-large");
  });

  test("一覧が取れないときは理由を出し、自由入力で保存できる", async ({ page }) => {
    const logs = await installRelayStub(page);
    await page.goto("/");
    await openPet(page);

    await page.getByTestId("pet-provider").selectOption("openai");
    await page.getByTestId("pet-api-key").fill("bad-key");
    await page.getByTestId("pet-model-fetch").click();

    const error = page.getByTestId("pet-model-error");
    await expect(error).toContainText("API キーを受け付けませんでした");
    await expect(page.getByTestId("pet-model-list")).toHaveCount(0);
    // キーが違うので、要求は 1 回だけ（自動で取り直さない）。
    expect(logs.filter((log) => log.path.endsWith("/pet/models"))).toHaveLength(1);

    // 一覧に無くても自由入力で決められる。
    await page.getByTestId("pet-api-key").fill("sk-test");
    await page.getByTestId("pet-model-input").fill("my-free-model");
    await page.getByTestId("pet-save").click();
    await expect(page.getByTestId("pet-input")).toBeVisible();

    await page.getByTestId("pet-open-settings").click();
    await expect(page.getByTestId("pet-model-input")).toHaveValue("my-free-model");
  });

  test("custom の URL が無いうちは取得できない", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);

    await page.getByTestId("pet-provider").selectOption("custom");
    await page.getByTestId("pet-api-key").fill("sk-test");
    await expect(page.getByTestId("pet-model-fetch")).toBeDisabled();
    await page.getByTestId("pet-base-url").fill("https://example.com/v1");
    await expect(page.getByTestId("pet-model-fetch")).toBeEnabled();

    // キャラクターは既定のまま、キーとモデルで会話を始められる。
    await page.getByTestId("pet-model-input").fill("free-model");
    await page.getByTestId("pet-save").click();
    await expect(page.getByTestId("pet-input")).toBeVisible();
  });

  test("設定を変えると前の一覧は捨てる（キーが変わると一覧も変わる）", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);

    await page.getByTestId("pet-api-key").fill("sk-test");
    await page.getByTestId("pet-model-fetch").click();
    await expect(page.getByTestId("pet-model-list").locator("[role='option']")).toHaveCount(3);

    // キーを変えたら一覧は出さない（古い一覧を混ぜない）。
    await page.getByTestId("pet-api-key").fill("sk-other");
    await expect(page.getByTestId("pet-model-list")).toHaveCount(0);
  });

  test("Esc は一覧だけを閉じ、パネルは残る", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);

    await page.getByTestId("pet-api-key").fill("sk-test");
    await page.getByTestId("pet-model-fetch").click();
    const list = page.getByTestId("pet-model-list");
    await expect(list).toBeVisible();

    const input = page.getByTestId("pet-model-input");
    await input.focus();
    await input.press("Escape");
    await expect(list).toHaveCount(0);
    // パネル（設定画面）は閉じない。
    await expect(page.getByTestId("pet-panel")).toBeVisible();
    await expect(page.getByTestId("pet-settings")).toBeVisible();
    await expect(input).toBeVisible();
  });
});