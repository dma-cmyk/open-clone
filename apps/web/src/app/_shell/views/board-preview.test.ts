// B2（スレ一覧プレビューのレス重複）のための単体テスト。
// board-view.tsx の buildPreview が「先頭レス（OP 抜粋）＋最新3レス」の組み合わせで
// 同じレス番号を二重表示しないことを検証する（QA F-13 / museAI #4 の回帰）。

import { describe, expect, it } from "vitest";
import type { Post } from "@/features/board-ui/types";
import { buildPreview } from "./board-preview";
function post(num: number, overrides: Partial<Post> = {}): Post {
  return {
    id: num,
    threadId: 1,
    boardId: 1,
    num,
    name: "名無しさん",
    mail: "",
    body: `レス${num}`,
    createdAt: 1_760_000_000 + num,
    sage: false,
    idHash: "ID",
    anchorTargets: [],
    attachments: [],
    reactions: { likes: 0, dislikes: 0 },
    kind: "post",
    isOp: num === 1,
    ...overrides,
  } as Post;
}

describe("buildPreview: プレビューのレス重複除去（B2）", () => {
  it("少ないレスのスレでレス1が2回表示されない（QA F-13 の回帰）", () => {
    // 2 レスのスレ: OP(num=1) と レス2。旧実装では OP 表示に加えて最新レス側にも
    // num=1 が現れていた（l3 が [1,2] を返すため）。
    const opPage = { posts: [post(1)] };
    const latestPage = { posts: [post(1), post(2)] };

    const preview = buildPreview(opPage, latestPage);

    expect(preview.op?.num).toBe(1);
    expect(preview.latest.map((item) => item.num)).toEqual([2]);
    // 全体で各レス番号は 1 回だけ
    const all = [...(preview.op ? [preview.op] : []), ...preview.latest];
    const nums = all.map((item) => item.num);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("1 レスしか無いスレでは最新レス側が空になる", () => {
    const opPage = { posts: [post(1)] };
    const latestPage = { posts: [post(1)] };

    const preview = buildPreview(opPage, latestPage);

    expect(preview.op?.num).toBe(1);
    expect(preview.latest).toHaveLength(0);
  });

  it("多いレスのスレでは OP と最新3件が（重複なく）並ぶ", () => {
    // 7 レスのスレ（QA レポートの 7 レス例）
    const opPage = { posts: [post(1)] };
    const latestPage = { posts: [post(5), post(6), post(7)] };

    const preview = buildPreview(opPage, latestPage);

    expect(preview.op?.num).toBe(1);
    expect(preview.latest.map((item) => item.num)).toEqual([5, 6, 7]);
  });

  it("つぶやき（tsubuyaki）レスは最新側から除く（既存挙動の維持）", () => {
    const opPage = { posts: [post(1)] };
    const latestPage = { posts: [post(2, { kind: "tsubuyaki" } as Partial<Post>), post(3)] };

    const preview = buildPreview(opPage, latestPage);

    expect(preview.latest.map((item) => item.num)).toEqual([3]);
  });
});
