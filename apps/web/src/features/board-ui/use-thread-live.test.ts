// useThreadLive のポーリング判定。
// await の前後で disposed/hidden を再評価し、スレ切替後の旧スレ結果を反映しないことを検証する。

import { describe, expect, it } from "vitest";
import { runPollOnce } from "./use-thread-live";
import type { Post } from "./types";

function post(id: number): Post {
  return { id, num: id, name: "名無しさん", body: `レス ${id}`, createdAt: 0 };
}

describe("runPollOnce", () => {
  it("取得中に dispose されたら結果を反映しない", async () => {
    const { promise, resolve } = Promise.withResolvers<{ items: Post[] }>();
    const state = { disposed: false, hidden: false };
    const applied: Post[] = [];

    const running = runPollOnce(
      () => state,
      () => promise,
      (items) => applied.push(...items),
    );
    // スレを切り替えた（effect の cleanup が disposed=true にする）
    state.disposed = true;
    resolve({ items: [post(2)] });
    await running;

    expect(applied).toEqual([]);
  });

  it("取得中に背景タブへ移動したら結果を反映しない", async () => {
    const { promise, resolve } = Promise.withResolvers<{ items: Post[] }>();
    const state = { disposed: false, hidden: false };
    const applied: Post[] = [];

    const running = runPollOnce(
      () => state,
      () => promise,
      (items) => applied.push(...items),
    );
    state.hidden = true;
    resolve({ items: [post(3)] });
    await running;

    expect(applied).toEqual([]);
  });

  it("有効なままなら取得結果を反映する", async () => {
    const state = { disposed: false, hidden: false };
    const applied: Post[] = [];
    await runPollOnce(
      () => state,
      async () => ({ items: [post(4), post(5)] }),
      (items) => applied.push(...items),
    );
    expect(applied.map((item) => item.id)).toEqual([4, 5]);
  });

  it("開始時点で disposed/hidden なら取得自体を行わない", async () => {
    let fetched = 0;
    const fetchItems = async () => {
      fetched += 1;
      return { items: [post(6)] };
    };
    await runPollOnce(() => ({ disposed: true, hidden: false }), fetchItems, () => undefined);
    await runPollOnce(() => ({ disposed: false, hidden: true }), fetchItems, () => undefined);
    expect(fetched).toBe(0);
  });
});