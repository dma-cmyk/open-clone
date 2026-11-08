// サイト所有者の初期ブートストラップ。
// デプロイ時に secret（OWNER_BOOTSTRAP_KEY）で指定したキーと、TOTP 登録が揃ったときだけ
// 一度だけ owner を作成する。2 回目以降は 409 OWNER_SETUP_CLOSED。

import {
  ApiError,
  ErrorCode,
  generateRecoveryCode,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  timingSafeEqual,
  ulid,
  verifyTotp,
} from "shared";
import type { OwnerBootstrapRequest } from "shared";
import { batch } from "../../lib/db";
import { encryptSecret } from "./crypto";
import { hashPassword } from "./password";
import { hashRecoveryCode } from "./recovery";

export async function ownerExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS one FROM accounts WHERE role = 'owner' LIMIT 1").first<{ one: number }>();
  return row !== null;
}

export async function bootstrapOwner(
  db: D1Database,
  env: { OWNER_BOOTSTRAP_KEY?: string; ENC_KEY: string },
  input: OwnerBootstrapRequest,
): Promise<{ accountId: string; recoveryCodes: string[] }> {
  if (await ownerExists(db)) {
    throw new ApiError(409, ErrorCode.OWNER_SETUP_CLOSED, "サイト所有者は既に設定済みです");
  }
  const expectedKey = env.OWNER_BOOTSTRAP_KEY;
  if (!expectedKey) {
    throw new ApiError(500, ErrorCode.MISCONFIGURED, "OWNER_BOOTSTRAP_KEY が設定されていません");
  }
  if (!timingSafeEqual(input.bootstrapKey, expectedKey)) {
    throw ApiError.forbidden("セットアップキーが正しくありません");
  }

  const now = Math.floor(Date.now() / 1000);
  const totpOk = await verifyTotp(input.totpSecret, input.totpCode, {
    window: 1,
    period: TOTP_PERIOD_SECONDS,
    digits: TOTP_DIGITS,
    time: now,
  });
  if (!totpOk) {
    throw new ApiError(400, ErrorCode.TOTP_INVALID, "TOTP コードが正しくありません");
  }

  const passwordHash = await hashPassword(input.password);
  const secretEnc = await encryptSecret(input.totpSecret, env.ENC_KEY);
  const accountId = ulid();

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const hashed = await Promise.all(codes.map((code) => hashRecoveryCode(code)));

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT INTO accounts (id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, 'owner', 'active', ?)",
      )
      .bind(accountId, input.name, input.email, passwordHash, now),
    db
      .prepare(
        "INSERT INTO account_totp (account_id, secret_enc, verified, required, enabled_at, failed_attempts, locked_until, created_at, updated_at) VALUES (?, ?, 1, 1, ?, 0, NULL, ?, ?)",
      )
      .bind(accountId, secretEnc, now, now, now),
    db.prepare("INSERT INTO account_profiles (account_id, bio, updated_at) VALUES (?, '', ?)").bind(accountId, now),
  ];
  hashed.forEach((hash) => {
    statements.push(
      db
        .prepare("INSERT INTO recovery_codes (id, account_id, code_hash, used_at, created_at) VALUES (?, ?, ?, NULL, ?)")
        .bind(ulid(), accountId, hash, now),
    );
  });

  try {
    await batch(db, statements);
  } catch (error) {
    // 部分ユニーク索引（owner 1 件）との競合 = 同時ブートストラップ
    if (await ownerExists(db)) {
      throw new ApiError(409, ErrorCode.OWNER_SETUP_CLOSED, "サイト所有者は既に設定済みです");
    }
    throw error;
  }
  return { accountId, recoveryCodes: codes };
}