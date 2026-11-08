import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, matchNg, matchNgThread, type NgConfig } from "./settings";
import type { Post } from "./types";

const basePost: Post = {
  id: 1,
  num: 2,
  name: "名無しさん",
  body: "こんにちは",
  createdAt: 1_800_000_000,
  idHash: "AbCd",
};

function ng(partial: Partial<NgConfig>): NgConfig {
  return { ...DEFAULT_SETTINGS.ng, ...partial };
}

describe("matchNg", () => {
  it("ワードは部分一致・大小無視", () => {
    expect(matchNg({ ...basePost, body: "これはSPAMです" }, ng({ words: ["spam"] })).hit).toBe(true);
    expect(matchNg(basePost, ng({ words: ["spam"] })).hit).toBe(false);
  });

  it("ID は完全一致", () => {
    expect(matchNg(basePost, ng({ ids: ["AbCd"] })).hit).toBe(true);
    expect(matchNg(basePost, ng({ ids: ["AbC"] })).hit).toBe(false);
  });

  it("名前は部分一致、トリップは完全一致", () => {
    expect(matchNg({ ...basePost, name: "荒らし太郎" }, ng({ names: ["荒らし"] })).hit).toBe(true);
    expect(matchNg({ ...basePost, trip: "◆1xBvFkA3bc" }, ng({ trips: ["◆1xBvFkA3bc"] })).hit).toBe(true);
    expect(matchNg({ ...basePost, trip: "◆1xBvFkA3bc" }, ng({ trips: ["◆1xBv"] })).hit).toBe(false);
  });

  it("スレ主（>>1）は NG 対象外", () => {
    expect(matchNg({ ...basePost, isOp: true, body: "spam" }, ng({ words: ["spam"] })).hit).toBe(false);
  });

  it("特殊 NG: :url / :image / :ai", () => {
    expect(matchNg({ ...basePost, body: "https://example.com" }, ng({ words: [":url"] })).hit).toBe(true);
    expect(matchNg(basePost, ng({ words: [":url"] })).hit).toBe(false);
    expect(
      matchNg({ ...basePost, attachments: [{ url: "https://example.com/a.png" }] }, ng({ words: [":image"] })).hit,
    ).toBe(true);
    expect(matchNg({ ...basePost, aiAgent: { name: "bot" } }, ng({ words: [":ai"] })).hit).toBe(true);
  });

  it("一致理由を返す", () => {
    expect(matchNg({ ...basePost, body: "spam" }, ng({ words: ["spam"] })).reason).toBe("spam");
  });
});

describe("matchNgThread", () => {
  it("スレタイの部分一致", () => {
    expect(matchNgThread("【宣伝】稼げる副業", ng({ threads: ["宣伝"] }))).toBe("宣伝");
    expect(matchNgThread("普通のスレ", ng({ threads: ["宣伝"] }))).toBeNull();
  });
});