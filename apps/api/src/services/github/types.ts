// GitHub サービスの内部型。

import type { GithubRate } from "shared/schemas/github";

/** 復号済みの GitHub 連携（リクエストスコープのみ。永続化しない）。 */
export interface GithubConnection {
  accountId: string;
  /** 平文トークン。レスポンス・ログ・D1 に絶対に出さない */
  token: string;
  login: string;
  userId: number | null;
  avatarUrl: string | null;
  scopes: string[];
  method: "oauth" | "pat";
  /** 直近に観測したレート（D1 にキャッシュした値） */
  rate: GithubRate | null;
}

/** GitHub 操作の監査ログ項目。 */
export interface GithubOpLog {
  accountId: string | null;
  op: string;
  ref?: string | null;
  status: "ok" | "error" | "blocked";
  detail?: unknown;
}