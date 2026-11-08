// 認証・端末識別の共有型。Worker ミドルウェアと web クライアントの契約（CONTRACTS.md §4）。

/** アカウントのグローバルロール（D1 accounts.role と一致） */
export type GlobalRole = "owner" | "special_admin" | "user";

/** 板スタッフのレベル（D1 board_staff.level と一致） */
export type BoardStaffLevel = "admin" | "deputy" | "moderator";

/** 認証済みアカウント情報（パスワードハッシュ等は含めない） */
export interface AuthAccount {
  id: string;
  name: string;
  email: string | null;
  role: GlobalRole;
  status: "active" | "suspended";
}

/** 端末識別（匿名トラッキング用。DESIGN §5.1） */
export interface DeviceInfo {
  /** oc_did Cookie の生値（クライアントには HttpOnly でのみ見える） */
  deviceId: string;
  /** HMAC(ID_SALT, deviceId)。サーバ側ログ・NG・レート制限に使う */
  deviceHash: string;
  /** 接続元 IP（正規化前） */
  ip: string;
  /** HMAC(ID_SALT, ip)。生 IP は保存しない */
  ipHash: string;
}

/** セッション状態 */
export interface SessionInfo {
  /** セッショントークンの SHA-256（生トークンは保持しない） */
  tokenHash: string;
  account: AuthAccount;
  expiresAt: number;
}

/** リクエストごとに構築される共通コンテキスト（apps/api lib/context.ts が生成） */
export interface AppRequestContext {
  requestId: string;
  device: DeviceInfo;
  /** 未ログイン時は null */
  session: SessionInfo | null;
}
