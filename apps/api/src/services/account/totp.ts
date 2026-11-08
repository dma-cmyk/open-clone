// アカウント単位の TOTP（RFC 6238 / 6桁 / 30秒 / SHA-1、許容 ±1 窓）。
// secret は AES-GCM 暗号化して保存。5回失敗で 15 分ロック（DESIGN §5.5）。

import {
  ApiError,
  buildOtpAuthUri,
  ErrorCode,
  generateTotpSecret,
  TOTP_DIGITS,
  TOTP_LOCK_MINUTES,
  TOTP_MAX_FAILURES,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  verifyTotp,
  verifyTotpStep,
} from "shared";
import { decryptSecret, encryptSecret } from "./crypto";
import { countRemainingRecoveryCodes, generateRecoveryCodes } from "./recovery";

const ISSUER = "OpenClone";
const PENDING_TTL_SECONDS = 15 * 60;

export interface TotpRow {
  account_id: string;
  secret_enc: string;
  verified: number;
  required: number;
  enabled_at: number | null;
  last_used_at: number | null;
  /** 最後に消費した TOTP カウンタ（同一タイムステップの再利用拒否 / M-4） */
  last_used_step: number | null;
  failed_attempts: number;
  locked_until: number | null;
  pending_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export async function getTotpRow(db: D1Database, accountId: string): Promise<TotpRow | null> {
  return db.prepare("SELECT * FROM account_totp WHERE account_id = ?").bind(accountId).first<TotpRow>();
}

export interface TotpStatusView {
  enabled: boolean;
  required: boolean;
  lockedUntil: number | null;
  recoveryRemaining: number;
}

export async function getTotpStatus(db: D1Database, accountId: string): Promise<TotpStatusView> {
  const [row, recoveryRemaining] = await Promise.all([
    getTotpRow(db, accountId),
    countRemainingRecoveryCodes(db, accountId),
  ]);
  return {
    enabled: row?.verified === 1,
    required: row?.required === 1,
    lockedUntil: row?.locked_until ?? null,
    recoveryRemaining,
  };
}

/** セットアップ開始。未検証 secret を暗号化保存し、QR 用の otpauth URI を返す。 */
export async function beginTotpSetup(
  db: D1Database,
  accountId: string,
  encKey: string,
  accountName: string,
): Promise<{ secret: string; otpauthUri: string }> {
  const row = await getTotpRow(db, accountId);
  if (row?.verified === 1) {
    throw ApiError.conflict("TOTP は既に有効です。変更するには先に無効化してください");
  }
  const secret = generateTotpSecret();
  const secretEnc = await encryptSecret(secret, encKey);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO account_totp
         (account_id, secret_enc, verified, required, enabled_at, last_used_at, failed_attempts, locked_until, pending_expires_at, created_at, updated_at)
       VALUES (?, ?, 0, ?, NULL, NULL, 0, NULL, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         secret_enc = excluded.secret_enc,
         verified = 0,
         enabled_at = NULL,
         last_used_step = NULL,
         failed_attempts = 0,
         locked_until = NULL,
         pending_expires_at = excluded.pending_expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(accountId, secretEnc, row?.required ?? 0, now + PENDING_TTL_SECONDS, now, now)
    .run();
  return {
    secret,
    otpauthUri: buildOtpAuthUri(secret, {
      accountName,
      issuer: ISSUER,
      period: TOTP_PERIOD_SECONDS,
      digits: TOTP_DIGITS,
    }),
  };
}

/**
 * セットアップ確定。コード検証に成功したときだけ有効化し、リカバリーコード 10 個を発行する。
 */
export async function enableTotp(
  db: D1Database,
  accountId: string,
  encKey: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const row = await getTotpRow(db, accountId);
  if (!row) throw ApiError.validation("TOTP セットアップを開始してください");
  if (row.verified === 1) throw ApiError.conflict("TOTP は既に有効です");
  const now = Math.floor(Date.now() / 1000);
  if (row.pending_expires_at !== null && row.pending_expires_at < now) {
    throw ApiError.validation("TOTP のセットアップ期限が切れました。最初からやり直してください");
  }
  const secret = await decryptSecret(row.secret_enc, encKey);
  const ok = await verifyTotp(secret, code, {
    window: TOTP_WINDOW,
    period: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
    time: now,
  });
  if (!ok) throw new ApiError(400, ErrorCode.TOTP_INVALID, "TOTP コードが正しくありません");

  await db
    .prepare(
      "UPDATE account_totp SET verified = 1, enabled_at = ?, pending_expires_at = NULL, failed_attempts = 0, locked_until = NULL, last_used_at = ?, updated_at = ? WHERE account_id = ?",
    )
    .bind(now, now, now, accountId)
    .run();
  const recoveryCodes = await generateRecoveryCodes(db, accountId);
  return { recoveryCodes };
}

/** 保存済み secret を破棄して無効化する（リカバリー必須アカウントは owner リセットのみ）。 */
export async function disableTotp(db: D1Database, accountId: string, encKey: string, code: string): Promise<void> {
  const row = await getTotpRow(db, accountId);
  if (!row || row.verified !== 1) throw ApiError.validation("TOTP は有効になっていません");
  if (row.required === 1) {
    throw ApiError.forbidden("このアカウントは TOTP が必須です。無効化は所有者によるリセットのみ可能です");
  }
  const result = await verifyTotpCode(db, row, encKey, code);
  if (!result.ok) {
    throw new ApiError(400, ErrorCode.TOTP_INVALID, "TOTP コードが正しくありません");
  }
  await resetTotp(db, accountId);
}

export type TotpVerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_enabled" | "locked" | "invalid"; lockedUntil: number | null; remaining: number };

/** ログイン・step-up・TOTP 再認証の共通検証。失敗カウントとロックを更新する。 */
export async function verifyTotpCode(
  db: D1Database,
  row: TotpRow,
  encKey: string,
  code: string,
): Promise<TotpVerifyResult> {
  const now = Math.floor(Date.now() / 1000);
  if (row.locked_until !== null && row.locked_until > now) {
    return { ok: false, reason: "locked", lockedUntil: row.locked_until, remaining: 0 };
  }
  const secret = await decryptSecret(row.secret_enc, encKey);
  const matchedStep = await verifyTotpStep(secret, code, {
    window: TOTP_WINDOW,
    period: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
    time: now,
  });
  // RFC 6238 §5.2: 同じタイムステップのコードは一度しか使えない（M-4）。
  // ±1 窓の別ステップは許容する（過去窓のコードを使う正規フローを壊さない）。
  // last_used_step は成功時にだけ更新する（enableTotp では記録しない）。
  const replay = matchedStep !== null && row.last_used_step !== null && matchedStep === row.last_used_step;
  if (matchedStep !== null && !replay) {
    await db
      .prepare(
        "UPDATE account_totp SET failed_attempts = 0, locked_until = NULL, last_used_at = ?, last_used_step = ?, updated_at = ? WHERE account_id = ?",
      )
      .bind(now, matchedStep, now, row.account_id)
      .run();
    return { ok: true };
  }

  const failures = row.failed_attempts + 1;
  const lockedUntil = failures >= TOTP_MAX_FAILURES ? now + TOTP_LOCK_MINUTES * 60 : null;
  await db
    .prepare("UPDATE account_totp SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE account_id = ?")
    .bind(failures, lockedUntil, now, row.account_id)
    .run();
  return {
    ok: false,
    reason: lockedUntil ? "locked" : "invalid",
    lockedUntil,
    remaining: Math.max(0, TOTP_MAX_FAILURES - failures),
  };
}

/** アカウント ID から検証する（行が無い・未検証は not_enabled）。 */
export async function verifyTotpForAccount(
  db: D1Database,
  accountId: string,
  encKey: string,
  code: string,
): Promise<TotpVerifyResult> {
  const row = await getTotpRow(db, accountId);
  if (!row || row.verified !== 1) {
    return { ok: false, reason: "not_enabled", lockedUntil: null, remaining: 0 };
  }
  return verifyTotpCode(db, row, encKey, code);
}

/**
 * TOTP をリセットする（所有者による復旧・リカバリーコード使用時）。
 * verified=0 に戻し、次のログイン時に再登録を要求する。required は維持する。
 */
export async function resetTotp(
  db: D1Database,
  accountId: string,
  options: { keepRecoveryCodes?: boolean } = {},
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE account_totp SET verified = 0, secret_enc = '', enabled_at = NULL, last_used_step = NULL, failed_attempts = 0, locked_until = NULL, pending_expires_at = NULL, updated_at = ? WHERE account_id = ?",
      )
      .bind(now, accountId),
  ];
  if (!options.keepRecoveryCodes) {
    statements.push(db.prepare("DELETE FROM recovery_codes WHERE account_id = ?").bind(accountId));
  }
  await db.batch(statements);
}

/** TOTP 必須フラグを設定する（special_admin の就任時に required=1 で作成する）。 */
export async function ensureTotpRequired(db: D1Database, accountId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO account_totp
         (account_id, secret_enc, verified, required, enabled_at, last_used_at, failed_attempts, locked_until, pending_expires_at, created_at, updated_at)
       VALUES (?, '', 0, 1, NULL, NULL, 0, NULL, NULL, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET required = 1, updated_at = excluded.updated_at`,
    )
    .bind(accountId, now, now)
    .run();
}