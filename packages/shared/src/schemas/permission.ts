// DESIGN §5.4 権限マトリクスの機械可読版。
// サーバ側の強制は requireRole/requireBoardStaff ミドルウェア + この `can()` で行う。
// UI の表示制御は補助に過ぎない（DESIGN §5.4 準拠）。

/** 評価対象のロール。board 系は「その板でのレベル」、ai_agent は委譲権限として独立。 */
export type Role =
  | "owner"
  | "special_admin"
  | "board_admin"
  | "board_deputy"
  | "board_moderator"
  | "user"
  | "anon"
  | "ai_agent";

/**
 * マトリクスのセル値（DESIGN §5.4 の凡例に対応）。
 * - `always`     : ◎ 無条件で可
 * - `scope:board`: ◎/○（自板・自分の担当板内に限り可）
 * - `scope:self` : ○（自分自身・自分のリソースに限り可）
 * - `conditional`: △（条件付。可否は個別ロジックが別途判定する。`can()` のみでは不可）
 * - `never`      : × / —（対象外）
 */
export type PermissionCell = "always" | "scope:board" | "scope:self" | "conditional" | "never";

/** DESIGN §5.4 の行に対応する操作カタログ。 */
export const PERMISSION_ACTIONS = [
  "view",
  "post",
  "boardCreate",
  "boardEdit",
  "boardDelete",
  "staffManage",
  "postModerate",
  "banBoard",
  "banSite",
  "accountSuspend",
  "reportHandle",
  "pluginCreate",
  "pluginInstallBoard",
  "pluginApproveSite",
  "pluginDisable",
  "aiRegisterSite",
  "aiRegisterBoard",
  "aiApproveHigh",
  "aiStopAll",
  "aiStopBoard",
  "auditView",
  "inviteSpecialAdmin",
  "siteConfig",
  "webhookConfig",
  "infraSecrets",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

const A: PermissionCell = "always";
const B: PermissionCell = "scope:board";
const S: PermissionCell = "scope:self";
const C: PermissionCell = "conditional";
const N: PermissionCell = "never";

/**
 * §5.4 の転記。列順: owner / special_admin / board_admin / board_deputy / board_moderator / user / anon / ai_agent。
 * 注記:
 * - boardCreate の board 系「—」は N（board ロールは user ロールに加算されるため、人間は user 列で評価する）。
 * - post の anon は Turnstile+レート制限付きだが可否としては A（ガードは別層）。
 * - postModerate の moderator は「非表示のみ ◎（削除は △）」。セルは B とし、削除判定は別ロジックで C 相当に絞る。
 * - infraSecrets は owner 含め UI/API から到達不可（システム外 = Wrangler/Dash）。全員 N。
 */
export const PERMISSION_MATRIX: Readonly<Record<PermissionAction, Readonly<Record<Role, PermissionCell>>>> = {
  view:               { owner: A, special_admin: A, board_admin: A, board_deputy: A, board_moderator: A, user: A, anon: A, ai_agent: C },
  post:               { owner: A, special_admin: A, board_admin: A, board_deputy: A, board_moderator: A, user: A, anon: A, ai_agent: C },
  boardCreate:        { owner: A, special_admin: A, board_admin: N, board_deputy: N, board_moderator: N, user: A, anon: N, ai_agent: N },
  boardEdit:          { owner: A, special_admin: A, board_admin: B, board_deputy: C, board_moderator: N, user: N, anon: N, ai_agent: C },
  boardDelete:        { owner: A, special_admin: A, board_admin: C, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  staffManage:        { owner: A, special_admin: A, board_admin: B, board_deputy: C, board_moderator: N, user: N, anon: N, ai_agent: N },
  postModerate:       { owner: A, special_admin: A, board_admin: B, board_deputy: B, board_moderator: B, user: N, anon: N, ai_agent: C },
  banBoard:           { owner: A, special_admin: A, board_admin: B, board_deputy: C, board_moderator: C, user: N, anon: N, ai_agent: C },
  banSite:            { owner: A, special_admin: A, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  accountSuspend:     { owner: A, special_admin: A, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  reportHandle:       { owner: A, special_admin: A, board_admin: B, board_deputy: B, board_moderator: B, user: N, anon: N, ai_agent: C },
  pluginCreate:       { owner: A, special_admin: A, board_admin: A, board_deputy: A, board_moderator: A, user: A, anon: N, ai_agent: N },
  pluginInstallBoard: { owner: A, special_admin: A, board_admin: B, board_deputy: C, board_moderator: N, user: N, anon: N, ai_agent: C },
  pluginApproveSite:  { owner: A, special_admin: A, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: C },
  pluginDisable:      { owner: A, special_admin: A, board_admin: B, board_deputy: N, board_moderator: N, user: S, anon: N, ai_agent: C },
  aiRegisterSite:     { owner: A, special_admin: A, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  aiRegisterBoard:    { owner: A, special_admin: A, board_admin: B, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  aiApproveHigh:      { owner: A, special_admin: A, board_admin: B, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  aiStopAll:          { owner: A, special_admin: A, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: S },
  aiStopBoard:        { owner: A, special_admin: A, board_admin: B, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  auditView:          { owner: A, special_admin: A, board_admin: B, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: S },
  inviteSpecialAdmin: { owner: A, special_admin: N, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  siteConfig:         { owner: A, special_admin: C, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  webhookConfig:      { owner: A, special_admin: A, board_admin: B, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
  infraSecrets:       { owner: N, special_admin: N, board_admin: N, board_deputy: N, board_moderator: N, user: N, anon: N, ai_agent: N },
} as const;

export interface CanOptions {
  /** 自板・担当板スコープ内の操作か（`scope:board` セルの評価に使用） */
  boardScope?: boolean;
  /** 自分自身のリソースへの操作か（`scope:self` セルの評価に使用） */
  selfScope?: boolean;
}

/**
 * `role` が `action` を実行可能かを返す。
 * `conditional`（△）は `false` を返す。個別条件（冷却期間・設定許可等）は
 * 各サービスが別途判定したうえで成功させること（can() はあくまで静的な下限ゲート）。
 */
export function can(role: Role, action: PermissionAction, options: CanOptions = {}): boolean {
  const cell = PERMISSION_MATRIX[action][role];
  switch (cell) {
    case "always":
      return true;
    case "scope:board":
      return options.boardScope === true;
    case "scope:self":
      return options.selfScope === true;
    case "conditional":
    case "never":
      return false;
  }
}

/** グローバルロール・板レベル・特別ロールをまとめた評価用の合成（requireRole 内部用）。 */
export function rolesOf(params: {
  globalRole?: "owner" | "special_admin" | "user";
  boardLevel?: "admin" | "deputy" | "moderator" | null;
  isAiAgent?: boolean;
}): Role[] {
  if (params.isAiAgent) return ["ai_agent"];
  const roles: Role[] = [];
  if (params.globalRole === "owner") roles.push("owner");
  if (params.globalRole === "special_admin") roles.push("special_admin");
  if (params.globalRole) roles.push("user");
  if (params.boardLevel) {
    roles.push(
      params.boardLevel === "admin"
        ? "board_admin"
        : params.boardLevel === "deputy"
          ? "board_deputy"
          : "board_moderator",
    );
  }
  if (roles.length === 0) roles.push("anon");
  return roles;
}

/** 複数ロールの OR 評価（owner/special_admin は全ロールの上位として扱われる想定）。 */
export function canAny(roles: readonly Role[], action: PermissionAction, options: CanOptions = {}): boolean {
  return roles.some((role) => can(role, action, options));
}
