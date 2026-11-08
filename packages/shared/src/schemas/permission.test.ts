import { describe, expect, it } from "vitest";
import {
  can,
  canAny,
  PERMISSION_ACTIONS,
  PERMISSION_MATRIX,
  rolesOf,
  type Role,
} from "./permission";

const ROLES: Role[] = [
  "owner",
  "special_admin",
  "board_admin",
  "board_deputy",
  "board_moderator",
  "user",
  "anon",
  "ai_agent",
];

describe("PERMISSION_MATRIX: DESIGN §5.4 の全セルを検証", () => {
  it("全 action × 全 role（25×8=200 セル）が定義済み", () => {
    expect(PERMISSION_ACTIONS).toHaveLength(25);
    for (const action of PERMISSION_ACTIONS) {
      for (const role of ROLES) {
        expect(PERMISSION_MATRIX[action][role], `${action}/${role}`).toBeDefined();
      }
    }
  });

  // セル値ごとに can() の結果を検証（全セルカバー）
  for (const action of PERMISSION_ACTIONS) {
    for (const role of ROLES) {
      const cell = PERMISSION_MATRIX[action][role];
      it(`${action}/${role} = ${cell}`, () => {
        const plain = can(role, action);
        const board = can(role, action, { boardScope: true });
        const self = can(role, action, { selfScope: true });

        switch (cell) {
          case "always":
            expect(plain).toBe(true);
            expect(board).toBe(true);
            expect(self).toBe(true);
            break;
          case "scope:board":
            expect(plain).toBe(false);
            expect(board).toBe(true);
            break;
          case "scope:self":
            expect(plain).toBe(false);
            expect(self).toBe(true);
            break;
          case "conditional":
          case "never":
            expect(plain).toBe(false);
            expect(board).toBe(false);
            expect(self).toBe(false);
            break;
        }
      });
    }
  }
});

describe("can: 設計上重要な個別ケース", () => {
  it("owner は特別管理人招待のみ等、全操作が可能", () => {
    for (const action of PERMISSION_ACTIONS) {
      if (action === "infraSecrets") continue;
      expect(can("owner", action, { boardScope: true })).toBe(true);
    }
  });

  it("owner を含めインフラ秘密情報は API 越しに不可", () => {
    expect(can("owner", "infraSecrets", { boardScope: true, selfScope: true })).toBe(false);
  });

  it("board_moderator は全サイトアク禁不可", () => {
    expect(can("board_moderator", "banSite", { boardScope: true })).toBe(false);
  });

  it("anon は板作成・プラグイン作成不可", () => {
    expect(can("anon", "boardCreate")).toBe(false);
    expect(can("anon", "pluginCreate")).toBe(false);
  });

  it("AI は owner 招待キー発行・high 承認が不可", () => {
    expect(can("ai_agent", "inviteSpecialAdmin")).toBe(false);
    expect(can("ai_agent", "aiApproveHigh")).toBe(false);
  });

  it("条件付き（△）は can() 単体では不可", () => {
    expect(can("special_admin", "siteConfig")).toBe(false);
    expect(can("board_deputy", "boardEdit", { boardScope: true })).toBe(false);
  });
});

describe("rolesOf / canAny", () => {
  it("anonymous", () => {
    expect(rolesOf({})).toEqual(["anon"]);
    expect(canAny(rolesOf({}), "view")).toBe(true);
    expect(canAny(rolesOf({}), "boardCreate")).toBe(false);
  });

  it("user + board_admin の合成で boardCreate と boardEdit が可", () => {
    const roles = rolesOf({ globalRole: "user", boardLevel: "admin" });
    expect(roles).toEqual(["user", "board_admin"]);
    expect(canAny(roles, "boardCreate")).toBe(true);
    expect(canAny(roles, "boardEdit", { boardScope: true })).toBe(true);
  });

  it("owner は user ロールを兼ねない（owner 単独で全許可）", () => {
    expect(rolesOf({ globalRole: "owner" })).toEqual(["owner", "user"]);
  });

  it("ai_agent は他ロールを持たない", () => {
    expect(rolesOf({ globalRole: "user", isAiAgent: true })).toEqual(["ai_agent"]);
  });
});
