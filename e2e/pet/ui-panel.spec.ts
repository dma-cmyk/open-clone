// AI ペットの画面（ボタン → パネル・最初の設定・見た目・しまう/呼び戻し・音声入力）の e2e。
//
// 中継 API はこの worktree にまだ無いので、`page.route` の代役（helpers.ts）を置く。
// 実際の書き込み（確認カードの承認）と本物の中継を通した確認は、統合後に行う。

import { expect, test } from "@playwright/test";
import { configurePet, installRelayStub, openPet } from "./helpers";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("AI ペットの画面", () => {
  test("右下のボタンからパネルが開き、最初の設定が並ぶ", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");

    const launcher = page.getByTestId("pet-launcher");
    await expect(launcher).toBeVisible();
    await openPet(page);

    await expect(page.getByTestId("pet-setup-notice")).toContainText("サーバーには保存されません");
    await expect(page.getByTestId("pet-provider")).toBeVisible();
    await expect(page.getByTestId("pet-model-input")).toBeVisible();
    await expect(page.getByTestId("pet-api-key")).toHaveAttribute("type", "password");
    // キーは表示切替できる。
    await page.getByRole("button", { name: "表示", exact: true }).click();
    await expect(page.getByTestId("pet-api-key")).toHaveAttribute("type", "text");
    // 未設定では会話の入力欄を出さない。
    await expect(page.getByTestId("pet-input")).toHaveCount(0);
  });

  test("設定を保存すると会話画面になり、リロードしても残る", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page, { model: "test-model", apiKey: "sk-test" });

    await expect(page.getByTestId("pet-messages")).toContainText("よろしくね");
    await expect(page.getByTestId("pet-head-name")).toHaveText("ミケ");

    await page.reload();
    await openPet(page);
    await expect(page.getByTestId("pet-input")).toBeVisible();
    await expect(page.getByTestId("pet-setup-notice")).toHaveCount(0);
  });

  test("「しまう」でボタンが消え、ヘッダーの「ペット」から呼び戻せる（リロード後も）", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    await page.getByTestId("pet-hide").click();
    await expect(page.getByTestId("pet-panel")).toHaveCount(0);
    await expect(page.getByTestId("pet-launcher")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("pet-launcher")).toHaveCount(0);

    await page.getByTestId("pet-header-button").click();
    await expect(page.getByTestId("pet-panel")).toBeVisible();
    await expect(page.getByTestId("pet-input")).toBeVisible();

    // 呼び戻すと「しまう」も解除され、閉じると右下のボタンが戻る。
    await page.getByTestId("pet-close").click();
    await expect(page.getByTestId("pet-launcher")).toBeVisible();
  });

  test("「この端末に覚えておく」がオフなら、別のタブでは設定が無い", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);
    await configurePet(page, { remember: false });

    // 同じタブでは残る（sessionStorage）。
    await page.reload();
    await openPet(page);
    await expect(page.getByTestId("pet-input")).toBeVisible();

    // 新しいタブには引き継がない。
    const other = await page.context().newPage();
    await other.goto("/");
    await openPet(other);
    await expect(other.getByTestId("pet-setup-notice")).toBeVisible();
    await expect(other.getByTestId("pet-input")).toHaveCount(0);
    await other.close();
  });

  test("画像をアップロードすると見た目に保存され、リロードしても残る", async ({ page }) => {
    await installRelayStub(page);
    await page.goto("/");
    await openPet(page);

    await page.getByTestId("pet-avatar-file").setInputFiles({
      name: "pet.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });
    await expect(page.getByText("アップロードした画像をこの端末に保存しました", { exact: false })).toBeVisible();
    await expect(page.getByTestId("pet-character-custom")).toBeVisible();

    await page.getByTestId("pet-model-input").fill("test-model");
    await page.getByTestId("pet-api-key").fill("sk-test");
    await page.getByTestId("pet-save").click();
    await expect(page.getByTestId("pet-input")).toBeVisible();

    await page.reload();
    await openPet(page);
    await page.getByTestId("pet-open-settings").click();
    const custom = page.getByTestId("pet-character-custom").locator("input");
    await expect(custom).toBeChecked();
    // アップロード画像は data URL（256×256 の PNG）で保存されている。
    const src = await page.getByTestId("pet-character-custom").locator("img").getAttribute("src");
    expect(src ?? "").toMatch(/^data:image\/png;base64,/);
  });

  test("音声入力で話した文が入力欄に入る（偽の音声認識）", async ({ page }) => {
    await installRelayStub(page);
    // ブラウザの音声認識の代わり（e2e では本物のマイクを使わない）。
    await page.addInitScript(() => {
      class FakeRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          window.setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: {
                length: 1,
                0: { isFinal: true, length: 1, 0: { transcript: "音声で入力した文です", confidence: 0.9 } },
              },
            });
            this.onend?.();
          }, 20);
        }
        stop() {}
        abort() {}
      }
      // ブラウザ純正の API があっても、試験ではこの偽物を必ず使う。
      Object.defineProperty(window, "webkitSpeechRecognition", {
        value: FakeRecognition,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, "SpeechRecognition", {
        value: FakeRecognition,
        configurable: true,
        writable: true,
      });
    });

    await page.goto("/");
    await openPet(page);
    await configurePet(page);

    // 初回の案内が出る。
    await expect(page.getByTestId("pet-voice-notice")).toContainText("Google のサーバーに送られます");
    await page.getByTestId("pet-mic").click();
    await expect(page.getByTestId("pet-input")).toHaveValue("音声で入力した文です");
    // 一度始めると案内は消える。
    await expect(page.getByTestId("pet-voice-notice")).toHaveCount(0);
  });

  test("音声認識が無いブラウザではマイクを出さない", async ({ page }) => {
    await installRelayStub(page);
    // ブラウザが音声認識を持っていても、無い場合の表示を確かめる。
    await page.addInitScript(() => {
      Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true, writable: true });
      Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true, writable: true });
    });
    await page.goto("/");
    await openPet(page);
    await configurePet(page);
    await expect(page.getByTestId("pet-mic")).toHaveCount(0);
  });
});