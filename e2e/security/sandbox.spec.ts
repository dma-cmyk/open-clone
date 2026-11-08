// プラグイン sandbox（DESIGN §7.1: sandbox="allow-scripts" + 不透明オリジン）。
// WP3 のプラグインホストが iframe を実装した時点で自動的に検証へ入る。
import { expect, test } from "@playwright/test";

test.describe("プラグイン sandbox", () => {
  test("/plugins に描画される iframe は allow-same-origin を持たない", async ({ page }) => {
    const response = await page.goto("/plugins");
    if (!response || response.status() === 404) {
      test.skip(true, "未実装（WP3）: /plugins ページ");
    }
    const frames = page.locator("iframe");
    const count = await frames.count();
    if (count === 0) {
      test.skip(true, "プラグイン実行 iframe が未実装（WP3）");
    }
    for (let i = 0; i < count; i += 1) {
      const iframe = frames.nth(i);
      const sandbox = await iframe.getAttribute("sandbox");
      expect(sandbox, `iframe[${i}] に sandbox が必要`).not.toBeNull();
      const tokens = (sandbox ?? "").split(/\s+/);
      expect(tokens, `iframe[${i}] は allow-scripts のみ許可`).toContain("allow-scripts");
      expect(tokens, `iframe[${i}] に allow-same-origin を付けてはならない`).not.toContain("allow-same-origin");
      expect(tokens, `iframe[${i}] に allow-top-navigation を付けてはならない`).not.toContain(
        "allow-top-navigation",
      );
    }
  });

  test("プラグイン iframe は親 DOM/Cookie にアクセスできない", async ({ page }) => {
    const response = await page.goto("/plugins");
    if (!response || response.status() === 404) {
      test.skip(true, "未実装（WP3）: /plugins ページ");
    }
    const count = await page.locator("iframe").count();
    if (count === 0) test.skip(true, "プラグイン実行 iframe が未実装（WP3）");

    const child = page.frames().find((frame) => frame !== page.mainFrame());
    if (!child) test.skip(true, "子フレームが未生成（WP3）");

    const escaped = await child!.evaluate(() => {
      try {
        // 不透明オリジンなら親の document 参照は SecurityError になる。
        return { parentAccessible: Boolean(window.parent.document), cookie: document.cookie };
      } catch (error) {
        return { blocked: error instanceof Error ? error.name : "blocked" };
      }
    });
    if ("blocked" in escaped) {
      expect(escaped.blocked).toBe("SecurityError");
      return;
    }
    expect(escaped.parentAccessible).toBe(false);
    expect(escaped.cookie).toBe("");
  });
});