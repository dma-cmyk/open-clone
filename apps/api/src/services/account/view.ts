// セッション/アカウントのレスポンス整形（API 間で重複させない）。

import type { Account, AuthSession } from "shared";
import type { SessionVerification } from "./session";
import { getSpecialAdminStop } from "./special-admin";
import { getTotpStatus } from "./totp";
import { getStepUpExpiry } from "./step-up";

export interface AccountRow {
  id: string;
  name: string;
  email: string | null;
  password_hash: string | null;
  role: "owner" | "special_admin" | "user";
  status: "active" | "suspended";
  created_at: number;
}

export async function getAccountRow(db: D1Database, id: string): Promise<AccountRow | null> {
  return db
    .prepare("SELECT id, name, email, password_hash, role, status, created_at FROM accounts WHERE id = ?")
    .bind(id)
    .first<AccountRow>();
}

export function accountDto(row: {
  id: string;
  name: string;
  email: string | null;
  role: "owner" | "special_admin" | "user";
  status: "active" | "suspended";
  created_at: number;
}): Account {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function buildAuthSession(db: D1Database, session: SessionVerification): Promise<AuthSession> {
  const [row, totp, stop, stepUpExpiry] = await Promise.all([
    getAccountRow(db, session.account.id),
    getTotpStatus(db, session.account.id),
    session.account.role === "special_admin"
      ? getSpecialAdminStop(db, session.account.id)
      : Promise.resolve(null),
    getStepUpExpiry(db, session.tokenHash),
  ]);
  const account = row ? accountDto(row) : { ...session.account, createdAt: 0 };
  return {
    account,
    expiresAt: session.expiresAt,
    totpSetupRequired: totp.required && !totp.enabled,
    totp: { enabled: totp.enabled, required: totp.required, recoveryRemaining: totp.recoveryRemaining },
    specialAdminStopped: stop !== null,
    stepUpActive: stepUpExpiry !== null,
  };
}