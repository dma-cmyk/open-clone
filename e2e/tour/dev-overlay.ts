// E2E 用の小さな補助。
//
// Next.js の開発サーバーは画面の隅に開発ツール（`<nextjs-portal>`）を出します。
// これは本番ビルドには存在しませんが、E2E では画面下端の固定 UI（初回の案内バナー・
// フッターのリンク）の真上に重なり、Playwright のクリックを
// `<nextjs-portal> … subtree intercepts pointer events` で妨げます
// （trace: `4. 続き` 節の証拠参照。Pixel 7 エミュレーションで顕著）。
//
// 製品の見た目・挙動を変えずにテストを成立させるため、E2E ではこの開発ツールだけを
// 非表示にします（本番には存在しない要素なので、隠しても利用者の体験は変わりません）。
import type { Page } from "@playwright/test";

export async function hideNextDevOverlay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const apply = () => {
      if (document.getElementById("e2e-hide-next-dev-overlay")) return;
      const style = document.createElement("style");
      style.id = "e2e-hide-next-dev-overlay";
      style.textContent = [
        "nextjs-portal { display: none !important; }",
        "[data-nextjs-dev-overlay] { display: none !important; }",
        "[data-nextjs-toast] { display: none !important; }",
      ].join("\n");
      document.head.appendChild(style);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
    else apply();
  });
}
/**
 * 本物の例外を検出する（レビュー M01）。
 * 開発ツールを隠すとエラー表示も消えるため、Playwright 側で pageerror と
 * console.error を集める。リソース 404（この worktree には /help/ が無い等）は除く。
 */
export function collectPageErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to load resource/i.test(text) || /\b404\b/.test(text)) return;
    // プラグイン sandbox iframe（about:blank + sandbox）で Chrome が出す既知のメッセージ。
    // アプリの例外ではないため除外する。
    if (/Blocked script execution in 'about:blank'/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}
