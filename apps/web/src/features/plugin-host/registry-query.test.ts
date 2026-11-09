import { describe, expect, it } from "vitest";
import { createLatestOnly, initialRegistryTab } from "./registry-query";

// 報告書40 §10 の回帰テスト。
// `/plugins/?tab=mine` を直接開いたとき、
//  1) 初期タブが URL から決まり「公開一覧」を先に取りに行かないこと
//  2) 先に投げた取得（公開一覧）の応答が後から届いても mine の結果を上書きしないこと
// を固定する。

describe("initialRegistryTab", () => {
  it("?tab=mine / ?tab=installed を初期タブとして返す", () => {
    expect(initialRegistryTab("?tab=mine")).toBe("mine");
    expect(initialRegistryTab("?tab=installed")).toBe("installed");
  });

  it("未指定・未知の値・空文字は公開一覧", () => {
    expect(initialRegistryTab("")).toBe("public");
    expect(initialRegistryTab("?")).toBe("public");
    expect(initialRegistryTab("?tab=public")).toBe("public");
    expect(initialRegistryTab("?tab=other")).toBe("public");
    expect(initialRegistryTab("?q=%E8%8D%89&tab=mine")).toBe("mine");
  });
});

describe("createLatestOnly", () => {
  it("最後に開始した取得だけが最新になる", () => {
    const latest = createLatestOnly();
    const first = latest.begin();
    expect(latest.isCurrent(first)).toBe(true);
    const second = latest.begin();
    expect(latest.isCurrent(first)).toBe(false);
    expect(latest.isCurrent(second)).toBe(true);
  });

  it("遅れて届いた古い取得の結果は適用されない（公開一覧が mine を上書きしない）", async () => {
    const latest = createLatestOnly();
    const applied: string[] = [];
    const gates: Array<() => void> = [];

    // ページの load() と同じ骨格: 結果を適用する直前に世代を確認する。
    const startLoad = (items: string[]) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const token = latest.begin();
      gates.push(() => {
        if (latest.isCurrent(token)) applied.push(...items);
        resolve();
      });
      return promise;
    };

    // 1 回目（公開一覧）→ 2 回目（自分のプラグイン）の順に開始する。
    const publicLoad = startLoad([]);
    const mineLoad = startLoad(["kusa-midori"]);

    const [resolvePublic, resolveMine] = gates;
    if (!resolvePublic || !resolveMine) throw new Error("resolver が登録されていない");

    // mine が先に届き、そのあとに公開一覧が届く（実測した並び）。
    resolveMine();
    resolvePublic();
    await Promise.all([publicLoad, mineLoad]);

    expect(applied).toEqual(["kusa-midori"]);
  });
});