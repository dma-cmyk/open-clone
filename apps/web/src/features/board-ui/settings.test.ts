import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  matchNg,
  matchNgThread,
  matchThreadNg,
  mergeSettings,
  migrateLegacySettings,
  ngEntryAddedAt,
  withIgnoredThread,
  withNgEntry,
  withoutIgnoredThread,
  withoutNgEntry,
  type NgConfig,
} from "./settings";
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
describe("migrateLegacySettings", () => {
  it("旧名 kome の端末設定を tsubuyaki へ移し、旧キーを残さない", () => {
    const migrated = migrateLegacySettings({
      behavior: { autoScroll: false, kome: true },
      kome: { size: 30, speed: 5, opacity: 0.5, color: "#ff0000" },
      ng: { words: [":kome", "spam"] },
    }) as {
      behavior: Record<string, unknown>;
      tsubuyaki: Record<string, unknown>;
      ng: { words: string[] };
    };
    expect(migrated.behavior).toEqual({ autoScroll: false, tsubuyaki: true });
    expect("kome" in migrated.behavior).toBe(false);
    expect(migrated.tsubuyaki).toEqual({ size: 30, speed: 5, opacity: 0.5, color: "#ff0000" });
    expect("kome" in migrated).toBe(false);
    expect(migrated.ng.words).toEqual([":tsubuyaki", "spam"]);
  });

  it("新しいキーが既にあれば優先し、:kome の重複を作らない", () => {
    const migrated = migrateLegacySettings({
      behavior: { kome: false, tsubuyaki: true },
      kome: { size: 30 },
      tsubuyaki: { size: 18 },
      ng: { words: [":tsubuyaki", ":kome"] },
    }) as {
      behavior: Record<string, unknown>;
      tsubuyaki: Record<string, unknown>;
      ng: { words: string[] };
    };
    expect(migrated.behavior.tsubuyaki).toBe(true);
    expect(migrated.tsubuyaki).toEqual({ size: 18 });
    expect(migrated.ng.words).toEqual([":tsubuyaki"]);
  });

  it("旧キーが無い保存値はそのまま返す（不要な書き戻しをしない）", () => {
    const stored = { display: { fontSize: 16 }, behavior: { autoScroll: true } };
    expect(migrateLegacySettings(stored)).toBe(stored);
  });

  it("既定値は新しい名前だけを持つ", () => {
    expect(DEFAULT_SETTINGS.behavior.tsubuyaki).toBe(false);
    expect(DEFAULT_SETTINGS.tsubuyaki.size).toBe(22);
    expect("kome" in DEFAULT_SETTINGS).toBe(false);
  });
});

describe("mergeSettings（保存済みデータの読み込み）", () => {
  it("ng.threads だけを持つ旧データでも壊れず、NG スレタイとして残す", () => {
    const merged = mergeSettings({ ng: { mode: "hide", threads: ["宣伝"] } }, DEFAULT_SETTINGS);
    expect(merged.ng.mode).toBe("hide");
    expect(merged.ng.threads).toEqual(["宣伝"]);
    expect(merged.ng.ignoredThreads).toEqual([]);
    expect(merged.ng.words).toEqual([]);
  });

  it("壊れた値・重複 ID を捨てて既定値へ寄せる", () => {
    const merged = mergeSettings(
      {
        ng: {
          mode: "unknown",
          words: ["a", 1, null],
          ignoredThreads: [
            { id: 12, board: "b", title: "t", at: 1 },
            { id: 12, board: "dup", title: "dup", at: 2 },
            { id: "x" },
            null,
          ],
          addedAt: { "words:a": 100, "words:b": "bad" },
        },
      },
      DEFAULT_SETTINGS,
    );
    expect(merged.ng.mode).toBe("confirm");
    expect(merged.ng.words).toEqual(["a"]);
    expect(merged.ng.ignoredThreads).toEqual([{ id: 12, board: "b", title: "t", at: 1 }]);
    expect(merged.ng.addedAt).toEqual({ "words:a": 100 });
  });
});

describe("NG 項目の追加日時", () => {
  it("追加で日時を記録し、解除で一緒に消す", () => {
    const added = withNgEntry(ng({}), "words", " spam ", 1_700_000_000_000);
    expect(added.words).toEqual(["spam"]);
    expect(ngEntryAddedAt(added, "words", "spam")).toBe(1_700_000_000_000);
    const removed = withoutNgEntry(added, "words", "spam");
    expect(removed.words).toEqual([]);
    expect(ngEntryAddedAt(removed, "words", "spam")).toBeNull();
  });

  it("日時の無い旧データは不明（null）として扱う", () => {
    expect(ngEntryAddedAt(ng({ words: ["old"] }), "words", "old")).toBeNull();
  });
});

describe("スレ ID の無視", () => {
  it("ID で追加したスレだけを隠し、似たタイトルの別スレは隠さない", () => {
    const settings = withIgnoredThread(ng({}), { id: 10, board: "news", title: "雑談スレ part1" }, 1);
    expect(matchThreadNg({ id: 10, title: "雑談スレ part1" }, settings)).toMatchObject({ hit: true, kind: "thread" });
    expect(matchThreadNg({ id: 11, title: "雑談スレ part1" }, settings).hit).toBe(false);
    expect(matchThreadNg({ id: 12, title: "雑談スレ part10" }, settings).hit).toBe(false);
  });

  it("同じ ID は二重に追加せず、解除で元に戻る", () => {
    const once = withIgnoredThread(ng({}), { id: 10, board: "news", title: "t" }, 1);
    const twice = withIgnoredThread(once, { id: 10, board: "news", title: "t" }, 2);
    expect(twice.ignoredThreads).toHaveLength(1);
    expect(twice.ignoredThreads[0]?.at).toBe(1);
    expect(withoutIgnoredThread(once, 10).ignoredThreads).toEqual([]);
  });

  it("旧 NG スレタイは従来どおり部分一致で判定する", () => {
    const verdict = matchThreadNg({ id: 10, title: "【宣伝】稼げる副業" }, ng({ threads: ["宣伝"] }));
    expect(verdict).toMatchObject({ hit: true, kind: "title", reason: "宣伝" });
  });
});

describe("matchNg の解除対象", () => {
  it("一致した項目（種類と保存値）を返す", () => {
    expect(matchNg({ ...basePost, idHash: "AbCd" }, ng({ ids: [" abcd "] })).entry).toEqual({
      kind: "ids",
      value: " abcd ",
    });
    expect(matchNg({ ...basePost, body: "spam" }, ng({ words: [" spam "] })).entry).toEqual({
      kind: "words",
      value: " spam ",
    });
  });
});
