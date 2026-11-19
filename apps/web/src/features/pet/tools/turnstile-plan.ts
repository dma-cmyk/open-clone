// 確認カードに Turnstile を出すかの判定。
//
// サーバーの規則（`apps/api/src/services/board/turnstile.ts` の `needsTurnstile` / `canPassTurnstile`）と
// 同じ条件を画面側でも使う。ここは「カードにウィジェットを出すか」だけを決める（可否の最終判断はサーバー）。
// 規則が変わったら両方を直すこと（web から api のモジュールは import できない）。

import { api } from "../../board-ui/api";
import type { BoardSettings } from "../../board-ui/types";
import { turnstilePolicy } from "./board-target";

export type TurnstilePolicy = "off" | "anonymous" | "always";

/** 板の方針とログイン状態から、確認が必要か（サーバーの `needsTurnstile` と同じ）。 */
export function needsTurnstile(policy: TurnstilePolicy, loggedIn: boolean): boolean {
  if (policy === "off") return false;
  if (policy === "always") return true;
  return !loggedIn;
}

/** 「確認済み（板ごとの期限内）」の省略が効く方針か（サーバーの `canPassTurnstile` と同じ）。 */
export function canPassTurnstile(settings: BoardSettings | undefined): boolean {
  return turnstilePolicy(settings) === "anonymous" && (settings?.turnstilePassMinutes ?? 0) > 0;
}

/**
 * レス・スレ立てで、いま Turnstile のトークンが必要か。
 * ログイン状態と「確認済み」の期限をサーバーに問い合わせる（読むだけ）。
 * スレ立ては省略が効かない（`allowTurnstilePass` が無い）ので `allowPass: false` で呼ぶ。
 */
export async function turnstileNeededNow(
  slug: string,
  settings: BoardSettings | undefined,
  options: { loggedIn: boolean; allowPass: boolean },
): Promise<boolean> {
  const policy = turnstilePolicy(settings);
  if (!needsTurnstile(policy, options.loggedIn)) return false;
  if (!options.allowPass || !canPassTurnstile(settings)) return true;
  const status = await api.getTurnstileStatus(slug).catch(() => null);
  return !status?.passed;
}

/**
 * レス・編集で Turnstile のトークンが必要か（ログイン状態も自分で取る）。
 * サーバーのレス投稿・本人編集は「確認済み（板ごと）」の省略が効くので `allowPass: true`。
 * スレ立てだけは `turnstileNeededNow(slug, settings, { loggedIn, allowPass: false })` を使う。
 */
export async function postingNeedsTurnstile(
  slug: string,
  settings: BoardSettings | undefined,
): Promise<boolean> {
  const session = await api.getSession();
  return turnstileNeededNow(slug, settings, { loggedIn: session !== null, allowPass: true });
}