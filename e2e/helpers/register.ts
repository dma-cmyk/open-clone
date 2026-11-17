// 新規登録フローの共通手順。
// 登録成功後は「復旧コードを作成（推奨）／あとで」の任意ステップを挟む（設計 50 ①）。
// 既存の画面テストは登録後の遷移だけを確かめるため、「あとで」で先へ進む。
// 文言そのものは固定せず、操作（ボタン）とフォームが消えたことで段階の表示を確かめる。

import { expect, type Page } from "@playwright/test";

/** 登録フォーム送信後に現れる復旧コードの任意ステップで「あとで」を選ぶ。 */
export async function skipRecoveryCodeStep(page: Page): Promise<void> {
  const later = page.getByRole("button", { name: "あとで" });
  await expect(later).toBeVisible();
  // 登録フォームが残っていない＝登録が完了して次の段階に移った、という構造で確かめる。
  await expect(page.locator("#reg-email")).toHaveCount(0);
  await later.click();
}