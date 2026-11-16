// 投稿パイプライン用の Turnstile 検証。
// 板設定の方針（off / anonymous / always）に応じて要求し、siteverify は Worker から行う。
//
// 「一度通ったら一定時間は省略」（報告書 81）:
// - 確認に成功した端末（device_hash）と板の組に期限を D1 へ記録する。
// - 期限内のレス・つぶやきは siteverify を省略する（スレ立て・通報・登録・ログイン・
//   アップロードは従来どおり毎回確認）。
// - `turnstile: "always"` の板と、板設定 `turnstilePassMinutes: 0` では省略しない。
// - 期限内でも連投制限・回数制限・アク禁・NG は従来どおり効き、制限に当たったら
//   省略を取り消して次回から確認を求める（`revokeTurnstilePass`）。

import { ApiError, ErrorCode, type BoardSettings } from "shared";
import type { Env } from "../../lib/env";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** ローカル/E2E スタブ用の検証先上書き（未設定なら本番 URL）。 */
export function turnstileVerifyUrl(env: Env): string {
  const value = (env as unknown as Record<string, unknown>)["TURNSTILE_VERIFY_URL"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : VERIFY_URL;
}

interface SiteVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/** 板設定とログイン状態から Turnstile 要求が必要か。 */
export function needsTurnstile(settings: BoardSettings, hasSession: boolean): boolean {
  if (settings.turnstile === "off") return false;
  if (settings.turnstile === "always") return true;
  return !hasSession;
}

/**
 * この板・この設定で「確認済みによる省略」が使えるか。
 * `always` は毎回確認（設計の整合: always は省略しない）、`off` は確認自体が不要。
 * 0 分は省略しない（従来どおり毎回）。
 */
export function canPassTurnstile(settings: BoardSettings): boolean {
  return settings.turnstile === "anonymous" && settings.turnstilePassMinutes > 0;
}

/** 省略の期限（秒）。 */
export function turnstilePassSeconds(settings: BoardSettings): number {
  return settings.turnstilePassMinutes * 60;
}

/** 期限内の確認済み記録を返す（無ければ null）。期限切れの行はその場で消す。 */
export async function readTurnstilePass(
  db: D1Database,
  deviceHash: string,
  boardId: number,
  now: number,
): Promise<{ expires_at: number } | null> {
  const row = await db
    .prepare("SELECT expires_at FROM turnstile_passes WHERE device_hash = ? AND board_id = ?")
    .bind(deviceHash, boardId)
    .first<{ expires_at: number }>();
  if (!row) return null;
  if (row.expires_at <= now) {
    await revokeTurnstilePass(db, deviceHash, boardId);
    return null;
  }
  return row;
}

/** 確認に成功した端末を、指定の分数だけ「確認済み」にする。 */
export async function grantTurnstilePass(
  db: D1Database,
  params: { deviceHash: string; boardId: number; now: number; seconds: number; ipHash: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO turnstile_passes (device_hash, board_id, verified_at, expires_at, ip_hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_hash, board_id)
       DO UPDATE SET verified_at = excluded.verified_at, expires_at = excluded.expires_at, ip_hash = excluded.ip_hash`,
    )
    .bind(params.deviceHash, params.boardId, params.now, params.now + params.seconds, params.ipHash)
    .run();
}

/** 省略を取り消す（制限に当たったとき・異常を検知したとき）。 */
export async function revokeTurnstilePass(db: D1Database, deviceHash: string, boardId: number): Promise<void> {
  await db
    .prepare("DELETE FROM turnstile_passes WHERE device_hash = ? AND board_id = ?")
    .bind(deviceHash, boardId)
    .run();
}

/** トークンを siteverify で検証する。要求が必要なのに無い/不正なら 400 TURNSTILE_FAILED。 */
export async function assertTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
  required: boolean,
): Promise<void> {
  if (!token) {
    if (required) throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile トークンが必要です");
    return;
  }
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (env.ENVIRONMENT === "development") return;
    throw new ApiError(500, ErrorCode.MISCONFIGURED, "TURNSTILE_SECRET_KEY が設定されていません");
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);

  const response = await fetch(turnstileVerifyUrl(env), { method: "POST", body: form });
  if (!response.ok) throw new ApiError(502, ErrorCode.BAD_GATEWAY, "Turnstile 検証に失敗しました");
  const result = (await response.json()) as SiteVerifyResponse;
  if (!result.success) {
    throw new ApiError(400, ErrorCode.TURNSTILE_FAILED, "Turnstile 検証に失敗しました", result["error-codes"]);
  }
}