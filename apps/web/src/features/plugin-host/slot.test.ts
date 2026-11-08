// スロット名の解決（WP3 → WP2 のホスト側スロット）のユニットテスト。

import { describe, expect, it } from "vitest";
import { resolveDeclaredSlot } from "./slots";

describe("resolveDeclaredSlot", () => {
  it("宣言名がホスト名と一致すればそのまま使う", () => {
    expect(resolveDeclaredSlot(["thread-top"], "thread-top")).toBe("thread-top");
    expect(resolveDeclaredSlot(["post-actions"], "post-actions")).toBe("post-actions");
  });

  it("汎用名（サンプル/SDK）を WP2 のスロットに割り当てる", () => {
    expect(resolveDeclaredSlot(["thread-head"], "thread-top")).toBe("thread-head");
    expect(resolveDeclaredSlot(["thread-post-inline"], "post-actions")).toBe("thread-post-inline");
    expect(resolveDeclaredSlot(["thread-post-footer"], "post-actions")).toBe("thread-post-footer");
    expect(resolveDeclaredSlot(["post-form-after"], "post-form-extra")).toBe("post-form-after");
    expect(resolveDeclaredSlot(["board-head"], "board-top")).toBe("board-head");
    expect(resolveDeclaredSlot(["sidebar"], "board-sidebar")).toBe("sidebar");
  });

  it("宣言していないスロットには出さない", () => {
    expect(resolveDeclaredSlot([], "thread-top")).toBeNull();
    expect(resolveDeclaredSlot(["thread-head"], "thread-bottom")).toBeNull();
    expect(resolveDeclaredSlot(["board-manage"], "post-actions")).toBeNull();
  });

  it("複数宣言時はホスト名と一致する宣言を優先する", () => {
    expect(resolveDeclaredSlot(["thread-head", "thread-top"], "thread-top")).toBe("thread-top");
  });
});